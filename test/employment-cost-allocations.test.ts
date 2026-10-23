import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,asc,eq,isNull,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,transferEmploymentCompanyTx} from '../core/org';
import {createCostCenter,deleteCostCenter,listCostCenters,listCostCentersForLabels} from '../core/admin';
import {setLabelCriteria} from '../core/system-labels';
import {getEmploymentCostAllocations,previewEmploymentCostAllocations,saveEmploymentCostAllocations} from '../core/employment-cost-allocations';
import {previewCostAllocationImport,commitCostAllocationImport,costAllocationWorkbookReferences} from '../core/cost-allocation-import';
import {validateEmployeeImport,commitEmployeeImport} from '../core/import';
import {todayInKualaLumpur} from '../lib/hr-date';
import {dayBefore} from '../core/employment-company';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const today=todayInKualaLumpur(),year=Number(today.slice(0,4)),hireDate=`${year-1}-01-01`,future=`${year+1}-01-01`;
describe('Effective-dated employment cost allocation owner',()=>{
 let b:Base,a:ReturnType<typeof adminCtx>,employmentId:string,cc1:string,cc2:string;
 const read=(date=today)=>getEmploymentCostAllocations(a,employmentId,date);
 async function save(rows:{costCenterId:string;percentage:string}[],date=today){const input={employmentId,effectiveDate:date,expectedRevision:(await read(date)).revision,operation:rows.length?'replace':'clear',rows};const preview=await previewEmploymentCostAllocations(a,input);return saveEmploymentCostAllocations(a,input,{digest:preview.digest});}
 beforeAll(migrateTestDb);beforeEach(async()=>{
  await resetDb();b=await seedBase();a=adminCtx(b);
  ({employmentId}=await hireEmployee(a,{person:{fullName:'Allocation Employee',primaryEmail:'allocation@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:hireDate,employeeCode:'ALLOC01'}));
  cc1=(await createCostCenter(a,{companyId:b.companyId,code:'ALLOC-A',name:'Allocation A'})).id;cc2=(await createCostCenter(a,{companyId:b.companyId,code:'ALLOC-B',name:'Allocation B'})).id;
 });afterAll(closeAll);
 it('gives the actual application role SELECT only on allocation tables, independently of RLS refusal',async()=>{
  for(const table of ['employment_cost_allocation_head','employment_cost_allocation_set','employment_cost_allocation_row']){
   const[privileges]=await withTenant(a,tx=>tx.execute(sql`select current_user as role,
    has_table_privilege(current_user,${'public.'+table},'SELECT') as read,
    has_table_privilege(current_user,${'public.'+table},'INSERT') as insert,
    has_table_privilege(current_user,${'public.'+table},'UPDATE') as update,
    has_table_privilege(current_user,${'public.'+table},'DELETE') as delete,
    has_table_privilege(current_user,${'public.'+table},'TRUNCATE') as truncate,
    has_table_privilege(current_user,${'public.'+table},'REFERENCES') as references,
    has_table_privilege(current_user,${'public.'+table},'TRIGGER') as trigger`));
   expect(privileges).toEqual({role:'ai_hr_app',read:true,insert:false,update:false,delete:false,truncate:false,references:false,trigger:false});
  }
 });
 it('qualifies equal configured labels in the actual allocation choices while retaining cost center IDs and codes',async()=>{
  await owner.db.update(s.costCenter).set({label:'Shared services'}).where(eq(s.costCenter.id,cc1));
  await owner.db.update(s.costCenter).set({label:'Shared services'}).where(eq(s.costCenter.id,cc2));
  const choices=(await read()).choices;
  expect(choices.find(row=>row.id===cc1)).toMatchObject({id:cc1,code:'ALLOC-A',label:'Shared services',displayLabel:'Shared services (ALLOC-A)'});
  expect(choices.find(row=>row.id===cc2)).toMatchObject({id:cc2,code:'ALLOC-B',label:'Shared services',displayLabel:'Shared services (ALLOC-B)'});
  expect((await read()).rows).toEqual([]);expect((await read()).revision).toBe(0);
 });
 it('starts unset, saves/reopens a partial set, preserves primary assignment and pay, and keeps historical snapshots',async()=>{
  expect((await read()).rows).toEqual([]);expect((await read()).revision).toBe(0);
  const primary=await owner.db.select().from(s.assignment).where(eq(s.assignment.employmentId,employmentId)).orderBy(asc(s.assignment.id));const compensation=await owner.db.select().from(s.compensation).where(eq(s.compensation.employmentId,employmentId)).orderBy(asc(s.compensation.id));
  await save([{costCenterId:cc1,percentage:'33.33'},{costCenterId:cc2,percentage:'16.67'}],hireDate);
  expect((await read()).total).toBe(5000);await save([{costCenterId:cc1,percentage:'100'}]);
  expect((await read(dayBefore(today))).total).toBe(5000);expect((await read()).total).toBe(10000);
  await owner.db.update(s.costCenter).set({label:'Renamed allocation'}).where(eq(s.costCenter.id,cc1));
  const v=await read();expect(v.rows[0].displayLabel).toBe('Renamed allocation');expect(v.rows[0].codeSnapshot).toBe('ALLOC-A');expect(v.history.some(h=>h.rows.some(r=>r.costCenterId===cc1&&r.labelSnapshot!=='Renamed allocation'))).toBe(true);
  expect(await owner.db.select().from(s.assignment).where(eq(s.assignment.employmentId,employmentId)).orderBy(asc(s.assignment.id))).toEqual(primary);expect(await owner.db.select().from(s.compensation).where(eq(s.compensation.employmentId,employmentId)).orderBy(asc(s.compensation.id))).toEqual(compensation);
 });
 it('chooses only proven company-history dates for omitted future/ended views and refuses explicit invalid dates',async()=>{
  const futureDate=`${year+1}-06-01`;
  const futureHire=await hireEmployee(a,{person:{fullName:'Future allocation subject'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:futureDate,employeeCode:'FUTALLOC'});
  const futureView=await getEmploymentCostAllocations(a,futureHire.employmentId);expect(futureView.effectiveDate).toBe(futureDate);expect(futureView.canEdit).toBe(true);
  await expect(getEmploymentCostAllocations(a,futureHire.employmentId,today)).rejects.toThrow(/history/);
  const endDate=dayBefore(today);await owner.db.update(s.employment).set({terminatedOn:endDate}).where(eq(s.employment.id,employmentId));
  const endedView=await getEmploymentCostAllocations(a,employmentId);expect(endedView.effectiveDate).toBe(endDate);expect(endedView.companyId).toBe(b.companyId);
  await expect(getEmploymentCostAllocations(a,employmentId,today)).rejects.toThrow(/history/);
  // If the company spine is unproven, an omitted date must not manufacture one from group hire date.
  const[active]=await owner.db.select().from(s.assignment).where(and(eq(s.assignment.employmentId,futureHire.employmentId),isNull(s.assignment.supersededAt))).orderBy(asc(s.assignment.id));
  await owner.db.update(s.assignment).set({companyId:null}).where(eq(s.assignment.id,active.id));
  await expect(getEmploymentCostAllocations(a,futureHire.employmentId)).rejects.toThrow(/history/);
 });
 it('serializes full-set CAS writes and rejects stale previews and changed Criteria',async()=>{
  const input={employmentId,effectiveDate:today,expectedRevision:0,operation:'replace',rows:[{costCenterId:cc1,percentage:'100'}]};const p=await previewEmploymentCostAllocations(a,input);
  const results=await Promise.allSettled([saveEmploymentCostAllocations(a,input,{digest:p.digest}),saveEmploymentCostAllocations(a,input,{digest:p.digest})]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await read()).revision).toBe(1);
  await expect(saveEmploymentCostAllocations(a,input,{digest:p.digest})).rejects.toThrow(/changed/i);
  const next={...input,expectedRevision:1,rows:[{costCenterId:cc2,percentage:'100'}]};const q=await previewEmploymentCostAllocations(a,next);
  await owner.db.update(s.costCenter).set({archivedAt:new Date()}).where(eq(s.costCenter.id,cc2));await expect(saveEmploymentCostAllocations(a,next,{digest:q.digest})).rejects.toThrow(/inactive|unavailable/);expect((await read()).rows[0].costCenterId).toBe(cc1);
 });
 it('blocks deletion and active Criteria removal, but retains identity when a closed historical set is no longer applicable',async()=>{
  await save([{costCenterId:cc1,percentage:'100'}],hireDate);expect((await listCostCenters(a)).find(c=>c.id===cc1)?.inUse).toBe(true);expect((await listCostCentersForLabels(a)).find(c=>c.id===cc1)?.inUse).toBe(true);await expect(deleteCostCenter(a,{id:cc1})).rejects.toThrow(/in use/i);
  const[other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Other Company'}).returning();
  await expect(setLabelCriteria(a,{kind:'cost_center',labelId:cc1,isGlobal:false,companyIds:[other.id]})).rejects.toThrow(/uses/);
  await save([],today);await setLabelCriteria(a,{kind:'cost_center',labelId:cc1,isGlobal:false,companyIds:[other.id]});
  expect((await read(dayBefore(today))).rows[0].costCenterId).toBe(cc1);await expect(deleteCostCenter(a,{id:cc1})).rejects.toThrow(/in use/i);
 });
 it('enforces tenant/workforce/dated company boundaries and rejects a cross-company label without writes',async()=>{
  const other=await seedBase();const foreign=(await createCostCenter(adminCtx(other),{companyId:other.companyId,code:'FOREIGN',name:'Foreign'})).id;
  await expect(save([{costCenterId:foreign,percentage:'100'}])).rejects.toThrow(/unavailable/);
  await expect(getEmploymentCostAllocations(adminCtx(other),employmentId)).rejects.toThrow();await expect(read(`${year-2}-01-01`)).rejects.toThrow(/history/);
  const outsider={...a,roles:['employee'],grants:[],userId:other.adminUserId};await expect(getEmploymentCostAllocations(outsider,employmentId)).rejects.toThrow();expect((await read()).revision).toBe(0);
 });
 it('requires explicit clearing at transfer boundary and of later scheduled sets, preserving before-date distribution',async()=>{
  const[dest]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Destination'}).returning();const[dept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:dest.id,name:'Destination Department'}).returning();
  await save([{costCenterId:cc1,percentage:'100'}],hireDate);await save([{costCenterId:cc2,percentage:'100'}],future);
  const transfer=()=>withTenant(a,tx=>transferEmploymentCompanyTx(tx,a,{employmentId,newCompanyId:dest.id,effectiveDate:today,placement:{departmentId:dept.id},movement:{type:'entityTransfer'}}));
  await expect(transfer()).rejects.toThrow(/clear/i);await save([],today);await expect(transfer()).rejects.toThrow(/scheduled/);await save([],future);await transfer();
  expect((await read(dayBefore(today))).total).toBe(10000);expect((await read()).total).toBe(0);expect((await read()).needsReplacement).toBe(true);
  await expect(save([{costCenterId:cc1,percentage:'100'}])).rejects.toThrow(/unavailable/);
 });
 it('protects full-set invariants even when bypassing the JS facade and refuses direct table writes',async()=>{
  await expect(withTenant(a,tx=>tx.execute(sql`select app.employment_cost_allocation_commit(${employmentId}::uuid,${b.companyId}::uuid,${today}::date,0,'replace',${JSON.stringify([{costCenterId:cc1,hundredths:6000},{costCenterId:cc2,hundredths:5000}])}::jsonb,'manual')`))).rejects.toThrow();
  await expect(withTenant(a,tx=>tx.insert(s.employmentCostAllocationHead).values({tenantId:b.tenantId,employmentId,revision:0}))).rejects.toThrow();expect((await read()).revision).toBe(0);
 });
 it('filters workbook code references by current maintain authority and refuses a denied selected company',async()=>{
  const[other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Hidden catalogue company'}).returning();await createCostCenter(a,{companyId:other.id,code:'HIDDEN-CODE',name:'Hidden cost centre'});
  const[p]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Scoped allocation administrator'}).returning();const userId=await createAppUser(b.tenantId,p.id,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const scoped={...a,userId,personId:p.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const refs=await costAllocationWorkbookReferences(scoped,[b.companyId,other.id],b.companyId);expect(refs.some(r=>r.code==='ALLOC-A')).toBe(true);expect(JSON.stringify(refs)).not.toMatch(/HIDDEN-CODE|Hidden cost centre|Hidden catalogue company/);expect(refs.every(r=>r.companyId===b.companyId)).toBe(true);
  await expect(costAllocationWorkbookReferences(scoped,[b.companyId,other.id],other.id)).rejects.toThrow(/permission|unavailable/i);
 });
 it('resolves lowercase existing Employee IDs through the canonical normalizer',async()=>{
  const records=[{company_id:b.companyId,employee_code:' alloc01 ',effective_date:today,operation:'replace',cost_center_code:'ALLOC-A',percentage:'100'}];
  const p=await previewCostAllocationImport(a,records);expect(p.groups).toHaveLength(1);expect(p.groups[0]).toMatchObject({employeeCode:'ALLOC01',employmentId,errors:[]});
  expect(await commitCostAllocationImport(a,records,p.token)).toMatchObject([{employmentId,saved:true}]);expect((await read()).total).toBe(10000);
 });
 it('combines mixed-case rows into one employee/date set and refuses an over-total without partial writes',async()=>{
  const records=[{company_id:b.companyId,employee_code:'ALLOC01',effective_date:today,operation:'replace',cost_center_code:'ALLOC-A',percentage:'60'},{company_id:b.companyId,employee_code:'alloc01',effective_date:today,operation:'replace',cost_center_code:'ALLOC-B',percentage:'40'}];
  let p=await previewCostAllocationImport(a,records);expect(p.groups).toHaveLength(1);expect(p.groups[0].rowNums).toEqual([2,3]);expect(p.groups[0].errors).toEqual([]);
  await commitCostAllocationImport(a,records,p.token);const before=await read();expect(before.total).toBe(10000);expect(before.rows).toHaveLength(2);
  records[1].percentage='50';p=await previewCostAllocationImport(a,records);expect(p.groups).toHaveLength(1);expect(p.validCount).toBe(0);expect(p.groups[0].errors.join(' ')).toMatch(/100/);
  const result=await commitCostAllocationImport(a,records,p.token);expect(result).toHaveLength(1);expect(result[0].saved).toBe(false);expect((await read()).revision).toBe(before.revision);expect((await read()).rows).toEqual(before.rows);
 });
 it('groups repeated update rows, refuses the whole invalid employee set and rechecks the preview token',async()=>{
  const records=[{company_id:b.companyId,employee_code:'ALLOC01',effective_date:today,operation:'replace',cost_center_code:'ALLOC-A',percentage:'50.01'},{company_id:b.companyId,employee_code:'ALLOC01',effective_date:today,operation:'replace',cost_center_code:'ALLOC-B',percentage:'50'}];
  let p=await previewCostAllocationImport(a,records);expect(p.groups[0].errors.join(' ')).toMatch(/100/);expect(p.groups[0].rowNums).toEqual([2,3]);await commitCostAllocationImport(a,records,p.token);expect((await read()).revision).toBe(0);
  records[0].percentage='50';p=await previewCostAllocationImport(a,records);await owner.db.update(s.costCenter).set({label:'Changed since preview'}).where(eq(s.costCenter.id,cc1));await expect(commitCostAllocationImport(a,records,p.token)).rejects.toThrow(/Preview/);
  p=await previewCostAllocationImport(a,records);const result=await commitCostAllocationImport(a,records,p.token);expect(result).toMatchObject([{saved:true,employmentId,effectiveDate:today}]);expect((await read()).total).toBe(10000);
 });
 const record=()=>({full_name:'New Allocation Joiner',email:'new-allocation@fixture.test',department:'Finance',hired_on:today,employment_type:'full_time',employee_code:'NEWALLOC01',basic_salary:'2500',bank_name:'Maybank',bank_account_no:'001234567'});
 it('binds lowercase Employee IDs on both full new-joiner sheets to one canonical employee',async()=>{
  const employee={...record(),employee_code:'newalloc01'};
  const allocationRecords=[{company_id:b.companyId,employee_code:'newalloc01',effective_date:today,operation:'replace',cost_center_code:'ALLOC-A',percentage:'100'}];
  const preview=await validateEmployeeImport(a,{companyId:b.companyId,records:[employee],allocationRecords});expect(preview.fileErrors).toEqual([]);expect(preview.allocations?.groups).toMatchObject([{employeeCode:'NEWALLOC01',newEmployeeIndex:0,errors:[]}]);
  const result=await commitEmployeeImport(a,{companyId:b.companyId,records:[employee],allocationRecords,allocationToken:preview.allocations!.token});expect(result.imported).toBe(1);
  const[stored]=await owner.db.select().from(s.employment).where(eq(s.employment.employeeCode,'NEWALLOC01')).orderBy(asc(s.employment.id));expect((await getEmploymentCostAllocations(a,stored.id)).total).toBe(10000);
 });
 it('imports a new-joiner companion in the real employee transaction and leaves omitted sheets valid',async()=>{
  const allocations=[{company_id:b.companyId,employee_code:'NEWALLOC01',effective_date:today,operation:'replace',cost_center_code:'ALLOC-A',percentage:'100'}];const preview=await validateEmployeeImport(a,{companyId:b.companyId,records:[record()],allocationRecords:allocations});expect(preview.fileErrors).toEqual([]);expect(preview.allocations?.validCount).toBe(1);
  const result=await commitEmployeeImport(a,{companyId:b.companyId,records:[record()],allocationRecords:allocations,allocationToken:preview.allocations!.token});expect(result.imported).toBe(1);
  const[e]=await owner.db.select().from(s.employment).where(eq(s.employment.employeeCode,'NEWALLOC01')).orderBy(asc(s.employment.id));expect((await getEmploymentCostAllocations(a,e.id)).total).toBe(10000);
  const absent=await commitEmployeeImport(a,{companyId:b.companyId,records:[{...record(),employee_code:'NOALLOC01',email:'no-allocation@fixture.test'}]});expect(absent.imported).toBe(1);const[n]=await owner.db.select().from(s.employment).where(eq(s.employment.employeeCode,'NOALLOC01')).orderBy(asc(s.employment.id));expect((await getEmploymentCostAllocations(a,n.id)).rows).toEqual([]);
 });
 it('rolls back new employee identity, assignment and compensation when the allocation writer refuses after hire',async()=>{
  const allocations=[{company_id:b.companyId,employee_code:'NEWALLOC01',effective_date:today,operation:'replace',cost_center_code:'ALLOC-A',percentage:'100'}];const preview=await validateEmployeeImport(a,{companyId:b.companyId,records:[record()],allocationRecords:allocations});expect(preview.fileErrors).toEqual([]);
  await owner.db.execute(sql`CREATE FUNCTION public.allocation_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture allocation owner refusal';END $$`);await owner.db.execute(sql`CREATE TRIGGER allocation_test_refuse BEFORE INSERT ON employment_cost_allocation_row FOR EACH ROW EXECUTE FUNCTION public.allocation_test_refuse()`);
  try{const result=await commitEmployeeImport(a,{companyId:b.companyId,records:[record()],allocationRecords:allocations,allocationToken:preview.allocations!.token});expect(result.imported).toBe(0);expect(result.fileErrors.join(' ')).toMatch(/rolled back/);expect(await owner.db.select().from(s.person).where(eq(s.person.primaryEmail,record().email))).toEqual([]);expect(await owner.db.select().from(s.employment).where(eq(s.employment.employeeCode,'NEWALLOC01'))).toEqual([]);const leaked=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from employment_cost_allocation_set where tenant_id=${b.tenantId}::uuid`);expect(leaked[0].n).toBe(0);}finally{await owner.db.execute(sql`DROP TRIGGER allocation_test_refuse ON employment_cost_allocation_row`);await owner.db.execute(sql`DROP FUNCTION public.allocation_test_refuse()`);}
 });
});
