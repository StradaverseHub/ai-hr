import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {pgSqlState} from '../lib/db-error';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {archiveDepartment,updateDepartment,createBusinessUnit,createCompany,bulkSaveLabels} from '../core/admin';
import {hireEmployee} from '../core/org';
import {setLabelCriteria} from '../core/system-labels';
import {prepareDepartmentArchiveTx,confirmDepartmentArchiveTx} from '../core/assistant-actions/department-archive-source';
import {DEPARTMENT_ARCHIVE_ACTION as action,DepartmentArchiveHuman} from '../lib/assistant-actions/department-archive-contract';
import {adminCtx,owner,resetDb,seedBase,closeAll,type Base} from './harness';
let b:Base;
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(closeAll);
const human=(base:Base,archived=true)=>({action,contractVersion:1 as const,departmentId:base.deptB,expectedArchived:!archived,archived});
const prepare=(base:Base,input=human(base))=>withTenant(adminCtx(base),tx=>prepareDepartmentArchiveTx(tx,adminCtx(base),input));
const confirm=(base:Base,digest:string,input=human(base))=>withTenant(adminCtx(base),tx=>confirmDepartmentArchiveTx(tx,adminCtx(base),input,{action,contractVersion:1,reviewedDigest:digest}));
describe('department catalogue archive source, pending Assistant custody',()=>{
 it('rejects unknown fields, fake employee binding and no-op intent',()=>{
  expect(DepartmentArchiveHuman.safeParse({...human(b),employmentId:b.deptB}).success).toBe(false);
  expect(DepartmentArchiveHuman.safeParse({...human(b),expectedArchived:true}).success).toBe(false);
 });
 it('archives and restores with the exact native row and event UUID',async()=>{
  const first=await prepare(b);expect(first.review).toMatchObject({departmentId:b.deptB,archived:false,afterArchived:true});
  const receipt=await confirm(b,first.reviewedDigest);
  const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,receipt.eventId));
  expect(event).toMatchObject({tenantId:b.tenantId,aggregateType:'department',aggregateId:b.deptB,eventType:'department.updated'});
  const [row]=await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB));expect(row.archivedAt).not.toBeNull();
  const restore=human(b,false),next=await prepare(b,restore);expect((await confirm(b,next.reviewedDigest,restore)).archived).toBe(false);
 });
 it('refuses metadata normalization rather than silently editing another field',async()=>{
  await owner.db.update(schema.department).set({description:'  retained spacing  '}).where(eq(schema.department.id,b.deptB));
  await expect(prepare(b)).rejects.toThrow();
  const [row]=await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB));expect(row).toMatchObject({description:'  retained spacing  ',archivedAt:null});
 });
 it('uses a read-stable Criteria epoch and rolls the native preview back',async()=>{
  const a=await prepare(b),before=await owner.db.select().from(schema.domainEvent);
  const [rowBefore]=await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB));
  const again=await prepare(b);expect(again.reviewedDigest).toBe(a.reviewedDigest);
  expect(await owner.db.select().from(schema.domainEvent)).toEqual(before);
  const [rowAfter]=await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB));expect(rowAfter).toEqual(rowBefore);
 });
 it('matches the grid in-use guard for any nonsuperseded assignment',async()=>{
  const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Department Holder',primaryEmail:b.tenantId+'@fixture.test'},companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:'2025-01-01'});
  await owner.db.update(schema.assignment).set({validTo:'2025-12-31'}).where(eq(schema.assignment.employmentId,hired.employmentId));
  await expect(prepare(b)).rejects.toThrow();
 });
 it('binds Criteria changes even if the department metadata stays unchanged',async()=>{
  const a=await prepare(b);await setLabelCriteria({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]},{kind:'department',labelId:b.deptB,isGlobal:false,companyIds:[b.companyId]});
  await expect(confirm(b,a.reviewedDigest)).rejects.toThrow();
 });
 it('refuses stale name changes without creating an archive effect',async()=>{
  const first=await prepare(b);await updateDepartment(adminCtx(b),{id:b.deptB,name:'Changed fictional department'});
  await expect(confirm(b,first.reviewedDigest)).rejects.toThrow();
  const [row]=await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB));expect(row.archivedAt).toBeNull();
 });
 it('refuses archive/restore ABA using the source row revision',async()=>{
  const first=await prepare(b);await archiveDepartment(adminCtx(b),{id:b.deptB,archived:true});await archiveDepartment(adminCtx(b),{id:b.deptB,archived:false});
  await expect(confirm(b,first.reviewedDigest)).rejects.toThrow();
 });
 it('preserves fresh current head, business-unit and parent routing through archive and restore',async()=>{
  const ctx=adminCtx(b),head=await hireEmployee(ctx,{person:{fullName:'Fictional Department Head',primaryEmail:b.tenantId+'-head@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'}),bu=await createBusinessUnit(ctx,{companyId:b.companyId,code:'FIC-BU',name:'Fictional Business Unit'});
  await bulkSaveLabels(ctx,'department',{creates:[],updates:[{key:b.deptB,id:b.deptB,name:'Operations',businessUnitId:bu.id,headEmploymentId:head.employmentId}]});
  await owner.db.update(schema.department).set({parentDepartmentId:b.deptA}).where(eq(schema.department.id,b.deptB));
  const original=(await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB)))[0];
  const first=await prepare(b);await confirm(b,first.reviewedDigest);const back=human(b,false),restored=await prepare(b,back);await confirm(b,restored.reviewedDigest,back);
  const after=(await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB)))[0];expect(after).toEqual(original);
 });
 it('hands off invalid retained head metadata instead of bypassing the native resolver',async()=>{
  const ctx=adminCtx(b),other=await createCompany(ctx,{legalName:'Fictional Head Company',country:'MY',currency:'MYR'});
  const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Foreign Head',primaryEmail:b.tenantId+'-foreign@fixture.test'}).returning({id:schema.person.id});
  const [head]=await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId:person.id,companyId:other.id,hiredOn:'2025-01-01',employeeCode:'FIC-FOREIGN'}).returning({id:schema.employment.id});
  await owner.db.update(schema.department).set({headEmploymentId:head.id}).where(eq(schema.department.id,b.deptB));
  await expect(prepare(b)).rejects.toThrow();const [after]=await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB));expect(after).toMatchObject({headEmploymentId:head.id,archivedAt:null});
 });
 it('refuses a head revision change even when the department pointer stays unchanged',async()=>{
  const ctx=adminCtx(b),head=await hireEmployee(ctx,{person:{fullName:'Fictional Retained Head',primaryEmail:b.tenantId+'-retained@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
  await bulkSaveLabels(ctx,'department',{creates:[],updates:[{key:b.deptB,id:b.deptB,name:'Operations',headEmploymentId:head.employmentId}]});const first=await prepare(b);
  await owner.db.update(schema.employment).set({employeeCode:'FIC-HEAD-REVISED'}).where(eq(schema.employment.id,head.employmentId));
  await expect(confirm(b,first.reviewedDigest)).rejects.toThrow();
 });
 it('restores a legacy archived department that still has assignment history',async()=>{
  await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Archived Department Holder',primaryEmail:b.tenantId+'-archived@fixture.test'},companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:'2025-01-01'});
  await archiveDepartment(adminCtx(b),{id:b.deptB,archived:true});const restore=human(b,false),r=await prepare(b,restore);expect((await confirm(b,r.reviewedDigest,restore)).archived).toBe(false);
 });
 it('retains the native storage guard against an unavailable business unit',async()=>{
  const ctx=adminCtx(b),other=await createCompany(ctx,{legalName:'Fictional Routing Company',country:'MY',currency:'MYR'}),bu=await createBusinessUnit({...ctx,grants:[{role:'hr_admin',companyId:null}]},{companyId:other.id,code:'FIC-OTHER',name:'Fictional Other Unit'});
  let error:unknown;try{await owner.db.update(schema.department).set({businessUnitId:bu.id}).where(eq(schema.department.id,b.deptB));}catch(caught){error=caught;}
  expect(pgSqlState(error)).toBe('23514');expect((await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB)))[0]).toMatchObject({businessUnitId:null,archivedAt:null});
  expect((await prepare(b)).review).toMatchObject({departmentId:b.deptB,archived:false,afterArchived:true});
 });
 it('retains a shared business unit allowed by the native Criteria owner',async()=>{
  const ctx={...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]},other=await createCompany(ctx,{legalName:'Fictional Shared Unit Company',country:'MY',currency:'MYR'}),bu=await createBusinessUnit(ctx,{companyId:other.id,code:'FIC-SHARED',name:'Fictional Shared Unit'});
  await setLabelCriteria(ctx,{kind:'business_unit',labelId:bu.id,isGlobal:false,companyIds:[other.id,b.companyId]});
  await bulkSaveLabels(ctx,'department',{creates:[],updates:[{key:b.deptB,id:b.deptB,name:'Operations',businessUnitId:bu.id}]});const first=await prepare(b);await confirm(b,first.reviewedDigest);
  expect((await owner.db.select().from(schema.department).where(eq(schema.department.id,b.deptB)))[0]).toMatchObject({businessUnitId:bu.id});
 });
 it('refuses a business-unit revision change after review',async()=>{
  const ctx=adminCtx(b),bu=await createBusinessUnit(ctx,{companyId:b.companyId,code:'FIC-STALE',name:'Fictional Stale Unit'});
  await bulkSaveLabels(ctx,'department',{creates:[],updates:[{key:b.deptB,id:b.deptB,name:'Operations',businessUnitId:bu.id}]});const first=await prepare(b);
  await owner.db.update(schema.businessUnit).set({description:'Changed native routing metadata'}).where(eq(schema.businessUnit.id,bu.id));await expect(confirm(b,first.reviewedDigest)).rejects.toThrow();
 });
 it('refuses foreign tenant IDs',async()=>{const other=await seedBase();await expect(prepare(b,human(other))).rejects.toThrow();});
 it('refuses a global label whose consequences exceed one company',async()=>{
  await setLabelCriteria({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]},{kind:'department',labelId:b.deptB,isGlobal:true,companyIds:[]});await expect(prepare(b)).rejects.toThrow();
 });
 it('refuses an ordinary employee without treating read visibility as write authority',async()=>{
  const ctx={...adminCtx(b),roles:['employee' as const],grants:[{role:'employee' as const,companyId:b.companyId}]};
  await expect(withTenant(ctx,tx=>prepareDepartmentArchiveTx(tx,ctx,human(b)))).rejects.toThrow();
 });
});
