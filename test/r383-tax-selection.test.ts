import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {requirePackFor} from '../localization/registry';
import {createBatch} from '../core/payroll';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setStatutoryProfileMY,setTaxProfileMY} from '../localization/my/statutory';
import {getTaxSelectionMY,saveTaxSelectionMY,resolveTaxSelectionMY} from '../localization/my/tax-selection';
import {saveTaxSchemeDeclarationMY} from '../localization/my/tax-scheme-declarations';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base,createAppUser} from './harness';
let b:Base;let e:Awaited<ReturnType<typeof hireEmployee>>;
let ic=16000;
beforeAll(async()=>{await migrateTestDb();});afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();e=await hireEmployee(adminCtx(b),{person:{fullName:'Synthetic direct tax',primaryEmail:`tax_${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});await setStatutoryProfileMY(adminCtx(b),{personId:e.personId,icNumber:`900101${String(ic++).padStart(6,'0')}`});});
const save=(scheme:string,extra:Partial<Parameters<typeof saveTaxSelectionMY>[1]>={})=>saveTaxSelectionMY(adminCtx(b),{employmentId:e.employmentId,expectedCompanyId:b.companyId,scheme,...extra});
const resolve=(companyId=b.companyId,ctx=adminCtx(b))=>withTenant(ctx,tx=>resolveTaxSelectionMY(tx,{tenantId:b.tenantId,employmentId:e.employmentId,companyId,payPeriod:'2026-10',legacyScheme:'resident',resident:true,epfCitizenship:'non_citizen'}));
async function legacy(scheme:string,resident=true){await owner.db.update(schema.employeeStatutoryMy).set({taxResidency:scheme,isResident:resident}).where(eq(schema.employeeStatutoryMy.personId,e.personId));await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));}
async function declaration(scheme='rep'){return saveTaxSchemeDeclarationMY(adminCtx(b),{employmentId:e.employmentId,expectedCompanyId:b.companyId,scheme,validFrom:'2026-01',validTo:'2026-12',approvalReference:'SYNTHETIC',eligibilityConfirmed:true});}
describe('direct employer Income Tax Resident selection',()=>{
 it('hire initializes normal in its employment transaction and new nonresident hire retains explicit intent',async()=>{
  expect(await resolve()).toMatchObject({scheme:'resident',selectionVersion:1,selectionSource:'income_tax_resident'});
  const other=await hireEmployee(adminCtx(b),{person:{fullName:'Synthetic nonresident',primaryEmail:`nr_${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',initialTaxScheme:'non_resident'});
  const view=await getTaxSelectionMY(adminCtx(b),other.employmentId);expect(view).toMatchObject({scheme:'non_resident',transitionState:'resolved',version:1});
 });
 it.each(['resident','non_resident','rep','knowledge_worker','c_suite'])('direct %s choice routes without any declaration',async scheme=>{
  await owner.db.update(schema.employeeStatutoryMy).set({epfCitizenship:'non_citizen'}).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  const row=await save(scheme);expect(await resolve()).toEqual({scheme,selectionId:row.id,selectionVersion:row.version,selectionSource:'income_tax_resident',taxCircumstance:{version:1,key:null,category:1,applicable:true,epoch:0}});
  expect(await owner.db.select().from(schema.employmentTaxSchemeMy)).toHaveLength(0);
 });
 it('strict invalid choice, citizen/unknown C-Suite and stale revision do not change prior authority',async()=>{
  const view=await getTaxSelectionMY(adminCtx(b),e.employmentId);
  await expect(save('unknown')).rejects.toMatchObject({code:'invalid_scheme'});
  await expect(save('c_suite')).rejects.toMatchObject({code:'citizenship_unknown'});
  await expect(save('rep',{expectedVersion:view.version+1})).rejects.toMatchObject({code:'stale_context'});
  await expect(save('rep',{expectedCompanyId:randomUUID()})).rejects.toMatchObject({code:'stale_context'});
  expect(await getTaxSelectionMY(adminCtx(b),e.employmentId)).toEqual(view);
 });
 it.each(['rep',null] as const)('empty embedded form category cannot resolve an ambiguous %s context or save unrelated tax fields',async configured=>{
  if(configured==='rep')await declaration('knowledge_worker');
  await legacy(configured??'unsupported');
  const view=await getTaxSelectionMY(adminCtx(b),e.employmentId);
  expect(view).toMatchObject({scheme:configured,transitionState:'confirmation_required'});
  const before=await owner.db.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId)).orderBy(schema.employmentTaxSelectionMy.id);
  const oldProfile=await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId)).orderBy(schema.employeeStatutoryMy.id);
  const oldEvents=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId,e.employmentId)).orderBy(schema.domainEvent.sequence);
  const form=new FormData();form.set('taxResidency','');form.set('taxNumber','Unrelated edit');
  await expect(requirePackFor('MY').statutory.setTax(adminCtx(b),{personId:e.personId,employmentId:e.employmentId,expectedCompanyId:b.companyId,expectedSelectionVersion:view.version,taxResidency:String(form.get('taxResidency')??''),taxNumber:String(form.get('taxNumber')??'')})).rejects.toMatchObject({code:'invalid_scheme'});
  expect(await owner.db.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId)).orderBy(schema.employmentTaxSelectionMy.id)).toEqual(before);
  expect(await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId)).orderBy(schema.employeeStatutoryMy.id)).toEqual(oldProfile);
  expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId,e.employmentId)).orderBy(schema.domainEvent.sequence)).toEqual(oldEvents);
 });
 it('person-only automatic/partial tax write cannot overwrite selected REP',async()=>{
  await save('rep');await setTaxProfileMY(adminCtx(b),{personId:e.personId,taxResidency:'resident',numChildren:2,provenance:'auto_child_relief'});
  expect(await resolve()).toMatchObject({scheme:'rep',selectionVersion:2});
 });
 it('scoped tax card write is atomic, preserves person legacy provenance and audits exact employment',async()=>{
  const view=await getTaxSelectionMY(adminCtx(b),e.employmentId);
  await setTaxProfileMY(adminCtx(b),{personId:e.personId,employmentId:e.employmentId,expectedCompanyId:b.companyId,expectedSelectionVersion:view.version,taxResidency:'knowledge_worker',numChildren:3});
  expect(await resolve()).toMatchObject({scheme:'knowledge_worker'});
  const [p]=await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId));expect(p.taxResidency).toBe('resident');expect(p.numChildren).toBe(3);
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'employee.tax-scheme.selected'));expect(events.some(x=>x.subjectEmploymentId===e.employmentId&&(x.payload as {after?:{scheme?:string}}).after?.scheme==='knowledge_worker')).toBe(true);
 });
 it.each(['rep','knowledge_worker'])('unambiguous legacy %s converts once without declaration and human normal save supersedes it',async scheme=>{
  await legacy(scheme,false);const first=await getTaxSelectionMY(adminCtx(b),e.employmentId);expect(first).toMatchObject({scheme,transitionState:'resolved',version:1});
  await owner.db.update(schema.employeeStatutoryMy).set({taxResidency:'non_resident'}).where(eq(schema.employeeStatutoryMy.personId,e.personId));expect(await getTaxSelectionMY(adminCtx(b),e.employmentId)).toEqual(first);
  await save('resident');expect(await resolve()).toMatchObject({scheme:'resident',selectionVersion:2});
 });
 it('default normal plus applicable declaration asks one confirmation; archived evidence cannot keep gating after explicit choice',async()=>{
  const id=await declaration();await legacy('resident');
  const first=await getTaxSelectionMY(adminCtx(b),e.employmentId);expect(first.transitionState).toBe('confirmation_required');
  await expect(resolve()).rejects.toMatchObject({name:'TaxSelectionError',code:'confirmation_required'});
  const before=await owner.db.select().from(schema.employmentTaxSchemeMy);await save('rep');expect(await resolve()).toMatchObject({scheme:'rep'});expect(await owner.db.select().from(schema.employmentTaxSchemeMy)).toEqual(before);
  await owner.db.update(schema.employmentTaxSchemeMy).set({archivedAt:new Date()}).where(eq(schema.employmentTaxSchemeMy.id,id));expect(await resolve()).toMatchObject({scheme:'rep'});
 });
 it('archived old declaration does not generate a transition conflict or choose an incentive',async()=>{
  const id=await declaration();await owner.db.update(schema.employmentTaxSchemeMy).set({archivedAt:new Date()}).where(eq(schema.employmentTaxSchemeMy.id,id));await legacy('resident');expect(await getTaxSelectionMY(adminCtx(b),e.employmentId)).toMatchObject({scheme:'resident',transitionState:'resolved'});
 });
 it('conflicting legacy REP and KW evidence needs same-field confirmation, then declaration never overrides direct nonresident',async()=>{
  await declaration('knowledge_worker');await legacy('rep');expect((await getTaxSelectionMY(adminCtx(b),e.employmentId)).transitionState).toBe('confirmation_required');await save('non_resident');expect(await resolve()).toMatchObject({scheme:'non_resident'});
 });
 it('new second employment never inherits person REP automatically and cannot affect first employer selection',async()=>{
  await save('rep');const second=await hireEmployee(adminCtx(b),{person:{id:e.personId},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-02-01'});
  expect(await getTaxSelectionMY(adminCtx(b),second.employmentId)).toMatchObject({scheme:'resident',transitionState:'resolved'});expect(await resolve()).toMatchObject({scheme:'rep'});
 });
 it('real app role cannot rewrite owner identity, provenance or remove authority',async()=>{
  const row=await save('rep');
  for(const query of [sql`UPDATE employment_tax_selection_my SET company_id=${randomUUID()}::uuid WHERE id=${row.id}::uuid`,sql`UPDATE employment_tax_selection_my SET provenance='{}'::jsonb WHERE id=${row.id}::uuid`,sql`DELETE FROM employment_tax_selection_my WHERE id=${row.id}::uuid`])await expect(withTenant(adminCtx(b),tx=>tx.execute(query))).rejects.toBeDefined();
  expect(await resolve()).toMatchObject({scheme:'rep',selectionVersion:2});
 });
 it('different tenant and ordinary employee cannot read or save another context through real app role',async()=>{
  const foreign=await seedBase();expect(await withTenant(adminCtx(foreign),tx=>tx.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId)))).toEqual([]);
  await expect(saveTaxSelectionMY(adminCtx(foreign),{employmentId:e.employmentId,expectedCompanyId:b.companyId,scheme:'rep'})).rejects.toMatchObject({code:'not_found'});
  const userId=await createAppUser(b.tenantId,e.personId,'employee');const ctx={...adminCtx(b),userId,roles:['employee'] as ('employee')[],employmentId:e.employmentId,adminCompanyIds:[]};
  await expect(getTaxSelectionMY(ctx,e.employmentId)).rejects.toMatchObject({code:'not_found'});await expect(saveTaxSelectionMY(ctx,{employmentId:e.employmentId,expectedCompanyId:b.companyId,scheme:'rep'})).rejects.toMatchObject({code:'not_found'});
 });
 it('migration conversion is deterministic and rerunning it cannot overwrite the later human choice',async()=>{
  await declaration();await legacy('resident');
  const source=fs.readFileSync(path.resolve(__dirname,'../db/migrations/0505_employment_tax_selection_my.sql'),'utf8');
  const marker=source.indexOf('WITH contexts AS');expect(marker).toBeGreaterThan(0);
  const conversion=source.slice(marker);expect(conversion.length).toBeGreaterThan(1000);
  await owner.db.execute(sql.raw(conversion));expect((await getTaxSelectionMY(adminCtx(b),e.employmentId)).transitionState).toBe('confirmation_required');
  const selected=await save('knowledge_worker');await owner.db.execute(sql.raw(conversion));expect(await resolve()).toMatchObject({scheme:'knowledge_worker',selectionId:selected.id,selectionVersion:selected.version});
 });
 it('historical batch requires dated membership and both-employer visibility without changing the new employer selection',async()=>{
  const batch=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:'2026-10'});
  const later=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:'2026-12'});
  const [destination]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Synthetic destination',country:'MY'}).returning({id:schema.company.id});
  await owner.db.update(schema.assignment).set({validTo:'2026-11-01'}).where(eq(schema.assignment.employmentId,e.employmentId));await owner.db.update(schema.employment).set({companyId:destination.id}).where(eq(schema.employment.id,e.employmentId));
  await expect(getTaxSelectionMY(adminCtx(b),e.employmentId,later.batchId)).rejects.toMatchObject({code:'not_found'});
  const historical=await getTaxSelectionMY(adminCtx(b),e.employmentId,batch.batchId);
  await saveTaxSelectionMY(adminCtx(b),{employmentId:e.employmentId,expectedCompanyId:b.companyId,payrollBatchId:batch.batchId,expectedPayPeriod:'2026-10',expectedVersion:historical.version,scheme:'rep'});
  expect(await getTaxSelectionMY(adminCtx(b),e.employmentId,batch.batchId)).toMatchObject({companyId:b.companyId,scheme:'rep'});
  const current=await getTaxSelectionMY(adminCtx(b),e.employmentId);expect(current.companyId).toBe(destination.id);expect(current.scheme).not.toBe('rep');
  const userId=await createAppUser(b.tenantId,e.personId,'employee');await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,companyId:b.companyId,role:'hr_admin'});
  const outgoing:SessionContext={tenantId:b.tenantId,userId,grants:[{role:'hr_admin',companyId:b.companyId}],entitlements:adminCtx(b).entitlements};
  await expect(getTaxSelectionMY(outgoing,e.employmentId,batch.batchId)).rejects.toMatchObject({code:'not_found'});
  expect(await withTenant(outgoing,tx=>tx.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId)))).toEqual([]);
  await expect(withTenant(outgoing,tx=>tx.update(schema.employmentTaxSelectionMy).set({scheme:'knowledge_worker',version:historical.version+2,updatedAt:sql`now()`,updatedByUserId:userId}).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId)).returning())).resolves.toEqual([]);
 });
 it('app-role insert cannot claim another tenant/company or forged actor even with a valid scheme',async()=>{
  await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
  const foreign=await seedBase();const raw=(extra:Partial<typeof schema.employmentTaxSelectionMy.$inferInsert>)=>withTenant(adminCtx(b),tx=>tx.insert(schema.employmentTaxSelectionMy).values({tenantId:b.tenantId,employmentId:e.employmentId,companyId:b.companyId,scheme:'rep',transitionState:'resolved',source:'explicit',provenance:{reason:'synthetic',declarationIds:[]},updatedByUserId:b.adminUserId,...extra}));
  for(const extra of [{tenantId:foreign.tenantId},{companyId:foreign.companyId},{updatedByUserId:foreign.adminUserId}])await expect(raw(extra)).rejects.toMatchObject({cause:{code:'42501'}});
  await raw({});expect(await resolve()).toMatchObject({scheme:'rep'});
 });

 it('same-scheme overlapping legacy declarations require confirmation in both eager and lazy conversion',async()=>{
  await declaration();
  await owner.db.execute(sql`ALTER TABLE employment_tax_scheme_my DROP CONSTRAINT employment_tax_scheme_my_no_overlap`);
  try{
   await owner.db.insert(schema.employmentTaxSchemeMy).values({tenantId:b.tenantId,employmentId:e.employmentId,companyId:b.companyId,scheme:'rep',validFrom:'2026-03',validTo:'2026-05',approvalReference:'SYNTHETIC-LEGACY-OVERLAP',declaredByUserId:b.adminUserId});
   await legacy('rep');expect((await getTaxSelectionMY(adminCtx(b),e.employmentId)).transitionState).toBe('confirmation_required');
   await owner.db.delete(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.employmentId,e.employmentId));
   const source=fs.readFileSync(path.resolve(__dirname,'../db/migrations/0505_employment_tax_selection_my.sql'),'utf8');await owner.db.execute(sql.raw(source.slice(source.indexOf('WITH contexts AS'))));
   expect((await getTaxSelectionMY(adminCtx(b),e.employmentId)).transitionState).toBe('confirmation_required');
  }finally{
   await owner.db.delete(schema.employmentTaxSchemeMy).where(eq(schema.employmentTaxSchemeMy.employmentId,e.employmentId));
   await owner.db.execute(sql`ALTER TABLE employment_tax_scheme_my ADD CONSTRAINT employment_tax_scheme_my_no_overlap EXCLUDE USING gist (tenant_id WITH =,employment_id WITH =,company_id WITH =,int4range((left(valid_from,4)::integer*12+right(valid_from,2)::integer),(left(valid_to,4)::integer*12+right(valid_to,2)::integer+1),'[)') WITH &&) WHERE (archived_at IS NULL)`);
  }
 });

});
