import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {hireEmployee} from '../core/org';
import {saveMyTp3Draft,submitMyTp3,myTp3History,saveTp3,deriveAccumulatorSeed,type MyTp3WriteInput} from '../packs/payroll/service';
import {requirePackFor} from '../localization/registry';
import * as schema from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
let base:Base;
let statutoryIdentity=0;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
async function employee(withProfile=true) {
 const today=todayInKualaLumpur(),hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional own TP3 employee',primaryEmail:`${randomUUID()}@example.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:today});
 const userId=await createAppUser(base.tenantId,hired.personId,'employee'),ctx:SessionContext={...adminCtx(base),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}]};
 if(withProfile)await requirePackFor('MY').statutory.set(adminCtx(base),{personId:hired.personId,icNumber:`90010110${String(++statutoryIdentity).padStart(4,'0')}`,taxCategory:3,numChildren:2});
 const input:MyTp3WriteInput={employmentId:hired.employmentId,assessmentYear:Number(today.slice(0,4)),expectedRevision:0,deductionMonth:null,sectionC:{c1:{amount:10000},c3:{amount:1000},c5:{amount:500}},sectionD:{},previousEmployers:[{name:'Fictional former employer',tin:'F000001'}],declarationAccepted:false};
 return{...hired,ctx,input};
}
const stat=async(personId:string)=>(await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,personId)))[0];
const records=async(personId:string)=>owner.db.select().from(schema.employeeTp3).where(eq(schema.employeeTp3.personId,personId)).orderBy(schema.employeeTp3.assessmentYear,schema.employeeTp3.id);
async function pgRefusal(operation:()=>Promise<unknown>,code:string,message?:string) {
 let failure:unknown;
 try{await operation();}catch(error){failure=error;}
 expect(failure,'the raw application-role operation must fail').toBeDefined();
 expect(pgSqlState(failure)).toBe(code);
 if(message)expect(pgErrorChain(failure).map(error=>error.message).join('\n')).toContain(message);
}
describe('own TP3 private draft and atomic publication',()=>{
 it('keeps draft input private and outside both the canonical master and Payroll projection',async()=>{const e=await employee(),before=await stat(e.personId);const saved=await saveMyTp3Draft(e.ctx,e.input);expect(saved.revision).toBe(1);expect(await records(e.personId)).toEqual([]);expect(await stat(e.personId)).toEqual(before);const history=await myTp3History(e.ctx);expect(history.records).toEqual([]);expect(history.drafts).toEqual([expect.objectContaining({id:saved.id,revision:1,deductionMonth:null,submittedAt:null,declarationAccepted:false})]);});
 it('requires an explicit declaration and the exact saved revision, then uses the shared financial projection',async()=>{
  const e=await employee(),before=await stat(e.personId);await saveMyTp3Draft(e.ctx,e.input);await expect(submitMyTp3(e.ctx,{...e.input,expectedRevision:1})).rejects.toThrow('declaration');await expect(submitMyTp3(e.ctx,{...e.input,declarationAccepted:true})).rejects.toThrow();
  const result=await submitMyTp3(e.ctx,{...e.input,expectedRevision:1,declarationAccepted:true});expect(result.revision).toBe(3);const [record]=await records(e.personId),seed=deriveAccumulatorSeed(record.payload)!,after=await stat(e.personId);
  expect(record.declaredAt).not.toBeNull();expect(record.deductionMonth).toBeNull();expect(record.remarks).toBeNull();expect(after).toMatchObject({tp3Year:e.input.assessmentYear,tp3NetRemuneration:seed.netRemuneration.toFixed(2),tp3EpfClaimed:seed.epfClaimed.toFixed(2),tp3PcbPaid:seed.pcbPaid.toFixed(2),tp3ZakatPaid:seed.zakatPaid.toFixed(2),tp3Lp:seed.lpDeclared.toFixed(2)});
  const unrelated=(row:typeof after)=>{const {updatedAt,tp3Year,tp3NetRemuneration,tp3EpfClaimed,tp3PcbPaid,tp3ZakatPaid,tp3Lp,tp3ExemptionUsed,...rest}=row;return rest;};expect(unrelated(after)).toEqual(unrelated(before));
  await expect(submitMyTp3(e.ctx,{...e.input,expectedRevision:3,declarationAccepted:true})).rejects.toThrow();expect(await records(e.personId)).toHaveLength(1);expect((await myTp3History(e.ctx)).drafts[0]).toMatchObject({projectionOutcome:{applied:true},revision:3});
 });
 it('serializes duplicate submit clicks into one form and one projection',async()=>{const e=await employee();const outcomes=await Promise.allSettled([submitMyTp3(e.ctx,{...e.input,declarationAccepted:true}),submitMyTp3(e.ctx,{...e.input,declarationAccepted:true})]);expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await records(e.personId)).toHaveLength(1);const history=await myTp3History(e.ctx);expect(history.drafts).toHaveLength(1);expect(history.drafts[0].submittedAt).not.toBeNull();});
 it('never overwrites an existing HR-maintained master, and strips both forms of HR notes from Mine',async()=>{const e=await employee();await saveTp3(adminCtx(base),{...e.input,personId:e.personId,declarationAccepted:true,remarks:'Private Payroll investigation note'});const before=await records(e.personId);await expect(saveMyTp3Draft(e.ctx,e.input)).rejects.toThrow();await expect(submitMyTp3(e.ctx,{...e.input,declarationAccepted:true})).rejects.toThrow();expect(await records(e.personId)).toEqual(before);const history=await myTp3History(e.ctx);expect(history.records).toHaveLength(1);expect(history.records[0].remarks).toBeNull();expect(history.records[0].payload).not.toHaveProperty('remarks');expect(JSON.stringify(history)).not.toContain('Private Payroll investigation note');});
 it('refuses foreign employment, a substituted Person and stale eligibility after the draft was saved',async()=>{const e=await employee(),other=await employee();await expect(saveMyTp3Draft(e.ctx,{...e.input,employmentId:other.employmentId})).rejects.toThrow();await expect(saveMyTp3Draft({...e.ctx,personId:other.personId},{...other.input})).rejects.toThrow();expect(await myTp3History({...e.ctx,personId:other.personId})).toEqual({records:[],drafts:[]});await saveMyTp3Draft(e.ctx,e.input);await owner.db.update(schema.employment).set({joinDate:`${e.input.assessmentYear-1}-01-01`}).where(eq(schema.employment.id,e.employmentId));await expect(submitMyTp3(e.ctx,{...e.input,expectedRevision:1,declarationAccepted:true})).rejects.toThrow();expect(await records(e.personId)).toEqual([]);expect((await myTp3History(e.ctx)).drafts[0].revision).toBe(1);});
 it('does not create a statutory profile when missing, and does not demote columns held by a later year',async()=>{
  const missing=await employee(false);await expect(submitMyTp3(missing.ctx,{...missing.input,declarationAccepted:true})).rejects.toThrow('no Malaysian statutory profile');expect(await records(missing.personId)).toEqual([]);expect(await stat(missing.personId)).toBeUndefined();await submitMyTp3(missing.ctx,{...missing.input,sectionC:{},sectionD:{},declarationAccepted:true});expect(await stat(missing.personId)).toBeUndefined();expect((await myTp3History(missing.ctx)).drafts[0].projectionOutcome).toMatchObject({applied:false,reason:'noStatutoryProfile'});
  const held=await employee();await requirePackFor('MY').statutory.setTp3(adminCtx(base),{personId:held.personId,tp3Year:held.input.assessmentYear+1,tp3NetRemuneration:111,tp3EpfClaimed:22,tp3PcbPaid:3});const before=await stat(held.personId);await submitMyTp3(held.ctx,{...held.input,declarationAccepted:true});expect(await stat(held.personId)).toEqual(before);expect((await myTp3History(held.ctx)).drafts[0].projectionOutcome).toMatchObject({applied:false,reason:'laterYearHoldsColumns',heldBy:held.input.assessmentYear+1});
 });
 it('rolls back a canonical publication when the shared Payroll projection fails',async()=>{const e=await employee();await saveMyTp3Draft(e.ctx,e.input);const before=await stat(e.personId);await owner.client`CREATE FUNCTION public.board2_refuse_tp3_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tp3_year IS DISTINCT FROM OLD.tp3_year THEN RAISE EXCEPTION 'Fictional projection rollback'; END IF; RETURN NEW; END $$`;await owner.client`CREATE TRIGGER board2_refuse_tp3_projection BEFORE UPDATE ON employee_statutory_my FOR EACH ROW EXECUTE FUNCTION public.board2_refuse_tp3_projection()`;try{await expect(submitMyTp3(e.ctx,{...e.input,expectedRevision:1,declarationAccepted:true})).rejects.toThrow();expect(await records(e.personId)).toEqual([]);expect(await stat(e.personId)).toEqual(before);expect((await myTp3History(e.ctx)).drafts[0]).toMatchObject({revision:1,submittedAt:null});}finally{await owner.client`DROP TRIGGER board2_refuse_tp3_projection ON employee_statutory_my`;await owner.client`DROP FUNCTION public.board2_refuse_tp3_projection()`;}});
 it('denies direct draft mutation at the database privilege boundary, even for the actual owner',async()=>{
  const e=await employee(),saved=await saveMyTp3Draft(e.ctx,e.input),before=await myTp3History(e.ctx);
  for(const statement of [sql`update public.employee_tp3_draft set revision=revision+1 where id=${saved.id}::uuid`,sql`delete from public.employee_tp3_draft where id=${saved.id}::uuid`,sql`insert into public.employee_tp3_draft select * from public.employee_tp3_draft where id=${saved.id}::uuid`]){
   await pgRefusal(()=>withTenant(e.ctx,tx=>tx.execute(statement)),'42501');
  }
  expect(await myTp3History(e.ctx)).toEqual(before);
 });
 it('refuses to commit a raw canonical insertion without its transaction-bound projection',async()=>{
  const e=await employee(),saved=await saveMyTp3Draft(e.ctx,{...e.input,declarationAccepted:true}),before=await stat(e.personId),draft=(await myTp3History(e.ctx)).drafts[0];
  await pgRefusal(()=>withTenant(e.ctx,tx=>tx.execute(sql`select app.my_tp3_insert(${saved.id}::uuid,${draft.revision},${draft.deductionMonth}::smallint,${JSON.stringify(draft.previousEmployers)}::jsonb,${JSON.stringify(draft.payload)}::jsonb)`)),'P0001','TP3 form and projection must commit together');
  expect(await records(e.personId)).toEqual([]);expect(await stat(e.personId)).toEqual(before);
  expect((await myTp3History(e.ctx)).drafts[0]).toMatchObject({id:saved.id,revision:1,submittedAt:null,canonicalId:null});
 });
 it('refuses raw foreign-employment writes and projection calls without an active submission',async()=>{
  const e=await employee(),foreign=await employee(),saved=await saveMyTp3Draft(e.ctx,e.input),draft=(await myTp3History(e.ctx)).drafts[0],before=await stat(e.personId);
  await pgRefusal(()=>withTenant(e.ctx,tx=>tx.execute(sql`select app.my_tp3_save_draft(${foreign.employmentId}::uuid,${e.input.assessmentYear},0,null::smallint,${JSON.stringify(draft.previousEmployers)}::jsonb,${JSON.stringify(draft.payload)}::jsonb,false)`)),'P0001','TP3 own employment required');
  await pgRefusal(()=>withTenant(e.ctx,tx=>tx.execute(sql`select app.my_tp3_projection(${saved.id}::uuid,null::jsonb)`)),'P0001','TP3 active submission required');
  expect(await records(e.personId)).toEqual([]);expect(await records(foreign.personId)).toEqual([]);expect(await stat(e.personId)).toEqual(before);
  expect((await myTp3History(e.ctx)).drafts[0]).toMatchObject({revision:1,submittedAt:null});
 });
});
