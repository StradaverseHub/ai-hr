/** Authored UNRUN. Actual source writers/erasure admission; no mocked SQL ownership. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as tenantDb from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,updatePerson,updatePersonProfilePartial} from '../core/org';
import {setPersonComplianceFields,decideProfileChange,requestProfileChange} from '../core/profile';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {saveProfileEditPolicy} from '../core/profile-edit-policy';
import * as workforce from '../core/workforce-commands';
import {erasePersonPii} from '../core/pdpa';
import {lockLeaveDependenciesTx} from '../core/leave-dependency-lock';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const group=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
async function subject(){const a=await hireEmployee(group(),{person:{fullName:'Fictional Person Dependency',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});await owner.db.update(schema.person).set({phone:'Fictional contact',personalEmail:'fictional.personal@fixture.test',gender:'female',dateOfBirth:'1990-05-05'}).where(eq(schema.person.id,a.personId));return a;}
async function state(){const result:Record<string,unknown>={};for(const table of ['person','employment','person_emergency_contact','employee_statutory_my','employee_dependent','profile_change_request','leave_ledger','domain_event']){const [row]=await owner.client.unsafe<{rows:unknown}[]>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${table} t where tenant_id=$1`,[b.tenantId]);result[table]=row.rows;}return result;}
async function held(id:string){let ready!:()=>void,failed!:(e:unknown)=>void,release!:()=>void;const started=new Promise<void>((yes,no)=>{ready=yes;failed=no;}),finish=new Promise<void>(yes=>{release=yes;});const timer=setTimeout(()=>{failed(Error('owned person interval timed out'));release();},10000);const pending=withTenant(group(),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[id]);ready();await finish;});void pending.catch(failed);await started;return{async close(){release();clearTimeout(timer);await pending;}};}
const erasure=(id:string)=>({subjectEmploymentId:id,scope:'contact' as const,reason:'Fictional retention cleanup',requestRef:'FICTIONAL-PERSON-DEPENDENCY'});
describe('person source writers own configuration before physical profile/privacy facts',()=>{
 it.each(['profile','partial','compliance','caller-tx','workforce','erasure'] as const)('%s refuses the actual participating interval with no effects, then succeeds after release',async kind=>{
  const a=await subject(),ctx=group();const invoke=()=>kind==='profile'?updatePerson(ctx,{personId:a.personId,fullName:'Fictional Renamed',primaryEmail:'fictional.changed@fixture.test',phone:'Fictional new contact'}):kind==='partial'?updatePersonProfilePartial(ctx,{personId:a.personId,fullName:'Fictional Renamed'}):kind==='compliance'?setPersonComplianceFields(ctx,{employmentId:a.employmentId,gender:'male'}):kind==='caller-tx'?withTenant(ctx,tx=>setPersonComplianceFields(ctx,{employmentId:a.employmentId,gender:'male'},tx)):kind==='workforce'?workforce.setPersonComplianceFields(ctx,{employmentId:a.employmentId,gender:'male'}):erasePersonPii(ctx,erasure(a.employmentId));
  const before=await state(),holder=await held(a.employmentId);try{await expect(invoke()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}finally{await holder.close();}
  await invoke();const [fresh]=await owner.db.select().from(schema.person).where(eq(schema.person.id,a.personId));if(kind==='erasure')expect(fresh).toMatchObject({phone:null,personalEmail:null,dateOfBirth:'1990-05-05'});else if(['compliance','caller-tx','workforce'].includes(kind))expect(fresh.gender).toBe('male');else expect(fresh.fullName).toBe('Fictional Renamed');
  const after=await state(),old=new Set((before.domain_event as {id:string}[]).map(row=>row.id));const added=(after.domain_event as {id:string;event_type:string}[]).filter(row=>!old.has(row.id));expect(added).toHaveLength(1);expect(added[0].event_type).toBe(kind==='erasure'?'pii.erased':'person.updated');
 });
 it('captures erasure subject/scope/reason/context before asynchronous database admission',async()=>{
  const a=await subject(),ctx=group(),input:{subjectEmploymentId:string;scope:'contact'|'all';reason:string;requestRef:string}=erasure(a.employmentId);let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),pause=new Promise<void>(yes=>{release=yes;});const actual=tenantDb.withTenant,boundary=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(async(c,fn)=>{entered();await pause;return actual(c,fn);});const pending=erasePersonPii(ctx,input);
  try{await ready;input.subjectEmploymentId=randomUUID();input.scope='all';input.reason='retargeted';input.requestRef='RETARGETED';ctx.userId=randomUUID();ctx.grants![0].role='employee';release();const result=await pending;expect(result.erased).toContain('phone');}finally{release();await pending.catch(()=>{});boundary.mockRestore();}
  const [fresh]=await owner.db.select().from(schema.person).where(eq(schema.person.id,a.personId));expect(fresh).toMatchObject({phone:null,gender:'female',dateOfBirth:'1990-05-05'});const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'pii.erased'));expect(events).toHaveLength(1);expect(JSON.stringify(events)).not.toContain('retargeted');expect(JSON.stringify(events)).not.toContain('RETARGETED');
 });
 it('retains actual non-admin privacy refusal without any person/review/ledger/event effects',async()=>{
  const a=await subject(),userId=await createAppUser(b.tenantId,a.personId,'employee'),ctx:SessionContext={tenantId:b.tenantId,userId,personId:a.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};const before=await state();await expect(erasePersonPii(ctx,erasure(a.employmentId))).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('rolls back the admitted privacy effect and audit on an actual late database failure, then retries',async()=>{
  const a=await subject(),before=await state();await owner.client.unsafe("create function public.person_privacy_fault() returns trigger language plpgsql as $$begin if new.event_type='pii.erased' then raise exception 'owned privacy audit fault' using errcode='23514'; end if; return new; end$$");
  try{await owner.client.unsafe('create trigger person_privacy_fault before insert on domain_event for each row execute function public.person_privacy_fault()');await expect(erasePersonPii(group(),erasure(a.employmentId))).rejects.toThrow();expect(await state()).toEqual(before);}finally{await owner.client.unsafe('drop trigger if exists person_privacy_fault on domain_event');await owner.client.unsafe('drop function if exists public.person_privacy_fault()');}
  await erasePersonPii(group(),erasure(a.employmentId));const [fresh]=await owner.db.select().from(schema.person).where(eq(schema.person.id,a.personId));expect(fresh.phone).toBeNull();
 });
 it.each(['submit','request','decision'] as const)('%s owns the interval before proposal policy/master/request locks while retaining ordinary employee authority',async kind=>{
  const a=await subject(),userId=await createAppUser(b.tenantId,a.personId,'employee'),ctx:SessionContext={tenantId:b.tenantId,userId,personId:a.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};const preferred='profile.personal_details.preferredname';await saveProfileEditPolicy(group(),{keys:[preferred],withdrawnReason:'Fictional field policy'});const view=await readOwnProfileWorkspace(ctx,{employmentId:a.employmentId});const proposal={v:2 as const,fields:[{fieldId:preferred,before:view.baselines[preferred],value:'Fictional preferred'}],registers:[]};
  const prepared=kind==='decision'?await submitOwnProfileEdit(ctx,{employmentId:a.employmentId,proposal}):null;
  const invoke=()=>kind==='decision'?decideProfileChange(group(),{requestId:prepared!.requestId!,decision:'approved'}):kind==='request'?requestProfileChange(ctx,{employmentId:a.employmentId,proposed:proposal}):submitOwnProfileEdit(ctx,{employmentId:a.employmentId,proposal});
  const before=await state(),holder=await held(a.employmentId);try{await expect(invoke()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}finally{await holder.close();}
  const result=await invoke();if(kind!=='decision')expect(result).toMatchObject({requestId:expect.any(String)});const [fresh]=await owner.db.select().from(schema.person).where(eq(schema.person.id,a.personId));expect(fresh.preferredName).toBe(kind==='decision'?'Fictional preferred':null);
 });

});
