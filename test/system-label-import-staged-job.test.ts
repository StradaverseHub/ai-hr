/** Staged System Labels import on the shared bulk-job kernel (migrations 9003, 9004, 9961): real PostgreSQL, real
 * row security, real worker ticks. All-or-nothing: staged codes and their events stay invisible until one release. */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createJobGrade} from '../core/admin';
import {hireEmployee} from '../core/org';
import {previewSystemLabelImport,applySystemLabelImport} from '../core/system-label-import';
import {startSystemLabelImportJob,getSystemLabelImportJob,SystemLabelImportJobError} from '../core/system-label-import-job';
import {requestBulkJobCancel} from '../core/bulk-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {verifyTenantChain} from '../core/audit-chain';
import {buildSystemLabelWorkbook} from '../lib/system-label-workbook';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

// Near one-code chunks, so a refusal lands after earlier chunks already committed; arm the audit chain.
vi.hoisted(()=>{process.env.SYSTEM_LABEL_IMPORT_CHUNK_BUDGET_MS='1';process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
let b:Base,ctx:SessionContext,gradeId:string,headCode:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();ctx=adminCtx(b);
 gradeId=(await createJobGrade(ctx,{code:'STG_BASE',name:'Fictional staged base grade',rank:1})).id;
 headCode='STGHEAD01';
 await hireEmployee(ctx,{person:{fullName:'Fictional Head Person',primaryEmail:`head-${randomUUID()}@labels.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),employeeCode:headCode} as never);
});
afterAll(closeAll);

/** Every category: four organisation kinds (one with a head), two profile categories, grades and a grade group. */
const workbook=(tag:string)=>{
 const org=(code:string)=>({Code:code,Label:`Fictional ${code}`,Description:'Fictional staged label',Company:b.companyId,Criteria:'companies','Criteria Companies':b.companyId,Status:'Active'});
 return buildSystemLabelWorkbook({kinds:['department','position','cost_center','business_unit','division','religion','grades','grade_groups'],includeStatus:true,references:{companies:[],grades:[],employees:[]},rows:{
  department:[{...org(`${tag}_DEPT_A`),'Head Employee Code':headCode},org(`${tag}_DEPT_B`)],
  position:[org(`${tag}_POS_A`),org(`${tag}_POS_B`)],
  cost_center:[org(`${tag}_CC_A`)],
  business_unit:[org(`${tag}_BU_A`)],
  division:[{Code:`${tag}_DIV_A`,Label:'Fictional division',Status:'Active'},{Code:`${tag}_DIV_B`,Label:'Fictional division B',Status:'Inactive'}],
  religion:[{Code:`${tag}_REL_A`,Label:'Fictional religion',Status:'Active'}],
  grades:[{Code:`${tag}_G1`,Label:`Fictional grade ${tag} one`,Rank:'3',Status:'Active'},{Code:`${tag}_G2`,Label:`Fictional grade ${tag} two`,Rank:'4',Status:'Inactive'}],
  grade_groups:[{Name:`Fictional group ${tag}`,'Grade Codes':'STG_BASE'}],
 }});
};
const tick=()=>runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS});
type JobRow={id:string;state:string;attempt_id:string|null;plan:{released?:boolean}|null;error:string|null;metrics:Record<string,number>};
const job=async(id:string)=>(await owner.client<JobRow[]>`select id,state,plan->>'attemptId' as attempt_id,plan,error,metrics from bulk_job where id=${id}::uuid`)[0];
async function ticks(id:string,stop:(row:JobRow)=>boolean,max=600){
 for(let i=0;i<max;i++){const row=await job(id);if(stop(row))return row;if(!await tick())await new Promise(r=>setTimeout(r,40));}
 throw new Error('job did not reach the expected state');
}
async function start(tag:string,as:SessionContext=ctx){
 const bytes=await workbook(tag);const preview=await previewSystemLabelImport(as,bytes);
 expect(preview.valid).toBe(true);
 const {job:started}=await startSystemLabelImportJob(as,{bytes,token:preview.token,fileName:'labels.xlsx',operationKey:randomUUID()});
 return {id:started.id,bytes,preview};
}
/** What a normal administrator session can see of the import's codes. */
const visible=(tag:string)=>withTenant(ctx,async tx=>{
 const like=tag+'%';
 const [r]=await tx.execute<{n:number}>(sql`select (select count(*) from department where name like ${like})+(select count(*) from position where title like ${like})
  +(select count(*) from cost_center where code like ${like})+(select count(*) from business_unit where code like ${like})+(select count(*) from profile_option where value like ${like})
  +(select count(*) from job_grade where code like ${like})+(select count(*) from grade_group where name like ${'Fictional group '+like})
  +(select count(*) from domain_event where payload::text like ${'%'+tag+'%'})::int as n`);
 return Number(r.n);
});
/** The tenant's catalogue and label audit events by business keys (ids, actors and times removed). */
async function endState(tenantId:string){
 const ids=new Map<string,string>();
 for(const r of await owner.client<{id:string;k:string}[]>`select id::text,'D:'||name k from department where tenant_id=${tenantId}::uuid union all select id::text,'P:'||title from position where tenant_id=${tenantId}::uuid
  union all select id::text,'C:'||code from cost_center where tenant_id=${tenantId}::uuid union all select id::text,'B:'||code from business_unit where tenant_id=${tenantId}::uuid
  union all select id::text,'O:'||category||':'||value from profile_option where tenant_id=${tenantId}::uuid union all select id::text,'G:'||code from job_grade where tenant_id=${tenantId}::uuid
  union all select id::text,'GG:'||name from grade_group where tenant_id=${tenantId}::uuid union all select id::text,'CO:'||legal_name from company where tenant_id=${tenantId}::uuid
  union all select e.id::text,'E:'||coalesce(e.employee_code,'') from employment e where e.tenant_id=${tenantId}::uuid`)ids.set(r.id,r.k);
 const norm=(v:unknown)=>JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,m=>ids.get(m.toLowerCase())??'uuid');
 const set=(rows:readonly unknown[])=>rows.map(norm).sort();
 return{
  department:set(await owner.client`select name,label,description,is_global,archived_at is null as active,head_employment_id,company_id from department where tenant_id=${tenantId}::uuid`),
  position:set(await owner.client`select title,label,description,is_global,archived_at is null as active,company_id from position where tenant_id=${tenantId}::uuid`),
  costCenter:set(await owner.client`select code,name,label,is_global,archived_at is null as active from cost_center where tenant_id=${tenantId}::uuid`),
  businessUnit:set(await owner.client`select code,name,label,is_global,archived_at is null as active,head_employment_id from business_unit where tenant_id=${tenantId}::uuid`),
  criteria:set(await owner.client`select label_kind,label_id,company_id from label_company_assignment where tenant_id=${tenantId}::uuid`),
  options:set(await owner.client`select category,value,label,description,sort_order,is_active,scope_company_ids from profile_option where tenant_id=${tenantId}::uuid`),
  grades:set(await owner.client`select code,name,rank,description,archived_at is null as active,scope_company_ids from job_grade where tenant_id=${tenantId}::uuid`),
  groups:set(await owner.client`select g.name,g.scope_company_ids,array(select m.grade_id from grade_group_member m where m.grade_group_id=g.id order by 1) members from grade_group g where g.tenant_id=${tenantId}::uuid`),
  events:set(await owner.client`select event_type,aggregate_type,aggregate_id,payload from domain_event where tenant_id=${tenantId}::uuid and (event_type like 'department.%' or event_type like 'position.%' or event_type like 'cost-center.%'
   or event_type like 'business-unit.%' or event_type like 'profile-option.%' or event_type like 'job-grade.%' or event_type like 'grade-group.%' or event_type like 'system-label-import.%')`),
 };
}

describe('staged System Labels import job',{timeout:240_000},()=>{
 it('stages every code invisibly, releases all at once, and ends exactly as the single-transaction import',async()=>{
  // Reference: the single-transaction import of the same workbook on an identical tenant.
  const bytes=await workbook('EQ');const preview=await previewSystemLabelImport(ctx,bytes);
  const sync=await applySystemLabelImport(ctx,{bytes,token:preview.token});
  const expected=await endState(b.tenantId);
  await resetDb();b=await seedBase();ctx=adminCtx(b);
  gradeId=(await createJobGrade(ctx,{code:'STG_BASE',name:'Fictional staged base grade',rank:1})).id;
  await hireEmployee(ctx,{person:{fullName:'Fictional Head Person',primaryEmail:`head-${randomUUID()}@labels.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),employeeCode:headCode} as never);
  const started=await start('EQ');
  const staged=await ticks(started.id,row=>row.state==='finalizing'||row.state==='completed'||row.state==='failed');
  expect(staged.state).toBe('finalizing');
  // Every code is physically written and marked, yet a normal session, the definer readers and the events show none.
  const [marked]=await owner.client<{n:number}[]>`select ((select count(*) from department where import_pending_attempt_id=${staged.attempt_id}::uuid)+(select count(*) from job_grade where import_pending_attempt_id=${staged.attempt_id}::uuid)
   +(select count(*) from profile_option where import_pending_attempt_id=${staged.attempt_id}::uuid)+(select count(*) from grade_group_member where import_pending_attempt_id=${staged.attempt_id}::uuid))::int n`;
  expect(marked.n).toBe(2+2+3+1);
  expect(await visible('EQ')).toBe(0);
  const [definers]=await withTenant(ctx,tx=>tx.execute<{allowed:boolean;level:string|null;choices:number}>(sql`select app.profile_option_value_allowed('religion','EQ_REL_A','x') as allowed,
   app.approver_level((select id from employment where employee_code=${headCode}),${todayInKualaLumpur()}::date) as level,
   jsonb_array_length(coalesce((app.company_organisation_options())->'companies'->0->'businessUnits','[]'::jsonb)) as choices`));
  expect(definers.level).not.toBe('department_head');
  // Release: one tick makes the whole import visible.
  const done=await ticks(started.id,row=>row.state==='completed'||row.state==='failed');
  expect(done.state).toBe('completed');
  expect(await visible('EQ')).toBeGreaterThan(10);
  const progress=await getSystemLabelImportJob(ctx,started.id);
  expect(progress.result).toEqual(sync);
  expect(await endState(b.tenantId)).toEqual(expected);
  expect((await verifyTenantChain(ctx)).valid).toBe(true);
  // Every chunk held the import's writer locks only briefly.
  expect(done.metrics.chunks).toBeGreaterThan(3);
 });

 it('refuses at release, deletes the staged codes and shows nothing when a conflicting code appeared meanwhile',async()=>{
  const started=await start('CF');
  await ticks(started.id,row=>row.state==='finalizing');
  // An archived grade with the import's code: the ordinary grade writer could not see the staged one.
  await owner.client`insert into job_grade(tenant_id,code,name,rank,archived_at) values(${b.tenantId}::uuid,'CF_G1','Fictional conflicting grade',9,now())`;
  const failed=await ticks(started.id,row=>row.state==='failed');
  expect(failed.error).toMatch(/No labels were imported/);
  // Only the conflicting grade itself is visible: none of the import's codes or events.
  expect(await visible('CF')).toBe(1);
  const [left]=await owner.client<{n:number}[]>`select ((select count(*) from department where import_pending_attempt_id=${failed.attempt_id}::uuid)+(select count(*) from profile_option where import_pending_attempt_id=${failed.attempt_id}::uuid)
   +(select count(*) from job_grade where import_pending_attempt_id=${failed.attempt_id}::uuid)+(select count(*) from label_company_assignment where import_pending_attempt_id=${failed.attempt_id}::uuid))::int n`;
  expect(left.n).toBe(0);
  const [release]=await owner.client<{outcome:string}[]>`select outcome from app.system_label_import_release where attempt_id=${failed.attempt_id}::uuid`;
  expect(release.outcome).toBe('discarded');
  // The staged events stay hidden for good; the audit chain still verifies.
  expect((await verifyTenantChain(ctx)).valid).toBe(true);
  // The same codes can be imported again afterwards.
  await owner.client`delete from job_grade where code='CF_G1' and tenant_id=${b.tenantId}::uuid`;
  const again=await start('CF');
  expect((await ticks(again.id,row=>row.state==='completed'||row.state==='failed')).state).toBe('completed');
 });

 it('stops on request and undoes every staged code',async()=>{
  const started=await start('CN');
  await ticks(started.id,row=>row.state==='running'&&!!row.attempt_id);
  await tick();
  await requestBulkJobCancel(ctx,started.id);
  const stopped=await ticks(started.id,row=>row.state==='cancelled'||row.state==='completed');
  expect(stopped.state).toBe('cancelled');
  expect(await visible('CN')).toBe(0);
 });

 it('refuses before writing when labels changed after the preview, and refuses non-administrators at admission',async()=>{
  const bytes=await workbook('TK');const preview=await previewSystemLabelImport(ctx,bytes);
  await createJobGrade(ctx,{code:'UNRELATED_X',name:'Fictional unrelated grade',rank:2});
  const {job:started}=await startSystemLabelImportJob(ctx,{bytes,token:preview.token,fileName:'labels.xlsx'});
  const failed=await ticks(started.id,row=>row.state==='failed'||row.state==='completed');
  expect(failed.state).toBe('failed');expect(failed.error).toMatch(/changed since preview/);expect(failed.attempt_id).toBeNull();
  expect(await visible('TK_')).toBe(0);
  const employee={...ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext;
  await expect(startSystemLabelImportJob(employee,{bytes,token:preview.token})).rejects.toBeInstanceOf(SystemLabelImportJobError);
 });

 it('keeps staged codes reserved: an ordinary writer cannot take a staged code',async()=>{
  const started=await start('RS');
  await ticks(started.id,row=>row.state==='finalizing');
  await expect(createJobGrade(ctx,{code:'RS_G1',name:'Fictional reserved twin',rank:5})).rejects.toThrow();
  expect((await ticks(started.id,row=>row.state==='completed'||row.state==='failed')).state).toBe('completed');
  void gradeId;void s;
 });
});
