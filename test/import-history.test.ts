/**
 * Shared import history + revert foundation (ADR-0152, migration 0675) and the Cost Center Allocation
 * import built on it (board item c4055300). Real database, real RLS, fictional fixtures.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createCostCenter} from '../core/admin';
import {getEmploymentCostAllocations,previewEmploymentCostAllocations,saveEmploymentCostAllocations} from '../core/employment-cost-allocations';
import {previewCostAllocationUpload,confirmCostAllocationUpload,costAllocationRevertHandler} from '../core/cost-allocation-import';
import {listImportAttempts,getImportAttempt,importAttemptSource,previewImportRevert,revertImport,importSourceHash,ImportHistoryError} from '../core/import-history';
import {previewImportRevertForAttempt,revertImportForAttempt} from '../core/import-history-handlers';
import {importAttemptStatus} from '../lib/import-history';
import {toCsv} from '../lib/csv';
import {ALLOCATION_COLUMNS} from '../lib/employment-cost-allocation';
import {LEGACY_ALLOCATION_LAYOUT_MESSAGE} from '../lib/cost-allocation-import';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const today=todayInKualaLumpur(),year=Number(today.slice(0,4)),hireDate=`${year-1}-01-01`,earlier=`${year-1}-06-01`;
const csv=(records:Record<string,string>[])=>Buffer.from(toCsv([[...ALLOCATION_COLUMNS],...records.map(r=>ALLOCATION_COLUMNS.map(k=>r[k]??''))]));
const row=(company_code:string,employee_code:string,cost_center_code:string,percentage:string,effective_date=today)=>({company_code,employee_code,effective_date,operation:'replace',cost_center_code,percentage});
describe('import history foundation and Cost Center Allocation import (c4055300)',()=>{
 let b:Base,a:SessionContext,betaId:string,acmeEmp:string,acmeEmp2:string,betaEmp:string,ccA:string,ccB:string,betaOnly:SessionContext,acmeOnly:SessionContext;
 const allocation=(employmentId:string,date=today)=>getEmploymentCostAllocations(a,employmentId,date);
 async function scopedAdmin(companyId:string,email:string):Promise<SessionContext>{
  const[p]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:`Scoped ${email}`,primaryEmail:email}).returning();const userId=await createAppUser(b.tenantId,p.id,'hr_admin');
  await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));
  return{...a,userId,personId:p.id,grants:[{role:'hr_admin',companyId}]};
 }
 async function upload(ctx:SessionContext,records:Record<string,string>[],name='allocations.csv'){return previewCostAllocationUpload(ctx,{name,content:csv(records)});}
 async function importFile(ctx:SessionContext,records:Record<string,string>[]){const u=await upload(ctx,records);return{...u,result:await confirmCostAllocationUpload(ctx,{attemptId:u.attemptId,previewHash:u.plan.previewHash})};}
 beforeAll(migrateTestDb);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();a=adminCtx(b);
  await owner.db.update(s.company).set({companyLabel:'ACME'}).where(eq(s.company.id,b.companyId));
  const[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Bhd',companyLabel:'BETA',registrationNo:'202001000002'}).returning();betaId=beta.id;
  const[betaDept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:betaId,name:'Beta Finance'}).returning();
  acmeEmp=(await hireEmployee(a,{person:{fullName:'Acme Allocation One',primaryEmail:'acme1@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:hireDate,employeeCode:'AC001'})).employmentId;
  acmeEmp2=(await hireEmployee(a,{person:{fullName:'Acme Allocation Two',primaryEmail:'acme2@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:hireDate,employeeCode:'AC002'})).employmentId;
  betaEmp=(await hireEmployee(a,{person:{fullName:'Beta Allocation One',primaryEmail:'beta1@example.test'},companyId:betaId,departmentId:betaDept.id,employmentType:'full_time',hiredOn:hireDate,employeeCode:'BE001'})).employmentId;
  ccA=(await createCostCenter(a,{companyId:b.companyId,code:'ACME-OPS',name:'Acme operations'})).id;ccB=(await createCostCenter(a,{companyId:b.companyId,code:'ACME-SALES',name:'Acme sales'})).id;
  await createCostCenter(a,{companyId:betaId,code:'BETA-OPS',name:'Beta operations'});
  betaOnly=await scopedAdmin(betaId,'beta-admin@example.test');acmeOnly=await scopedAdmin(b.companyId,'acme-admin@example.test');
 });
 afterAll(closeAll);

 it('gives the application role append-only privileges with RLS enabled on all three tables',async()=>{
  for(const table of ['import_attempt','import_attempt_item','import_attempt_event']){
   const[p]=await withTenant(a,tx=>tx.execute<Record<string,unknown>>(sql`select has_table_privilege(current_user,${'public.'+table},'SELECT') as read,has_table_privilege(current_user,${'public.'+table},'INSERT') as insert,has_table_privilege(current_user,${'public.'+table},'UPDATE') as update,has_table_privilege(current_user,${'public.'+table},'DELETE') as delete,(select relrowsecurity from pg_class where oid=${'public.'+table}::regclass) as rls`));
   expect(p).toEqual({read:true,insert:true,update:false,delete:false,rls:true});
  }
  const{attemptId}=await upload(a,[row('ACME','AC001','ACME-OPS','100')]);
  await expect(withTenant(a,tx=>tx.execute(sql`update import_attempt set source_name='changed' where id=${attemptId}::uuid`))).rejects.toThrow();
  await expect(withTenant(a,tx=>tx.execute(sql`delete from import_attempt_event where attempt_id=${attemptId}::uuid`))).rejects.toThrow();
  const ownerUpdate=await owner.db.execute(sql`update import_attempt_event set reason='x' where attempt_id=${attemptId}::uuid`).then(()=>null,e=>e as {cause?:{message?:string}});
  expect(ownerUpdate?.cause?.message).toMatch(/append-only/);
 });

 it('imports a multi-company file, records it with the original bytes, and lists it by kind',async()=>{
  const records=[row('ACME','AC001','ACME-OPS','60'),row('acme','ac001','ACME-SALES','40'),row('202001000002','BE001','BETA-OPS','100')];
  const{attemptId,plan,result}=await importFile(a,records);
  expect(plan.counts).toEqual({total:2,valid:2,invalid:0});expect(plan.groups.map(g=>g.companyId).sort()).toEqual([b.companyId,betaId].sort());
  expect(result).toMatchObject({succeeded:2,failed:0,alreadyCommitted:false});
  expect((await allocation(acmeEmp)).total).toBe(10000);expect((await allocation(betaEmp)).total).toBe(10000);
  const source=await importAttemptSource(a,attemptId);expect(source?.content.equals(csv(records))).toBe(true);expect(source?.sourceHash).toBe(importSourceHash(csv(records)));
  const listed=await listImportAttempts(a,{kind:'cost_allocations'});expect(listed.items.map(i=>i.id)).toEqual([attemptId]);
  expect(importAttemptStatus(listed.items[0].plan,listed.items[0].events)).toBe('succeeded');expect(listed.items[0].companies).toHaveLength(2);
  expect((await listImportAttempts(a,{kind:'movement'})).items).toEqual([]);
  // A repeated confirm is idempotent and writes nothing more.
  expect(await confirmCostAllocationUpload(a,{attemptId,previewHash:plan.previewHash})).toMatchObject({alreadyCommitted:true,succeeded:2});
  expect((await allocation(acmeEmp)).revision).toBe(1);
 });

 it('refuses unknown and ambiguous Company Codes, ids and archived companies, and employees of another company',async()=>{
  const[clash]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Clash Bhd',companyLabel:'TWIN'}).returning();
  await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Twin',companyLabel:'OTHER'});
  await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Gone Bhd',companyLabel:'GONE',archivedAt:new Date()});
  const{plan}=await upload(a,[row('NOPE','AC001','ACME-OPS','100'),row('TWIN','AC002','ACME-OPS','100'),row(b.companyId,'AC002','ACME-OPS','50',earlier),row('GONE','AC001','ACME-OPS','100',earlier),row('BETA','AC001','BETA-OPS','100'),row('ACME','BE001','ACME-OPS','100')]);
  const errors=plan.groups.map(g=>g.errors.join(' '));
  expect(errors[0]).toMatch(/Row 2: Company Code "NOPE" does not match a company you can import for/);
  expect(errors[1]).toMatch(/Row 3: Company Code "TWIN" matches more than one company/);
  expect(errors[2]).toMatch(/does not match a company/);expect(errors[3]).toMatch(/does not match a company/);
  expect(errors[4]).toMatch(/Row 6: Employee ID AC001 is not an employee of BETA \(Beta Fictional Bhd\)/);
  expect(errors[5]).toMatch(/Row 7: Employee ID BE001 is not an employee of ACME/);
  expect(plan.counts).toEqual({total:6,valid:0,invalid:6});expect(clash.id).toBeTruthy();
 });

 it('refuses the old company_id layout and still records the attempt for its creator only',async()=>{
  const legacy=Buffer.from(`company_id,employee_code,effective_date,operation,cost_center_code,percentage\n${b.companyId},AC001,${today},replace,ACME-OPS,100\n`);
  const{attemptId,plan}=await previewCostAllocationUpload(a,{name:'old.csv',content:legacy});
  expect(plan.issues).toEqual([{rowNum:1,reason:LEGACY_ALLOCATION_LAYOUT_MESSAGE}]);
  await expect(confirmCostAllocationUpload(a,{attemptId,previewHash:plan.previewHash})).rejects.toThrow(/Correct the file/);
  expect((await getImportAttempt(a,attemptId))?.companyIds).toEqual([]);
  expect(await getImportAttempt(acmeOnly,attemptId)).toBeNull();
 });

 it('saves each employee in its own transaction so one failure does not roll back the others',async()=>{
  await owner.db.execute(sql.raw(`CREATE FUNCTION public.import_history_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM employment_cost_allocation_set s WHERE s.id=NEW.set_id AND s.employment_id='${acmeEmp2}') THEN RAISE EXCEPTION 'fixture refusal'; END IF; RETURN NEW; END $$`));
  await owner.db.execute(sql`CREATE TRIGGER import_history_refuse BEFORE INSERT ON employment_cost_allocation_row FOR EACH ROW EXECUTE FUNCTION public.import_history_refuse()`);
  try{
   const{attemptId,result}=await importFile(a,[row('ACME','AC001','ACME-OPS','100'),row('ACME','AC002','ACME-OPS','100'),row('BETA','BE001','BETA-OPS','100')]);
   expect(result).toMatchObject({succeeded:2,failed:1});expect(result.results.find(r=>r.employeeCode==='AC002')).toMatchObject({saved:false});
   expect((await allocation(acmeEmp)).total).toBe(10000);expect((await allocation(betaEmp)).total).toBe(10000);expect((await allocation(acmeEmp2)).revision).toBe(0);
   const detail=await getImportAttempt(a,attemptId);expect(detail?.items.map(i=>[i.label.split(' ')[0],i.status])).toEqual([['AC001','applied'],['AC002','failed'],['BE001','applied']]);
   expect(importAttemptStatus(detail!.plan,detail!.events)).toBe('partial');
  }finally{await owner.db.execute(sql`DROP TRIGGER import_history_refuse ON employment_cost_allocation_row`);await owner.db.execute(sql`DROP FUNCTION public.import_history_refuse()`);}
 });

 it('shows before and after per employee, reverts once with a reason, and keeps the audit trail',async()=>{
  const input={employmentId:acmeEmp,effectiveDate:earlier,expectedRevision:0,operation:'replace' as const,rows:[{costCenterId:ccA,percentage:'25'}]};
  await saveEmploymentCostAllocations(a,input,{digest:(await previewEmploymentCostAllocations(a,input)).digest});
  const{attemptId}=await importFile(a,[row('ACME','AC001','ACME-OPS','30'),row('ACME','AC001','ACME-SALES','70'),row('ACME','AC002','ACME-SALES','100')]);
  const detail=await getImportAttempt(a,attemptId);const first=detail!.items.find(i=>i.employmentId===acmeEmp)!;
  expect(first.before).toMatchObject({operation:'replace',headRevision:1,rows:[{code:'ACME-OPS',hundredths:2500}]});
  expect(first.after).toMatchObject({operation:'replace',headRevision:2,rows:[{code:'ACME-OPS',hundredths:3000},{code:'ACME-SALES',hundredths:7000}]});
  expect(detail!.items.find(i=>i.employmentId===acmeEmp2)!.before).toMatchObject({operation:'none',rows:[]});
  await expect(revertImportForAttempt(a,attemptId,{previewHash:'0'.repeat(64),reason:''})).rejects.toThrow(/reason/);
  const preview=await previewImportRevertForAttempt(a,attemptId);expect(preview.eligible).toBe(true);
  expect(preview.items.find(i=>i.employmentId===acmeEmp)!.restore).toMatchObject({operation:'replace',rows:[{code:'ACME-OPS',percentage:'25.00'}]});
  expect(await revertImportForAttempt(a,attemptId,{previewHash:preview.previewHash,reason:'Wrong split file'})).toEqual({attemptId,restored:2});
  const restored=await allocation(acmeEmp);expect(restored.rows.map(r=>[r.codeSnapshot,r.hundredths])).toEqual([['ACME-OPS',2500]]);expect(restored.current?.source).toBe('import-revert');
  expect((await allocation(acmeEmp,earlier)).rows.map(r=>r.hundredths)).toEqual([2500]);
  expect((await allocation(acmeEmp2)).rows).toEqual([]);expect(restored.history.length).toBeGreaterThanOrEqual(3);
  const after=await getImportAttempt(a,attemptId);expect(importAttemptStatus(after!.plan,after!.events)).toBe('reverted');expect(after!.events.find(e=>e.kind==='reverted')?.reason).toBe('Wrong split file');
  await expect(previewImportRevertForAttempt(a,attemptId)).rejects.toThrow(/already been reverted/);
  await expect(revertImportForAttempt(a,attemptId,{previewHash:preview.previewHash,reason:'Again'})).rejects.toThrow(/already been reverted/);
  const[count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from import_attempt_event where attempt_id=${attemptId}::uuid and kind='reverted'`);expect(count.n).toBe(1);
  await expect(owner.db.insert(s.importAttemptEvent).values({tenantId:b.tenantId,attemptId,kind:'reverted',actorId:b.adminUserId,reason:'direct'})).rejects.toThrow();
  const[audit]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from domain_event where aggregate_id=${attemptId}::uuid and event_type='import-attempt.reverted'`);expect(audit.n).toBe(1);
 });

 it('restores several dated sets of one employee in reverse order',async()=>{
  const{attemptId}=await importFile(a,[row('ACME','AC001','ACME-OPS','100',earlier),row('ACME','AC001','ACME-SALES','100')]);
  expect((await allocation(acmeEmp,earlier)).rows.map(r=>r.costCenterId)).toEqual([ccA]);expect((await allocation(acmeEmp)).rows.map(r=>r.costCenterId)).toEqual([ccB]);
  const preview=await previewImportRevertForAttempt(a,attemptId);expect(preview.eligible).toBe(true);
  await revertImportForAttempt(a,attemptId,{previewHash:preview.previewHash,reason:'Dated sets reverted'});
  expect((await allocation(acmeEmp,earlier)).rows).toEqual([]);expect((await allocation(acmeEmp)).rows).toEqual([]);
 });

 it('blocks the whole revert, listing the employee, after a later allocation change',async()=>{
  const{attemptId}=await importFile(a,[row('ACME','AC001','ACME-OPS','100'),row('ACME','AC002','ACME-OPS','100')]);
  const later={employmentId:acmeEmp2,effectiveDate:today,expectedRevision:1,operation:'replace' as const,rows:[{costCenterId:ccB,percentage:'50'}]};
  await saveEmploymentCostAllocations(a,later,{digest:(await previewEmploymentCostAllocations(a,later)).digest});
  const preview=await previewImportRevert(a,attemptId,costAllocationRevertHandler);
  expect(preview.eligible).toBe(false);expect(preview.blockers).toEqual([expect.objectContaining({label:`AC002 · ${today}`,reason:expect.stringMatching(/changed since this import/)})]);
  const error=await revertImport(a,attemptId,costAllocationRevertHandler,{previewHash:preview.previewHash,reason:'Try anyway'}).catch(e=>e);
  expect(error).toBeInstanceOf(ImportHistoryError);expect((error as ImportHistoryError).blockers).toHaveLength(1);
  expect((await allocation(acmeEmp)).total).toBe(10000);expect((await allocation(acmeEmp2)).total).toBe(5000);
  const detail=await getImportAttempt(a,attemptId);expect(detail!.events.map(e=>e.kind)).toEqual(['previewed','confirmed','revert_failed']);expect(importAttemptStatus(detail!.plan,detail!.events)).toBe('succeeded');
 });

 it('scopes history by company: another company\'s admin cannot see, download or revert it',async()=>{
  const acmeOnlyFile=await importFile(a,[row('ACME','AC001','ACME-OPS','100')]);
  const mixed=await importFile(a,[row('ACME','AC002','ACME-OPS','100'),row('BETA','BE001','BETA-OPS','100')]);
  expect((await listImportAttempts(betaOnly)).items.map(i=>i.id)).toEqual([mixed.attemptId]);
  expect(await getImportAttempt(betaOnly,acmeOnlyFile.attemptId)).toBeNull();expect(await importAttemptSource(betaOnly,acmeOnlyFile.attemptId)).toBeNull();
  await expect(previewImportRevertForAttempt(betaOnly,acmeOnlyFile.attemptId)).rejects.toThrow(/cannot be reverted|unavailable/);
  const seen=await getImportAttempt(betaOnly,mixed.attemptId);
  expect(seen?.items.map(i=>i.employmentId)).toEqual([betaEmp]);expect(JSON.stringify(seen?.items)).not.toContain('AC002');
  expect(seen).toMatchObject({canDownloadSource:false,canRevert:false});expect(await importAttemptSource(betaOnly,mixed.attemptId)).toBeNull();
  await expect(previewImportRevertForAttempt(betaOnly,mixed.attemptId)).rejects.toThrow(/maintain permission for every company/);
  const preview=await previewImportRevertForAttempt(a,mixed.attemptId);
  await expect(revertImportForAttempt(betaOnly,mixed.attemptId,{previewHash:preview.previewHash,reason:'Not mine'})).rejects.toThrow(/maintain permission for every company/);
  expect((await allocation(acmeEmp2)).total).toBe(10000);
  // A single-company admin can import and revert their own company.
  const own=await importFile(acmeOnly,[row('ACME','AC001','ACME-SALES','100',earlier)]);expect(own.result.succeeded).toBe(1);
  const ownPreview=await previewImportRevertForAttempt(acmeOnly,own.attemptId);expect(ownPreview.eligible).toBe(true);
  // ...but cannot import a row for a company they do not maintain.
  const foreign=await upload(acmeOnly,[row('BETA','BE001','BETA-OPS','100')]);expect(foreign.plan.groups[0].errors.join(' ')).toMatch(/does not match a company you can import for/);
  const rows=await owner.db.select().from(s.importAttempt).orderBy(asc(s.importAttempt.createdAt));expect(rows.every(r=>r.sourceHash===importSourceHash(r.sourceContent))).toBe(true);
 });
});
