/** Query-local native audit membership probe; no installed RLS, index or application change. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq,sql,type SQL} from 'drizzle-orm';
import * as s from '../db/schema';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {withPayrollTenant} from '../core/module-gate';
import {hireEmployee,setReportingLine} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {closeBatch,createBatch,generatePayslips} from '../core/payroll';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {runInputsTx} from '../core/payroll-audit/inputs';
import {lockPayComponentCatalogReadTx} from '../core/pay-component-catalog-lock';
import {lockNativePayrollBatchPeriodTx} from '../core/payroll-period-lock';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const policyState=()=>owner.db.execute(sql`select polname,polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid) as qual,pg_get_expr(polwithcheck,polrelid) as check_expr from pg_policy where polrelid='public.payslip'::regclass order by polname`);
async function withProbe<T>(fn:()=>Promise<T>){
 const before=Array.from(await policyState());expect(before.map(p=>p.polname)).toEqual(['payroll_history_effective_only','payroll_tax_basis_reader_guard','payslip_rls']);
 expect(before.map(p=>String(p.qual).replace(/\s+/g,''))).toEqual(['(app.payroll_history_effective(id)ORapp.payroll_history_self_issued(id))','app.payroll_tax_basis_reader_compatible(employment_id,batch_id)','((tenant_id=app.current_tenant_id())AND(app.can_admin_payroll_employment(employment_id)OR(EXISTS(SELECT1FROMemploymenteWHERE((e.id=payslip.employment_id)ANDapp.is_self_person(e.person_id))))))']);
 expect(before.map(p=>[p.polcmd,p.polpermissive])).toEqual([['r',false],['r',false],['*',true]]);expect(String(before[2].check_expr).replace(/\s+/g,'')).toBe('((tenant_id=app.current_tenant_id())ANDapp.can_admin_payroll_employment(employment_id))');
 const [catalog]=await owner.db.execute(sql`select array(select unnest(polroles)::regrole::text from pg_policy where polrelid='public.payslip'::regclass and polname<>'payslip_rls' order by polname) as roles,exists(select 1 from pg_constraint where conrelid='public.employment'::regclass and conname='employment_company_tenant_fk' and convalidated and pg_get_constraintdef(oid)='FOREIGN KEY (company_id, tenant_id) REFERENCES company(id, tenant_id)') as fk,exists(select 1 from pg_index where indexrelid='public.payslip_batch_employment_uq'::regclass and indisvalid and indisunique) as uq`);
 expect(catalog).toMatchObject({roles:['ai_hr_app','ai_hr_app'],fk:true,uq:true});expect(before[2].polroles).toBe('{0}');
 const [self]=await owner.db.execute(sql`select md5(prosrc) as hash,prosecdef,proowner::regrole::text as owner from pg_proc where oid='app.is_self_person(uuid)'::regprocedure`);
 expect(self).toMatchObject({hash:'3ede48808cf91f9a23f58dc504068fe9',prosecdef:true,owner:'postgres'});
 const expected=[['app.can_admin_payroll_employment(uuid)','296a916754bb3978e45b5e4ad641e8c1'],['app.payroll_history_effective(uuid)','77febf7562467db258f085d13373fcc1'],['app.payroll_history_self_issued(uuid)','1f3a3dfb5d6df0e2464c20049a5da3c1'],['app.payroll_tax_basis_reader_compatible(uuid,uuid)','c0f37ea5eb18e058d480b6449f245a12']];
 for(const [name,hash]of expected){const [row]=await owner.db.execute(sql`select md5(prosrc) as hash,prosecdef,proowner::regrole::text as owner from pg_proc where oid=to_regprocedure(${name})`);expect(row).toMatchObject({hash,prosecdef:true,owner:'postgres'});}
 let created=false;
 try{
  await owner.client.unsafe(`create function app.__perf_payroll_audit_members(wanted_batch uuid) returns uuid[] language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  declare result uuid[];
  begin
   if current_setting('app.payroll_tax_basis_reader',true) is distinct from '1' or app.current_tenant_id() is null or app.current_user_id() is null then return null;end if;
   -- Refusal-only caller hint. Missing/mismatched carrier goes through the unchanged native query.
   if not coalesce(app.current_roles() && ARRAY['hr_admin','super_admin','payroll_partner']::text[],false) then return null;end if;
   if not app.principal_snapshot_current() then return null;end if;
   with candidates as materialized (
    select s.id,s.employment_id,s.batch_id,e.company_id from public.payslip s
    join public.employment e on e.id=s.employment_id and e.tenant_id=app.current_tenant_id()
    where s.tenant_id=app.current_tenant_id() and s.batch_id=wanted_batch
   ), companies as materialized(select distinct company_id from candidates),
   coverage as materialized(select company_id from companies where app.can_admin_payroll_for(company_id))
   select coalesce(array_agg(c.employment_id order by c.employment_id),'{}'::uuid[]) into result
    from candidates c join coverage using(company_id)
    where (app.payroll_history_effective(c.id) or app.payroll_history_self_issued(c.id))
      and app.payroll_tax_basis_reader_compatible(c.employment_id,c.batch_id);
   return result;
  exception when invalid_text_representation or invalid_parameter_value then return null;
  end $$`);created=true;
  await owner.client.unsafe('revoke all on function app.__perf_payroll_audit_members(uuid) from public');await owner.client.unsafe('grant execute on function app.__perf_payroll_audit_members(uuid) to ai_hr_app');
  const [acl]=await owner.db.execute(sql`select not exists(select 1 from aclexplode(proacl) where grantee=0) as no_public,has_function_privilege('ai_hr_app',oid,'EXECUTE') as app_execute from pg_proc where oid='app.__perf_payroll_audit_members(uuid)'::regprocedure`);expect(acl).toMatchObject({no_public:true,app_execute:true});
  return await fn();
 }finally{if(created)await owner.client.unsafe('drop function app.__perf_payroll_audit_members(uuid)');expect(Array.from(await policyState())).toEqual(before);const [row]=await owner.db.execute(sql`select to_regprocedure('app.__perf_payroll_audit_members(uuid)') is null as removed`);expect(row.removed).toBe(true);}
}
const oldMembers=(batchId:string)=>sql`select s.employment_id from public.payslip s where s.batch_id=${batchId}::uuid`;
const newMembers=(batchId:string)=>sql`with opt as materialized(select app.__perf_payroll_audit_members(${batchId}::uuid) as ids)
 select unnest(ids) as employment_id from opt where ids is not null
 union all select s.employment_id from public.payslip s where s.batch_id=${batchId}::uuid and (select ids is null from opt)
 union all select own.employment_id from opt
 cross join lateral (
   select s.employment_id from app.principal(app.current_user_id()) p
   join public.employment e on e.person_id=p.person_id
   join lateral (
    select s.employment_id from public.payslip s
    where s.batch_id=${batchId}::uuid and s.employment_id=e.id and not (s.employment_id=any(opt.ids))
    offset 0
   ) s on true
   where p.tenant_id=app.current_tenant_id() and app.is_self_person(e.person_id) and opt.ids is not null
   offset 0
 ) own`;
const claims=(batchId:string,members:SQL)=>sql`select x.employment_id::text as e,count(*)::int as n,app.payroll_audit_hash(jsonb_agg(to_jsonb(x) order by x.id)::text) as h from (select c.* from public.claim_request c where c.payroll_batch_id=${batchId}::uuid or (c.employment_id in (${members}) and c.incurred_on between '2026-01-01'::date and '2026-01-31'::date)) x group by x.employment_id order by x.employment_id`;
const windows={attendance:{start:'2026-01-01',end:'2026-01-31'},overtime:{start:'2026-01-01',end:'2026-01-31'},leave:{start:'2026-01-01',end:'2026-01-31'},claim:{start:'2026-01-01',end:'2026-01-31'}};
async function paidRun(){
 const root=adminCtx(b),target=await hireEmployee(root,{person:{fullName:'Fictional audit-plan target',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'0007',employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(root,{employmentId:target.employmentId,basicSalary:3000,effectiveFrom:'2020-01-01'});await setStatutoryProfileMY(root,{personId:target.personId,icNumber:'900101015551',taxCategory:1,numChildren:0});
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-01'});await generatePayslips(root,{batchId});return{root,target,batchId};
}
async function members(tx:Tx,query:SQL){return Array.from(await tx.execute(sql`select employment_id from (${query}) m order by employment_id`)).map(row=>row.employment_id);}
async function compareMembers(ctx:SessionContext,batchId:string,expectedOptimized:boolean,configure?:(tx:Tx)=>Promise<unknown>){return withTenant(ctx,async tx=>{
 if(configure)await configure(tx);
 const [raw]=await tx.execute(sql`select app.__perf_payroll_audit_members(${batchId}::uuid) as ids`);
 const original=await members(tx,oldMembers(batchId)),candidate=await members(tx,newMembers(batchId));expect(candidate).toEqual(original);
 if(expectedOptimized){
  const exactAdmin=await members(tx,sql`${oldMembers(batchId)} and app.can_admin_payroll_employment(s.employment_id)`);
  expect(raw.ids).toEqual(exactAdmin);
 }else expect(raw.ids).toBeNull();return original;
});}
it.each(['small','sparse','dense'] as const)('compares exact owner hashes and native membership costs (%s)',async shape=>{
 const {root,target,batchId}=await paidRun();const {batchId:otherBatch}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-02'});
 const people=Array.from({length:1000},(_,index)=>({id:randomUUID(),employmentId:randomUUID(),name:'Fictional audit decoy '+index}));
 await owner.db.insert(s.person).values(people.map(p=>({id:p.id,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.id+'@example.invalid'})));await owner.db.insert(s.employment).values(people.map(p=>({id:p.employmentId,tenantId:b.tenantId,personId:p.id,companyId:b.companyId,hiredOn:'2020-01-01'})));
 // Isolated RLS/read-plan fixture only: clone an actually generated native row for member cardinality.
 // No trigger/RLS disabling and no claim that these clones are numerical payroll calculations.
 const [slip]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId));
 for(let offset=0;shape!=='small'&&offset<people.length;offset+=100)await owner.db.insert(s.payslip).values(people.slice(offset,offset+100).map(p=>({...slip,id:randomUUID(),employmentId:p.employmentId})));
 const [type]=await owner.db.insert(s.claimType).values({tenantId:b.tenantId,code:'AUDIT_PLAN',name:'Fictional audit input',requiresReceipt:false}).returning({id:s.claimType.id});
 const common={tenantId:b.tenantId,claimTypeId:type.id,amount:'1.23',description:'PRIVATE_FICTIONAL_AUDIT_INPUT'};
 const decoyCount=shape==='small'?0:20000;
 for(let offset=0;offset<decoyCount;offset+=500)await owner.db.insert(s.claimRequest).values(Array.from({length:500},(_,i)=>({...common,employmentId:people[(offset+i)%people.length].employmentId,incurredOn:shape==='dense'||(offset+i)%100===0?'2026-01-15':'2010-06-01',status:'draft' as const})));
 await owner.db.insert(s.claimRequest).values([
  {...common,employmentId:target.employmentId,incurredOn:'2026-01-01',status:'draft',fieldValues:{fixture:'boundary-start',number:12,empty:null}},
  {...common,employmentId:target.employmentId,incurredOn:'2026-01-31',status:'pending'},
  {...common,employmentId:target.employmentId,incurredOn:'2025-12-31',status:'paid',payrollBatchId:batchId,paidAt:new Date('2026-02-01T00:00:00Z')},
  {...common,employmentId:target.employmentId,incurredOn:'2026-01-15',status:'paid',payrollBatchId:batchId},
  {...common,employmentId:people[0].employmentId,incurredOn:'2025-12-31',status:'paid',payrollBatchId:batchId},
  {...common,employmentId:target.employmentId,incurredOn:'2026-01-15',status:'paid',payrollBatchId:otherBatch},
  {...common,employmentId:target.employmentId,incurredOn:'2026-02-01',status:'pending'},
 ]);
 for(const table of ['claim_request','payslip','person','employment','role_assignment','reporting_line'])await owner.client.unsafe('analyze public.'+table);
 const worker:SessionContext={...root,userId:await createAppUser(b.tenantId,target.personId,'employee'),personId:target.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]},foreign=adminCtx(await seedBase());
 const expected=new Map<string,{e:string;n:number;h:string}[]>(),receipts:unknown[]=[];
 const probe=async(phase:string,query:SQL)=>{for(const [actor,ctx,expectedRows]of [['admin',root,shape==='dense'?20006:shape==='sparse'?206:6],['ownEmployee',worker,5],['foreignTenant',foreign,0]]as const)await withPayrollTenant(ctx,async tx=>{
  await lockPayComponentCatalogReadTx(tx,ctx);await lockNativePayrollBatchPeriodTx(tx,ctx,batchId);await tx.execute(sql`select id from public.payroll_batch where id=${batchId}::uuid for update`);await tx.execute(sql`set local timezone='UTC'`);
  let elapsedMs=0,rows:{e:string;n:number;h:string}[]=[];
  for(let i=0;i<5;i++){const start=performance.now();rows=Array.from(await tx.execute(query)) as unknown as typeof rows;elapsedMs+=performance.now()-start;if(expected.has(actor))expect(rows).toEqual(expected.get(actor));else expected.set(actor,rows);}
  const hash=createHash('sha256');let total=0;for(const row of rows){total+=Number(row.n);hash.update(`${row.e}:${Number(row.n)}:${row.h}\n`);}expect(total).toBe(expectedRows);
  if(phase==='original'){const actual=await runInputsTx(tx,{batchId,payPeriod:'2026-01',windows});expect(actual.components.claims).toEqual({rows:total,hash:hash.digest('hex')});}
  const explain=await tx.execute(sql`explain(analyze,buffers,settings,format json) ${query}`);receipts.push({phase,actor,reads:5,elapsedMs,rows:total,explain});
 });};
 await probe('original',claims(batchId,oldMembers(batchId)));
 await withProbe(async()=>{await compareMembers(root,batchId,true);await compareMembers(worker,batchId,false);await compareMembers(foreign,batchId,false);await probe('candidate',claims(batchId,newMembers(batchId)));await probe('candidate-warm',claims(batchId,newMembers(batchId)));});
 await probe('restored-original',claims(batchId,oldMembers(batchId)));
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-audit-admin-members-'+shape+'.json'),JSON.stringify({kind:'REVERSIBLE_ORACLE_SAFE_QUERY_LOCAL_NATIVE_ADMIN_MEMBER_PROBE',releaseEligible:false,shape,decoyClaims:decoyCount,batchMembers:shape==='small'?1:1001,receipts,numericalPayrollCalculationClaim:false},null,2));
},600000);

it('preserves native scope, voided/malformed history, actual principal and legacy error boundaries',async()=>{
 const {root,target,batchId}=await paidRun();
 const actor=async(role:'hr_admin'|'payroll_partner'|'employee'|'manager',personId:string|null,companyId:string|null)=>{
  const [u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,personId,workosUserId:randomUUID()}).returning({id:s.appUser.id});
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role,companyId});
  return{...root,userId:u.id,personId,roles:[role],grants:[{role,companyId}]} satisfies SessionContext;
 };
 const scoped=await actor('hr_admin',null,b.companyId),partner=await actor('payroll_partner',null,b.companyId),worker=await actor('employee',target.personId,null);
 const manager=await hireEmployee(root,{person:{fullName:'Fictional audit manager',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await setReportingLine(root,{subordinateEmploymentId:target.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const managing=await actor('manager',manager.personId,null),other=await seedBase(),foreign=adminCtx(other);
 await withProbe(async()=>{
  expect(await compareMembers(scoped,batchId,true)).toEqual([target.employmentId]);expect(await compareMembers(partner,batchId,true)).toEqual([target.employmentId]);
  expect(await compareMembers(worker,batchId,false)).toEqual([target.employmentId]);expect(await compareMembers(managing,batchId,false)).toEqual([]);expect(await compareMembers(foreign,batchId,false)).toEqual([]);
  expect(await compareMembers(root,randomUUID(),true)).toEqual([]);
  await compareMembers({...worker,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},batchId,false);
  await compareMembers(root,batchId,false,tx=>tx.execute(sql`select set_config('app.payroll_tax_basis_reader','0',true)`));
  for(const malformed of ['{','null','{}','[{"role":"hr_admin","companyId":"invalid"}]'])await withTenant(root,async tx=>{
   await tx.execute(sql`select set_config('app.grants',${malformed},true)`);
   const [row]=await tx.execute(sql`select app.__perf_payroll_audit_members(${batchId}::uuid) as ids`);expect(row.ids).toBeNull();
   const outcome=async(query:SQL)=>{try{return{rows:await tx.transaction(sp=>members(sp as unknown as Tx,query))};}catch(error){const native=(error as {cause?:{code?:string;message?:string}}).cause;return{state:native?.code,message:native?.message};}};
   expect(await outcome(newMembers(batchId))).toEqual(await outcome(oldMembers(batchId)));
  });
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,scoped.userId));await compareMembers(scoped,batchId,false);
  expect(await compareMembers({...scoped,roles:[],grants:[]},batchId,false)).toEqual([]);
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,partner.userId));await compareMembers(partner,batchId,false);
  const [otherCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional moved company'}).returning({id:s.company.id});
  const [movedDepartment]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:otherCompany.id,name:'Fictional moved department'}).returning({id:s.department.id});
  const moved=await hireEmployee(root,{person:{fullName:'Fictional historically moved member',primaryEmail:randomUUID()+'@example.invalid'},companyId:otherCompany.id,departmentId:movedDepartment.id,employmentType:'full_time',hiredOn:'2020-01-01'});
  const [slip]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId));
  await owner.db.insert(s.payslip).values({...slip,id:randomUUID(),employmentId:moved.employmentId});
  const mixed=await actor('hr_admin',moved.personId,b.companyId);expect(await compareMembers(mixed,batchId,true)).toEqual([target.employmentId,moved.employmentId].sort());
  await owner.db.update(s.employment).set({voidedAt:new Date()}).where(eq(s.employment.id,moved.employmentId));
  expect(await compareMembers(root,batchId,true)).toEqual([target.employmentId,moved.employmentId].sort());
  const cross=await hireEmployee(foreign,{person:{fullName:'Fictional legacy foreign link',primaryEmail:randomUUID()+'@example.invalid'},companyId:other.companyId,departmentId:other.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  await owner.db.insert(s.payslip).values({...slip,id:randomUUID(),employmentId:cross.employmentId});
  expect(await compareMembers(root,batchId,true)).toEqual([target.employmentId,moved.employmentId].sort());
  expect(await compareMembers(mixed,batchId,true)).toEqual([target.employmentId]);
  const authorizedEmpty=await compareMembers(root,randomUUID(),true);expect(authorizedEmpty).toEqual([]);
 });
},600000);

it('keeps effective imported history and the old own-issued financial row under actual native rules',async()=>{
 const {root,target,batchId}=await paidRun();await closeBatch(root,{batchId});
 await owner.db.update(s.company).set({companyLabel:'000AC'}).where(eq(s.company.id,b.companyId));
 await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic'}).onConflictDoNothing();
 const worker:SessionContext={...root,userId:await createAppUser(b.tenantId,target.personId,'employee'),personId:target.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 await seedPayrollCycleCatalog(root,b.companyId);
 const lines=[['0007','2026-01','ME','BASIC','000AC','6000.00'],...['EEEPF','EESOCSO','EEEIS','PCB'].map(code=>['0007','2026-01','ME',code,'000AC','0.00'])];
 const preview=await previewPayrollHistoryUpload(root,{name:'history.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...lines])),operationKey:randomUUID()});
 expect(preview.plan.rows.map(r=>r.reasons).flat()).toEqual([]);
 const confirmed=await confirmPayrollHistoryUpload(root,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true,acknowledgeWarnings:true});
 const [imported]=await owner.db.select({batchId:s.payslip.batchId}).from(s.payslip).where(eq(s.payslip.id,confirmed.changes[0].snapshotId!));
 await withProbe(async()=>{expect(await compareMembers(root,batchId,true)).toEqual([]);expect(await compareMembers(worker,batchId,false,tx=>tx.execute(sql`select set_config('app.payslip_self_issued','on',true)`))).toEqual([target.employmentId]);expect(await compareMembers(root,imported.batchId,true)).toEqual([target.employmentId]);expect(await compareMembers(worker,imported.batchId,false)).toEqual([]);});
},600000);
