import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {bulkSaveLabels,createDepartment,createBusinessUnit,listDepartmentsForLabels,listPositionsForLabels,listCostCentersForLabels,listBusinessUnitsForLabels} from '../core/admin';
import {companiesForLabel,labelIdsForCompany,setLabelCriteria,setLabelCriteriaBatch,setLabelGlobal,lockLabelCriteriaTx} from '../core/system-labels';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {labelsInCompanyScope,type CompanyScopedLabel} from '../lib/system-label-scope';
let b:Base;
const raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:3});
beforeAll(migrateTestDb);afterAll(async()=>{await raw.end();await closeAll();});beforeEach(async()=>{await resetDb();b=await seedBase();});
const company=async(tenantId=b.tenantId)=>(await owner.db.insert(s.company).values({tenantId,legalName:'Synthetic company '+randomUUID(),country:'MY',currency:'MYR'}).returning({id:s.company.id}))[0].id;
async function administrator(companyId:string):Promise<SessionContext>{const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning({id:s.appUser.id});await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId});return {tenantId:b.tenantId,userId:user.id,grants:[{role:'hr_admin',companyId}]};}
describe('System Labels canonical Criteria and database boundaries',()=>{
 it('common maintenance applies actual administrator scope before returning rows, independently of switcher state',async()=>{
  const admin=adminCtx(b),other=await company(),scoped=await administrator(other);
  const hidden=(await createDepartment(admin,{companyId:b.companyId,name:'Hidden origin-only'})).id;
  const global=(await createDepartment(admin,{companyId:b.companyId,name:'Global reference'})).id;await setLabelGlobal(admin,{kind:'department',labelId:global,isGlobal:true});
  const shared=(await createDepartment(admin,{companyId:b.companyId,name:'Assigned reference'})).id;await setLabelCriteria(admin,{kind:'department',labelId:shared,isGlobal:false,companyIds:[other]});
  const own=(await createDepartment(admin,{companyId:other,name:'Own reference'})).id;
  const rows=await listDepartmentsForLabels(scoped);expect(rows.map(row=>row.id)).toEqual(expect.arrayContaining([global,shared,own]));expect(rows.map(row=>row.id)).not.toContain(hidden);
  expect(rows.find(row=>row.id===shared)?.assignedCompanyIds).toEqual([other]);
  expect(rows.find(row=>row.id===own)?.assignedCompanyIds).toEqual([other]);
  expect(rows.find(row=>row.id===global)?.isGlobal).toBe(true);
  expect(labelsInCompanyScope(rows,new Set([other])).map(row=>row.id)).toEqual(expect.arrayContaining([global,shared,own]));
  expect(await listDepartmentsForLabels(scoped,{companyIds:[]})).toEqual([]);
 });
 it('projects exact saved company Criteria from the outer row for all four label kinds',async()=>{
  const admin=adminCtx(b),other=await company();
  const readers={department:listDepartmentsForLabels,position:listPositionsForLabels,cost_center:listCostCentersForLabels,business_unit:listBusinessUnitsForLabels};
  for(const kind of s.LABEL_KINDS) {
    const saved=await bulkSaveLabels(admin,kind,{creates:[{key:kind,companyId:b.companyId,isGlobal:false,companyIds:[other],name:'Projection '+kind,title:'Projection '+kind,code:'PROJECTION_'+kind}],updates:[]});
    const id=saved.createdIds[0].id;
    const rows: (CompanyScopedLabel & {id:string})[]=await readers[kind](admin),row=rows.find(row=>row.id===id);
    expect(row?.companyId).toBe(b.companyId);expect(row?.assignedCompanyIds).toEqual([other]);
    expect(labelsInCompanyScope(rows,new Set([other])).map(row=>row.id)).toContain(id);
    expect(labelsInCompanyScope(rows,new Set([b.companyId])).map(row=>row.id)).not.toContain(id);
  }
 });
 it('creates a B-only scoped code under B ownership so B administrators can maintain it',async()=>{
  const admin=adminCtx(b),other=await company(),bAdmin=await administrator(other),aAdmin=await administrator(b.companyId);
  const created=await bulkSaveLabels(admin,'department',{creates:[{key:'b-only',companyId:other,companyIds:[other],isGlobal:false,name:'B-only editable code'}],updates:[]}),id=created.createdIds[0].id;
  await bulkSaveLabels(bAdmin,'department',{creates:[],updates:[{key:id,id,name:'B-only editable code',label:'Maintained by B'}]});
  await expect(bulkSaveLabels(aAdmin,'department',{creates:[],updates:[{key:id,id,name:'B-only editable code',label:'Must refuse A'}]})).rejects.toThrow();
  expect((await owner.db.select().from(s.department).where(eq(s.department.id,id)))[0]).toMatchObject({companyId:other,label:'Maintained by B'});
 });
 it('retains origin-admin text and archive authority when Global or inaccessible company Criteria are unchanged',async()=>{
  const admin=adminCtx(b),other=await company(),scoped=await administrator(b.companyId),id=(await createDepartment(admin,{companyId:b.companyId,name:'Retained authority'})).id;
  await setLabelCriteria(admin,{kind:'department',labelId:id,isGlobal:false,companyIds:[other]});
  await bulkSaveLabels(scoped,'department',{creates:[],updates:[{key:id,id,name:'Retained authority',label:'Origin edit',criteria:{isGlobal:false,companyIds:[other]}}]});
  expect(await companiesForLabel(admin,'department',id)).toEqual([other]);
  await setLabelGlobal(admin,{kind:'department',labelId:id,isGlobal:true});
  await bulkSaveLabels(scoped,'department',{creates:[],updates:[{key:id,id,name:'Retained authority',label:'Global origin edit',archived:true,criteria:{isGlobal:true,companyIds:[]}}]});
  expect((await owner.db.select().from(s.department).where(eq(s.department.id,id)))[0]).toMatchObject({label:'Global origin edit',isGlobal:true,archivedAt:expect.any(Date)});
  await expect(setLabelCriteria(scoped,{kind:'department',labelId:id,isGlobal:false,companyIds:[b.companyId]})).rejects.toThrow('group administrator');
 });
 it('creation company is provenance, explicit criteria may exclude it, and future companies automatically receive Global',async()=>{
  const admin=adminCtx(b),other=await company(),id=(await createDepartment(admin,{companyId:b.companyId,name:'Explicit scope'})).id;
  await setLabelCriteria(admin,{kind:'department',labelId:id,isGlobal:false,companyIds:[other]});expect(await companiesForLabel(admin,'department',id)).toEqual([other]);expect(await labelIdsForCompany(admin,'department',b.companyId)).not.toContain(id);
  await setLabelGlobal(admin,{kind:'department',labelId:id,isGlobal:true});const added=await company();await owner.db.update(s.company).set({sharedSystemLabels:false}).where(eq(s.company.id,added));expect(await labelIdsForCompany(admin,'department',added)).toContain(id);
  expect((await owner.db.select({origin:s.department.companyId}).from(s.department).where(eq(s.department.id,id)))[0].origin).toBe(b.companyId);
 });
 it('validates the combined final text and criteria, then rolls back a genuinely conflicting final state',async()=>{
  const admin=adminCtx(b),other=await company(),first=(await createDepartment(admin,{companyId:b.companyId,name:'Old code'})).id;
  const second=(await createDepartment(admin,{companyId:other,name:'Proposed code'})).id;await setLabelCriteria(admin,{kind:'department',labelId:second,isGlobal:false,companyIds:[b.companyId]});
  await bulkSaveLabels(admin,'department',{creates:[],updates:[{id:first,key:first,name:'Proposed code',criteria:{isGlobal:false,companyIds:[other]}}]});
  expect(await companiesForLabel(admin,'department',first)).toEqual([other]);
  await expect(bulkSaveLabels(admin,'department',{creates:[],updates:[{id:first,key:first,name:'Proposed code',label:'Must roll back',criteria:{isGlobal:false,companyIds:[b.companyId]}}]})).rejects.toThrow(/same code|conflict/);
  expect((await owner.db.select({label:s.department.label}).from(s.department).where(eq(s.department.id,first)))[0].label).toBeNull();expect(await companiesForLabel(admin,'department',first)).toEqual([other]);
 });
 it('validates disjoint-company Criteria swaps after the complete canonical batch is applied',async()=>{
  const admin=adminCtx(b),other=await company(),first=(await createDepartment(admin,{companyId:b.companyId,name:'Swap code'})).id,second=(await createDepartment(admin,{companyId:other,name:'Swap code'})).id;
  await setLabelCriteriaBatch(admin,[{kind:'department',labelId:first,isGlobal:false,companyIds:[other]},{kind:'department',labelId:second,isGlobal:false,companyIds:[b.companyId]}]);
  expect(await companiesForLabel(admin,'department',first)).toEqual([other]);expect(await companiesForLabel(admin,'department',second)).toEqual([b.companyId]);
 });
 it('refuses empty/inaccessible/cross-tenant criteria and keeps Global criteria group-only',async()=>{
  const admin=adminCtx(b),other=await company(),id=(await createDepartment(admin,{companyId:b.companyId,name:'Guarded'})).id,scoped=await administrator(b.companyId);
  for(const companyIds of [[],[other],[randomUUID()]])await expect(setLabelCriteria(scoped,{kind:'department',labelId:id,isGlobal:false,companyIds})).rejects.toThrow();
  await expect(setLabelCriteria(scoped,{kind:'department',labelId:id,isGlobal:true,companyIds:[]})).rejects.toThrow('group administrator');
  const [foreign]=await owner.db.insert(s.tenant).values({name:'Foreign synthetic tenant',workosOrgId:randomUUID()}).returning({id:s.tenant.id});const foreignCompany=await company(foreign.id);
  await expect(owner.db.insert(s.labelCompanyAssignment).values({tenantId:b.tenantId,labelKind:'department',labelId:id,companyId:foreignCompany})).rejects.toThrow();
  const global=(await createDepartment(admin,{companyId:b.companyId,name:'Foreign company request guard'})).id;await setLabelGlobal(admin,{kind:'department',labelId:global,isGlobal:true});expect(await labelIdsForCompany(admin,'department',foreignCompany)).toEqual([]);
  await expect(owner.db.insert(s.labelCompanyAssignment).values({tenantId:b.tenantId,labelKind:'position',labelId:id,companyId:other})).rejects.toThrow();
  await expect(withTenant(scoped,tx=>tx.update(s.department).set({companyId:other}).where(eq(s.department.id,id)))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.delete(s.labelCompanyAssignment).where(and(eq(s.labelCompanyAssignment.labelKind,'department'),eq(s.labelCompanyAssignment.labelId,id))))).rejects.toThrow();
 });
 it('department business-unit references use Criteria and prevent concurrent scope removal bypasses',async()=>{
  const admin=adminCtx(b),other=await company(),unit=(await createBusinessUnit(admin,{companyId:other,code:'SHARED_UNIT',name:'Shared unit'})).id;await setLabelCriteria(admin,{kind:'business_unit',labelId:unit,isGlobal:false,companyIds:[b.companyId,other]});
  const department=(await createDepartment(admin,{companyId:b.companyId,name:'Shared unit department',businessUnitId:unit})).id;
  expect((await owner.db.select().from(s.department).where(eq(s.department.id,department)))[0].businessUnitId).toBe(unit);
  await expect(setLabelCriteria(admin,{kind:'business_unit',labelId:unit,isGlobal:false,companyIds:[other]})).rejects.toThrow('still uses');
  await expect(withTenant(admin,tx=>tx.delete(s.labelCompanyAssignment).where(and(eq(s.labelCompanyAssignment.labelId,unit),eq(s.labelCompanyAssignment.companyId,b.companyId))))).rejects.toThrow();
 });
 it('retains recorded-company assignment references in both service and raw SQL Criteria removal paths',async()=>{
  const admin=adminCtx(b),other=await company(),id=(await createDepartment(admin,{companyId:b.companyId,name:'Recorded-company reference'})).id;await setLabelCriteria(admin,{kind:'department',labelId:id,isGlobal:false,companyIds:[b.companyId,other]});
  const employee=await hireEmployee(admin,{person:{fullName:'Synthetic recorded assignment',primaryEmail:'recorded-assignment@labels.test'},companyId:b.companyId,departmentId:id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  await owner.db.update(s.assignment).set({companyId:other}).where(eq(s.assignment.employmentId,employee.employmentId));
  await expect(setLabelCriteria(admin,{kind:'department',labelId:id,isGlobal:false,companyIds:[b.companyId]})).rejects.toThrow('still uses');
  await expect(withTenant(admin,tx=>tx.delete(s.labelCompanyAssignment).where(and(eq(s.labelCompanyAssignment.labelId,id),eq(s.labelCompanyAssignment.companyId,other))))).rejects.toThrow();expect(await companiesForLabel(admin,'department',id)).toEqual(expect.arrayContaining([b.companyId,other]));
 });
 it('refuses restoring an archived code into overlapping availability without changing the stored row',async()=>{
  const admin=adminCtx(b),other=await company(),archived=(await createDepartment(admin,{companyId:b.companyId,name:'Restore code'})).id;
  await bulkSaveLabels(admin,'department',{creates:[],updates:[{id:archived,key:archived,name:'Restore code',archived:true}]});const live=(await createDepartment(admin,{companyId:other,name:'Restore code'})).id;await setLabelGlobal(admin,{kind:'department',labelId:live,isGlobal:true});
  await expect(bulkSaveLabels(admin,'department',{creates:[],updates:[{id:archived,key:archived,name:'Restore code',archived:false}]})).rejects.toThrow();expect((await owner.db.select().from(s.department).where(eq(s.department.id,archived)))[0].archivedAt).not.toBeNull();
 });
 it('serializes competing ordinary writers so only one overlapping Global code commits',async()=>{
  const admin=adminCtx(b),other=await company();const outcomes=await Promise.allSettled([b.companyId,other].map(companyId=>bulkSaveLabels(admin,'department',{creates:[{key:companyId,companyId,name:'Concurrent Global',isGlobal:true,companyIds:[]}],updates:[]})));
  expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1);expect(await owner.db.select().from(s.department).where(eq(s.department.name,'Concurrent Global'))).toHaveLength(1);
 });
 it('keeps the coordination revision tenant-bound and inaccessible to non-administrator writers',async()=>{
  const admin=adminCtx(b);await createDepartment(admin,{companyId:b.companyId,name:'Coordination permission fixture'});
  await expect(withTenant({...admin,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},tx=>tx.execute(sql`select app.lock_system_label_criteria(${b.tenantId}::uuid,'department')`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>lockLabelCriteriaTx(tx,randomUUID()))).rejects.toThrow();
  expect(await listDepartmentsForLabels({...admin,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]})).toEqual([]);
 });
 it('forces a pinned repeatable-read writer to restart after the coordination revision changes',async()=>{
  const admin=adminCtx(b);await createDepartment(admin,{companyId:b.companyId,name:'Epoch seed'});
  let pinned!:()=>void,release!:()=>void;const pinnedSignal=new Promise<void>(resolve=>{pinned=resolve;}),releaseSignal=new Promise<void>(resolve=>{release=resolve;});
  const stale=raw.begin('isolation level repeatable read',async tx=>{await tx`set local role ai_hr_app`;await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${admin.userId??''},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:null}])},true)`;await tx`select revision from system_label_criteria_epoch where tenant_id=${b.tenantId}::uuid and label_kind='department'`;pinned();await releaseSignal;await tx`select app.lock_system_label_criteria(${b.tenantId}::uuid,'department')`;});
  // Attach the rejection handler before releasing the first transaction; never leak an unhandled rejection.
  void stale.catch(()=>pinned());
  const refusal=expect(stale).rejects.toMatchObject({code:'40001'});try{await pinnedSignal;await withTenant(admin,tx=>tx.execute(sql`select app.lock_system_label_criteria(${b.tenantId}::uuid,'department')`));}finally{release();}await refusal;
 });
});
