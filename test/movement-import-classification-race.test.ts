import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as tenantClient from '../db/client';
import * as movementOwner from '../core/movement';
import * as admission from '../core/movement-import-admission';
import {hireEmployee} from '../core/org';
import {setEmploymentTestRecord,employmentTestRecord} from '../core/employment-test-record';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(n:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
async function fixture(){const ctx=adminCtx(b);const hire=(code:string)=>hireEmployee(ctx,{person:{fullName:'Fictional '+code,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employeeCode:code,hiredOn:day(-90),employmentType:'full_time'});const sub=await hire('RACE-SUB'),manager=await hire('RACE-MANAGER');const csv=toCsv([['employee_code','event_type','effective_date','manager_employment_id'],['RACE-SUB','reportingLineChange',day(-1),'RACE-MANAGER']]),preview=await previewMovementImport(ctx,{companyId:b.companyId,csv});expect(preview.valid).toBe(1);const commit=()=>commitMovementImport(ctx,{companyId:b.companyId,csv,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.map(e=>[e.employeeCode,e.fingerprint!])),acknowledgeExcluded:false});return {ctx,sub,manager,commit};}
async function blocked(tag:string){const [row]=await owner.db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name=${tag} and l.locktype='advisory' and not l.granted) as blocked`);expect(row.blocked).toBe(true);}
function tagNextTransaction(tag:string){const original=tenantClient.withTenant;let next=true;return vi.spyOn(tenantClient,'withTenant').mockImplementation(async<T>(ctx:tenantClient.SessionContext,fn:(tx:tenantClient.Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>{const tagged=next;next=false;return original(ctx,async tx=>{if(tagged)await tx.execute(sql`select set_config('application_name',${tag},true)`);return fn(tx);},options);});}
describe('short tenant reference admission orders actual import and deliberate classification',()=>{
 it('makes classification wait through private replay, then permits later metadata without altering the accepted relationship',async()=>{
  const f=await fixture();let release!:()=>void;const released=new Promise<void>(done=>{release=done;});let paused=false,calls=0;const real=movementOwner.movementCurrentStateTx;
  const state=vi.spyOn(movementOwner,'movementCurrentStateTx').mockImplementation(async(...args)=>{const result=await real(...args);if(++calls===3){paused=true;await released;}return result;});
  const importing=f.commit();let classification:Promise<unknown>|undefined,tagger:ReturnType<typeof tagNextTransaction>|undefined;
  try{await vi.waitFor(()=>expect(paused).toBe(true),{timeout:5000,interval:10});const tag='b22-flag-'+randomUUID();tagger=tagNextTransaction(tag);classification=setEmploymentTestRecord(f.ctx,{employmentId:f.manager.employmentId,isTestRecord:true});await vi.waitFor(()=>blocked(tag),{timeout:5000,interval:10});release();expect((await importing).imported).toBe(1);await classification;expect(await employmentTestRecord(f.ctx,f.manager.employmentId)).toEqual({isTestRecord:true});expect((await movementOwner.movementCurrentState(f.ctx,f.sub.employmentId)).managerEmploymentId).toBe(f.manager.employmentId);}
  finally{release();await Promise.allSettled([importing,...(classification?[classification]:[])]);state.mockRestore();tagger?.mockRestore();}
 });
 it('makes confirm wait behind classification first, then refuses the changed new reference without a partial event',async()=>{
  const f=await fixture();let release!:()=>void;const released=new Promise<void>(done=>{release=done;});let paused=false,once=true;const real=admission.lockMovementImportReferenceAdmissionTx;
  const lock=vi.spyOn(admission,'lockMovementImportReferenceAdmissionTx').mockImplementation(async(...args)=>{await real(...args);if(once){once=false;paused=true;await released;}});
  const classification=setEmploymentTestRecord(f.ctx,{employmentId:f.manager.employmentId,isTestRecord:true});let importing:ReturnType<typeof f.commit>|undefined,tagger:ReturnType<typeof tagNextTransaction>|undefined;
  try{await vi.waitFor(()=>expect(paused).toBe(true),{timeout:5000,interval:10});const tag='b22-import-'+randomUUID();tagger=tagNextTransaction(tag);importing=f.commit();await vi.waitFor(()=>blocked(tag),{timeout:5000,interval:10});release();await classification;expect((await importing).imported).toBe(0);expect((await movementOwner.movementCurrentState(f.ctx,f.sub.employmentId)).managerEmploymentId).toBeNull();}
  finally{release();await Promise.allSettled([classification,...(importing?[importing]:[])]);lock.mockRestore();tagger?.mockRestore();}
 });
});
