import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import {withSystemLabelCompanyTx} from '../core/system-label-selection';
import * as s from '../db/schema';
import {createCompany,createJobGrade,createDepartment} from '../core/admin';
import {createGradeGroup} from '../packs/leave/service';
import {hireEmployee} from '../core/org';
import {listProfileOptions,createProfileOption} from '../core/profile-options';
import {downloadSystemLabelsWithData,previewSystemLabelImport,applySystemLabelImport} from '../core/system-label-import';
import {buildSystemLabelWorkbook,readSystemLabelWorkbook} from '../lib/system-label-workbook';
import {LABEL_IMPORT_DEFINITIONS} from '../lib/system-label-definition';
let b:Base;
const book=(rows:Record<string,Record<string,string>[]>)=>buildSystemLabelWorkbook({kinds:Object.keys(rows),rows,includeStatus:true,references:{companies:[],grades:[],employees:[]}});
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
describe('Company-aware System Labels imports and canonical consumers',()=>{
 it('keeps bounded native grade readers usable without exposing another company scope',async()=>{
  const other=await createCompany(adminCtx(b),{legalName:'Other reader company'});
  const global=await createJobGrade(adminCtx(b),{code:'READER_GLOBAL',name:'Reader global'});
  const own=await createJobGrade(adminCtx(b),{code:'READER_OWN',name:'Reader own',scopeCompanyIds:[b.companyId]});
  const hidden=await createJobGrade(adminCtx(b),{code:'READER_HIDDEN',name:'Reader hidden',scopeCompanyIds:[other.id]});
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${b.adminUserId},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:b.companyId}])},true)`);
   for(const role of ['ai_hr_architecture_grade_guard','ai_hr_reward_setup_reader','ai_hr_reward_upload_reader','ai_hr_rewards_post_reader']){
    await tx.execute(sql.raw('set local role '+role));
    const rows=await tx.execute<{id:string}>(sql`select id from public.job_grade where tenant_id=${b.tenantId}::uuid and id=any(array[${global.id}::uuid,${own.id}::uuid,${hidden.id}::uuid]) order by code`);
    expect(rows.map(r=>r.id),role).toEqual([global.id,own.id]);
    await tx.execute(sql`reset role`);
   }
   // The draft port's own table predicates remain authoritative; only its new policy helper is callable.
   await tx.execute(sql`set local role ai_hr_draft_discard_port`);
   const [scope]=await tx.execute<{global:boolean;own:boolean;hidden:boolean}>(sql`select app.system_label_scope_read(null::uuid[]) as global,app.system_label_scope_read(array[${b.companyId}::uuid]) as own,app.system_label_scope_read(array[${other.id}::uuid]) as hidden`);
   expect(scope).toEqual({global:true,own:true,hidden:false});
  });
 });
 it('reserves global catalogue mutations for group administrators across canonical writers',async()=>{
  const ctx={...adminCtx(b),grants:[{role:'hr_admin',companyId:b.companyId}]};
  const global=await createProfileOption(adminCtx(b),{category:'division',value:'GLOBAL_RETAINED'});
  await expect(createProfileOption(ctx,{category:'division',value:'GLOBAL_DENIED'})).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(createJobGrade(ctx,{code:'GLOBAL_DENIED',name:'Global denied'})).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(createGradeGroup(ctx,{name:'Global denied'})).rejects.toMatchObject({cause:{code:'42501'}});
  await withTenant(ctx,async tx=>{
   expect(await tx.update(s.profileOption).set({label:'Forbidden edit'}).where(eq(s.profileOption.id,global.id)).returning({id:s.profileOption.id})).toEqual([]);
   expect(await tx.delete(s.profileOption).where(eq(s.profileOption.id,global.id)).returning({id:s.profileOption.id})).toEqual([]);
  });
  expect((await owner.db.select().from(s.profileOption).where(eq(s.profileOption.id,global.id)))[0]).toMatchObject({value:'GLOBAL_RETAINED',label:'GLOBAL_RETAINED'});
  const own=await createProfileOption(ctx,{category:'division',value:'COMPANY_ALLOWED',scopeCompanyIds:[b.companyId]});
  const grade=await createJobGrade(ctx,{code:'COMPANY_ALLOWED',name:'Company allowed',scopeCompanyIds:[b.companyId]});
  const group=await createGradeGroup(ctx,{name:'Company allowed',gradeIds:[grade.id],scopeCompanyIds:[b.companyId]});
  expect(own.id).toBeTruthy();expect(group.id).toBeTruthy();
 });
 it('imports blank scope as global without requiring an entered owner',async()=>{
  const bytes=await book({department:[{Code:'BLANK_GLOBAL',Label:'Global department',Status:'Active'}]}),preview=await previewSystemLabelImport(adminCtx(b),bytes);
  expect(preview.rows[0]).toMatchObject({outcome:'add',after:{Criteria:'global','Criteria Companies':''}});
  expect(preview.rows[0].after.Company).toBeTruthy();
  await applySystemLabelImport(adminCtx(b),{bytes,token:preview.token});
  expect(await owner.db.select({global:s.department.isGlobal}).from(s.department).where(eq(s.department.name,'BLANK_GLOBAL'))).toEqual([{global:true}]);
 });
 it('imports and exports each of the 23 categories with company-only scope',async()=>{
  const data=Object.fromEntries(LABEL_IMPORT_DEFINITIONS.map((d,i)=>[d.kind,[{Code:`NEW_${i}`,Name:'Fictional scoped group',Label:`Fictional ${i}`,Description:'Fictional description',Company:b.companyId,Status:'Active'}]]));
  const bytes=await book(data),preview=await previewSystemLabelImport(adminCtx(b),bytes);
  expect(preview.rows.map(r=>({kind:r.sheet,result:r.outcome,message:r.message}))).toEqual(LABEL_IMPORT_DEFINITIONS.map(d=>({kind:d.kind,result:'add',message:'Valid new code.'})));
  expect(await applySystemLabelImport(adminCtx(b),{bytes,token:preview.token})).toMatchObject({imported:23,failed:0,skipped:0});
  const exported=readSystemLabelWorkbook(await downloadSystemLabelsWithData(adminCtx(b),{companyIds:[b.companyId],kinds:LABEL_IMPORT_DEFINITIONS.map(d=>d.kind),includeInactive:true}));
  for(const [i,d]of LABEL_IMPORT_DEFINITIONS.entries()){
   const row=exported.find(r=>r.sheet===d.kind&&(d.kind==='grade_groups'?r.values.Name==='Fictional scoped group':r.values.Code===`NEW_${i}`));
   expect(row?.values).toMatchObject({Criteria:'companies','Criteria Companies':expect.any(String),Status:'Active'});
  }
 });
 it('filters profile choices by the target company and refuses a scoped grade in another company',async()=>{
  const other=await createCompany(adminCtx(b),{legalName:'Fictional other company'});
  const department=await createDepartment(adminCtx(b),{companyId:other.id,name:'Fictional scoped grade department'});
  await createProfileOption(adminCtx(b),{category:'division',value:'SCOPED',scopeCompanyIds:[b.companyId]});
  expect((await listProfileOptions(adminCtx(b),'division',{activeOnly:true,companyId:b.companyId})).map(r=>r.value)).toContain('SCOPED');
  expect((await listProfileOptions(adminCtx(b),'division',{activeOnly:true,companyId:other.id})).map(r=>r.value)).not.toContain('SCOPED');
  expect((await listProfileOptions(adminCtx(b),'division',{activeOnly:true})).map(r=>r.value)).not.toContain('SCOPED');
  const grade=await createJobGrade(adminCtx(b),{code:'SCOPE_GRADE',name:'Scoped grade',scopeCompanyIds:[b.companyId]});
  await expect(hireEmployee(adminCtx(b),{person:{fullName:'Fictional scope refusal',primaryEmail:'scope@example.invalid'},companyId:other.id,departmentId:department.id,gradeId:grade.id,hiredOn:'2026-01-01',employmentType:'full_time'})).rejects.toThrow('this company');
  await expect(createGradeGroup(adminCtx(b),{name:'Invalid global group',gradeIds:[grade.id]})).rejects.toThrow();
 });
 it('records failed and skipped rows without overwriting existing records',async()=>{
  await createProfileOption(adminCtx(b),{category:'division',value:'EXISTS',label:'Original'});
  const bytes=await book({division:[{Code:'EXISTS',Company:b.companyId},{Code:'INVALID',Company:'unknown'},{Code:'VALID',Company:b.companyId},{Code:'VALID',Company:b.companyId}]}),preview=await previewSystemLabelImport(adminCtx(b),bytes);
  // Board c074c6b8: the reason stays, and the row also names its exact check and column.
  expect(preview.rows.map(row=>[row.values.Code,row.outcome,row.reason??null,row.reasonDetail??null,row.reasonColumn??null])).toEqual([
   ['EXISTS','error','existing','existing','Code'],['INVALID','error','invalidCompany','companyNotPermitted','Company'],['VALID','add',null,null,null],['VALID','skip','duplicate','duplicate','Code']]);
  expect(await applySystemLabelImport(adminCtx(b),{bytes,token:preview.token})).toMatchObject({imported:1,skipped:1,failed:2,errorReport:expect.any(String)});
  const [original]=await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'EXISTS'));expect(original.label).toBe('Original');
  const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'system-label-import.applied'));
  expect(events).toHaveLength(1);expect((events[0].payload as {rows:unknown[]}).rows).toHaveLength(4);
 });
 it('enforces company scope for raw employment writes and preserves unchanged historical values',async()=>{
  await createProfileOption(adminCtx(b),{category:'division',value:'ONLY_THIS',scopeCompanyIds:[b.companyId]});
  const other=await createCompany(adminCtx(b),{legalName:'Other operation company'});
  const department=await createDepartment(adminCtx(b),{companyId:other.id,name:'Fictional raw scope department'});
  const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional employee',primaryEmail:'company-guard@example.invalid'},companyId:other.id,departmentId:department.id,hiredOn:'2026-01-01',employmentType:'full_time'});
  await expect(withTenant(adminCtx(b),tx=>tx.update(s.employment).set({orgDivision:'ONLY_THIS'}).where(eq(s.employment.id,hired.employmentId)))).rejects.toThrow();
  await owner.db.update(s.employment).set({orgDivision:'ONLY_THIS'}).where(eq(s.employment.id,hired.employmentId));
  await withTenant(adminCtx(b),tx=>tx.update(s.employment).set({orgDivision:'ONLY_THIS'}).where(eq(s.employment.id,hired.employmentId)));
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,hired.employmentId)))[0].orgDivision).toBe('ONLY_THIS');
 });
 it('binds context-free catalogue validation to the owned operation and restores it after failure',async()=>{
  await createProfileOption(adminCtx(b),{category:'division',value:'OPERATION_SCOPED',scopeCompanyIds:[b.companyId]});
  await withTenant(adminCtx(b),async tx=>{
   const allowed=async()=>{const [row]=await tx.execute<{allowed:boolean}>(sql`select app.profile_option_value_allowed('division','OPERATION_SCOPED',null) as allowed`);return row.allowed;};
   expect(await allowed()).toBe(false);
   await withSystemLabelCompanyTx(tx,b.companyId,async()=>expect(await allowed()).toBe(true));
   expect(await allowed()).toBe(false);
   await expect(withSystemLabelCompanyTx(tx,b.companyId,async()=>{throw new Error('Fictional validation refusal');})).rejects.toThrow('Fictional validation refusal');
   expect(await allowed()).toBe(false);
  });
 });
 it('refuses blank global imports for a real company administrator and permits their own company input',async()=>{
  const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'fictional-scoped-label-admin'}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
  const ctx={...adminCtx(b),userId:user.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const bytes=await book({department:[{Code:'SCOPED_ADMIN_GLOBAL'},{Code:'SCOPED_ADMIN_OWN',Company:b.companyId}]}),preview=await previewSystemLabelImport(ctx,bytes);
  expect(preview.rows[0]).toMatchObject({outcome:'error',reason:'globalAdminRequired'});
  expect(preview.rows[1]).toMatchObject({outcome:'add',after:{Criteria:'companies'}});
  expect(await applySystemLabelImport(ctx,{bytes,token:preview.token})).toMatchObject({imported:1,failed:1});
  expect(await owner.db.select().from(s.department).where(eq(s.department.name,'SCOPED_ADMIN_GLOBAL'))).toHaveLength(0);
 });
 it('rejects foreign-tenant company arrays at the canonical writer',async()=>{
  await expect(createProfileOption(adminCtx(b),{category:'religion',value:'FOREIGN',scopeCompanyIds:['00000000-0000-4000-8000-000000000999']})).rejects.toThrow();
  expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'FOREIGN'))).toEqual([]);
 });
});
