/** Authored UNRUN. Actual per-row transactions retain independent failure and original-file binding. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as tenantDb from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {commitSectionImport} from '../core/import-sections';
import {lockLeaveDependenciesTx} from '../core/leave-dependency-lock';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const group=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const hire=(code:string)=>hireEmployee(group(),{person:{fullName:'Fictional Section '+code,primaryEmail:randomUUID()+'@fixture.test'},employeeCode:code,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
async function state(){return{people:await owner.db.select().from(schema.person).where(eq(schema.person.tenantId,b.tenantId)).orderBy(schema.person.id),ledger:await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.tenantId,b.tenantId)).orderBy(schema.leaveLedger.id),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,b.tenantId)).orderBy(schema.domainEvent.id)};}
async function held(id:string){let ready!:()=>void,failed!:(e:unknown)=>void,release!:()=>void;const started=new Promise<void>((yes,no)=>{ready=yes;failed=no;}),done=new Promise<void>(yes=>{release=yes;});const timer=setTimeout(()=>{failed(Error('owned section interval timed out'));release();},10000);const pending=withTenant(group(),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[id]);ready();await done;});void pending.catch(failed);await started;return{async close(){release();clearTimeout(timer);await pending;}};}
const input=()=>({section:'profile',records:[{employee_code:'SECA',city:'Fictional City A'},{employee_code:'SECB',city:'Fictional City B'}],fileName:'fictional-sections.csv'});
describe('section import actual row source intervals',()=>{
 it('refuses all held rows without person/ledger/event changes, then commits and skips a true reupload',async()=>{
  const a=await hire('SECA');await hire('SECB');const before=await state(),holder=await held(a.employmentId);try{const result=await commitSectionImport(group(),input());expect(result.updated).toBe(0);expect(result.failed.map(row=>row.rowNum)).toEqual([1,2]);expect(await state()).toEqual(before);}finally{await holder.close();}
  const result=await commitSectionImport(group(),input());expect(result.updated).toBe(2);expect(result.failed).toEqual([]);const after=await state();expect(after.people.filter(row=>row.permanentCity?.startsWith('Fictional City'))).toHaveLength(2);const repeat=await commitSectionImport(group(),input());expect(repeat.updated).toBe(0);expect(repeat.skipped).toBe(2);expect(await state()).toEqual(after);
 });
 it('rolls back the first refused row, releases only its owned holder, and allows the independent second row',async()=>{
  const a=await hire('SECA'),b2=await hire('SECB'),holder=await held(a.employmentId),before=await state(),actual=tenantDb.withTenant;let rowTransactions=0,afterFirst:Awaited<ReturnType<typeof state>>|undefined;
  const boundary=vi.spyOn(tenantDb,'withTenant').mockImplementation(async(ctx,fn)=>{if(fn.toString().includes('Section import inputs changed')){rowTransactions++;if(rowTransactions===1){try{return await actual(ctx,fn);}finally{afterFirst=await state();await holder.close();}}}return actual(ctx,fn);});
  try{const result=await commitSectionImport(group(),input());expect(rowTransactions).toBe(2);expect(afterFirst).toEqual(before);expect(result.updated).toBe(1);expect(result.failed.map(row=>row.rowNum)).toEqual([1]);const after=await state();expect(after.people.find(row=>row.id===a.personId)?.permanentCity).toBeNull();expect(after.people.find(row=>row.id===b2.personId)?.permanentCity).toBe('Fictional City B');}
  finally{boundary.mockRestore();await holder.close();}
  const retry=await commitSectionImport(group(),{section:'profile',records:[input().records[0]]});expect(retry.updated).toBe(1);
 });
 it('freshly resolves the original Employee ID and refuses changed person binding instead of retargeting',async()=>{
  const a=await hire('SECA'),other=await hire('OTHER'),before=await state(),actual=tenantDb.withTenant;let changed=false;
  const boundary=vi.spyOn(tenantDb,'withTenant').mockImplementation(async(ctx,fn)=>{if(!changed&&fn.toString().includes('Section import inputs changed')){changed=true;await owner.db.update(schema.employment).set({employeeCode:'MOVED'}).where(eq(schema.employment.id,a.employmentId));await owner.db.update(schema.employment).set({employeeCode:'SECA'}).where(eq(schema.employment.id,other.employmentId));}return actual(ctx,fn);});
  try{const result=await commitSectionImport(group(),{section:'profile',records:[input().records[0]]});expect(changed).toBe(true);expect(result.updated).toBe(0);expect(result.failed.map(row=>row.rowNum)).toEqual([1]);expect(await state()).toEqual(before);}finally{boundary.mockRestore();}
 });
 it('retains omitted cells from the actual locked source rather than an old preview snapshot',async()=>{
  const a=await hire('SECA'),actual=tenantDb.withTenant;let changed=false;const boundary=vi.spyOn(tenantDb,'withTenant').mockImplementation(async(ctx,fn)=>{if(!changed&&fn.toString().includes('Section import inputs changed')){changed=true;await owner.db.update(schema.person).set({phone:'Fictional concurrent contact'}).where(eq(schema.person.id,a.personId));}return actual(ctx,fn);});
  try{const result=await commitSectionImport(group(),{section:'profile',records:[input().records[0]]});expect(changed).toBe(true);expect(result.updated).toBe(1);}finally{boundary.mockRestore();}const [fresh]=await owner.db.select().from(schema.person).where(eq(schema.person.id,a.personId));expect(fresh).toMatchObject({phone:'Fictional concurrent contact',permanentCity:'Fictional City A'});
 });
 it('captures uploaded records/options and original caller before the first preview await',async()=>{
  const a=await hire('SECA'),ctx=group(),p={section:'profile',records:[input().records[0]],fileName:'fictional-original.csv'};let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),pause=new Promise<void>(yes=>{release=yes;});const actual=tenantDb.withTenant,boundary=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(async(c,fn)=>{entered();await pause;return actual(c,fn);});const pending=commitSectionImport(ctx,p);
  try{await ready;p.records[0].employee_code='MISSING';p.records[0].city='retargeted';p.section='bank_statutory';p.fileName='retargeted.csv';ctx.userId=randomUUID();ctx.grants![0].role='employee';release();const result=await pending;expect(result.updated).toBe(1);}finally{release();await pending.catch(()=>{});boundary.mockRestore();}const [fresh]=await owner.db.select().from(schema.person).where(eq(schema.person.id,a.personId));expect(fresh.permanentCity).toBe('Fictional City A');
 });
});
