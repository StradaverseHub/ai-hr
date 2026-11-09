import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {roleAssignment} from '../db/schema';
import {hireEmployee,updatePersonProfilePartial} from '../core/org';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {listEmployeesPage,listWorkforcePersonnelPresentationPageTx} from '../core/read';
import {readPersonnelListExportDetails} from '../core/personnel-list-export-details';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

function barrier(){
 let release!:()=>void;
 const promise=new Promise<void>(resolve=>{release=resolve;});
 return {promise,release};
}

async function bounded<T>(work:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(Error('Personnel export did not finish inside the held writer interval.')),5000);
 });
 try{return await Promise.race([work,timeout]);}finally{clearTimeout(timer);}
}

it('reads the same scoped Workforce rows and real export details behind an exclusive Access writer',async()=>{
 await resetDb();
 const base=await seedBase();
 const ctx:SessionContext={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional export employee',primaryEmail:'export-borrowed@example.test'},
  companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await updatePersonProfilePartial(ctx,{personId:hired.personId,personalEmail:'export-detail@example.test'});
 const today=todayInKualaLumpur(),input={companyIds:[base.companyId],offset:0,limit:25};
 const entered=barrier(),release=barrier();
 const writer=withTenant(ctx,async tx=>{
  await lockAccessConfigurationTx(tx,base.tenantId);
  entered.release();
  await release.promise;
 });
 const read=()=>withTenant(ctx,async tx=>{
  const [mode]=await tx.execute<{isolated:boolean}>(sql`select current_setting('transaction_isolation')='repeatable read'
   and current_setting('transaction_read_only')='on' as isolated`);
  expect(mode?.isolated).toBe(true);
  const matching=await listWorkforcePersonnelPresentationPageTx(ctx,input,today,tx);
  const details=await readPersonnelListExportDetails(ctx,matching.rows,today,tx);
  return {ids:matching.rows.map(row=>row.employmentId),total:matching.total,details};
 },{readOnlySnapshot:true});
 let exportRead:ReturnType<typeof read>|undefined;
 try{
  await bounded(Promise.race([entered.promise,writer]));
  exportRead=read();
  const result=await bounded(exportRead);
  expect(result).toMatchObject({ids:[hired.employmentId],total:1});
  expect(JSON.stringify(result.details.cells.get(hired.employmentId))).toContain('export-detail@example.test');
  const [probe]=await owner.client`select pg_try_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+base.tenantId},0)) as available`;
  expect(probe.available).toBe(false);
 }finally{
  release.release();
  await Promise.allSettled([writer,...(exportRead?[exportRead]:[])]);
 }
});

it('refuses a command, foreign carrier and stale claims while preserving the existing borrowed command reader',async()=>{
 await resetDb();
 const base=await seedBase(),foreign=await seedBase(),ctx=adminCtx(base);
 const input={companyIds:[base.companyId],offset:0,limit:25},today=todayInKualaLumpur();
 await expect(withTenant(ctx,tx=>listWorkforcePersonnelPresentationPageTx(ctx,input,today,tx))).rejects.toThrow(/authority/);
 await expect(withTenant(adminCtx(foreign),tx=>listWorkforcePersonnelPresentationPageTx(ctx,input,today,tx),
  {readOnlySnapshot:true})).rejects.toThrow(/authority/);
 await withTenant(ctx,async tx=>{
  expect(await listEmployeesPage(ctx,input,'workforce',tx)).toEqual({rows:[],total:0});
  const [probe]=await owner.client`select pg_try_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+base.tenantId},0)) as available`;
  expect(probe.available).toBe(false);
 });
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,base.adminUserId));
 await expect(withTenant(ctx,tx=>listWorkforcePersonnelPresentationPageTx(ctx,input,today,tx),
  {readOnlySnapshot:true})).rejects.toThrow(/authority/);
});
