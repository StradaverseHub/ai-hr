import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {setCompensation} from '../core/comp';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {contractSharedTracker,contractSharedPeriodContext,openContractSharedPeriod,contractSharedContext,saveContractSharedRole,saveContractSharedMember} from '../packs/contracts/service';
import {todayInKualaLumpur} from '../lib/hr-date';

let b:Base,admin:SessionContext;
const year=Number(todayInKualaLumpur().slice(0,4)),start=`${year}-01-01`,end=`${year+1}-12-31`;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional tracker administrator',${randomUUID()+'@tracker.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);
});
async function ordinary(name='Fictional tracker viewer'){
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@tracker.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,person.id,'employee');
 return {...admin,userId,personId:person.id,roles:['employee'],grants:undefined} as SessionContext;
}
async function grant(user:SessionContext,permissions:('view'|'decide')[],companyId:string|null=b.companyId){
 const roleId=randomUUID();await saveContractSharedRole(admin,{id:roleId,name:randomUUID(),permissions,expectedRevision:0});
 await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:user.userId!,companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:false});
}
async function fixedTerm(name='Fictional current fixed term',manager?:string){
 const employee=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@tracker.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end,reportingManagerEmploymentId:manager});
 await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});
 return employee;
}
describe('Personnel-based Contract tracker and native case opening',()=>{
 it('lets a View-only reader inspect a virtual period without creating records or exposing current Payroll amounts',async()=>{
  const employee=await fixedTerm(),viewer=await ordinary(),outsider=await ordinary('Fictional unassigned Contract user');await grant(viewer,['view']);
  await setCompensation(admin,{employmentId:employee.employmentId,basicSalary:4976.21,effectiveFrom:start});
  const snapshot=async()=>[...await owner.db.execute<{counts:number[]}>(sql`select array[(select count(*)::int from contract_case where tenant_id=${b.tenantId}::uuid),(select count(*)::int from contract_shared_event where tenant_id=${b.tenantId}::uuid),(select count(*)::int from bulk_job where tenant_id=${b.tenantId}::uuid),(select count(*)::int from automation_email_delivery where tenant_id=${b.tenantId}::uuid)] as counts`)][0].counts;
  const before=await snapshot(),period=await contractSharedPeriodContext(viewer,employee.employmentId);
  expect(period).toMatchObject({employmentId:employee.employmentId,companyId:b.companyId,canOpen:false,existingCaseId:null,sourceIssue:null});expect(period.permissions).toEqual(['view']);
  expect(period.source.contractNumber).toBe(4);expect(period.source).not.toHaveProperty('salaryCents');expect(period.source).not.toHaveProperty('allowanceCents');expect(period.source).not.toHaveProperty('compensationId');
  expect(JSON.stringify(period)).not.toMatch(/497621|4976\.21/);expect(await snapshot()).toEqual(before);
  await expect(contractSharedPeriodContext(outsider,employee.employmentId)).rejects.toMatchObject({code:'forbidden'});
  const payRole=randomUUID();await saveContractSharedRole(admin,{id:payRole,name:'Current-pay fixture',permissions:['seePay'],expectedRevision:0});
  await saveContractSharedMember(admin,{id:randomUUID(),roleId:payRole,userId:viewer.userId!,companyId:b.companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:false});
  expect((await contractSharedPeriodContext(viewer,employee.employmentId)).source.salaryCents).toBe('497621');
  expect(await snapshot()).toEqual(before);
 });
 it('shows an eligible Personnel period before any case exists, preserves unknown numbers, and opens one real fixed-term case idempotently',async()=>{
  const employee=await fixedTerm(),unknown=await fixedTerm('Fictional unverified historical ordinal');
  await owner.db.execute(sql`update employment set contract_number=null where tenant_id=${b.tenantId}::uuid and id=${unknown.employmentId}::uuid`);
  const before=await contractSharedTracker(admin);
  expect(before.total).toBe(2);expect(before.rows.map(row=>row.employeeName)).toEqual(['Fictional current fixed term','Fictional unverified historical ordinal']);
  const row=before.rows.find(item=>item.id===employee.employmentId)!;
  expect(row.caseId).toBeNull();expect(row.canOpen).toBe(true);expect(row.contractNumber).toBe(4);
  const unverified=before.rows.find(item=>item.id===unknown.employmentId)!;
  expect(unverified.sourceIssue).toBe('verify_period');expect(unverified.contractNumber).toBeNull();expect(unverified.canOpen).toBe(false);
  await expect(openContractSharedPeriod(admin,{employmentId:unknown.employmentId,sourceRevision:unverified.sourceRevision!})).rejects.toMatchObject({code:'invalid'});
  const opened=await openContractSharedPeriod(admin,{employmentId:employee.employmentId,sourceRevision:row.sourceRevision!});
  expect(opened.legacy).toBe(false);expect(opened.jobId).toBeTruthy();
  const again=await openContractSharedPeriod(admin,{employmentId:employee.employmentId,sourceRevision:row.sourceRevision!});expect(again.caseId).toBe(opened.caseId);
  expect((await contractSharedTracker(admin)).rows.find(item=>item.id===employee.employmentId)!.canOpen).toBe(false);
  const detail=await contractSharedContext(admin,opened.caseId);expect(detail.flow?.period.number).toBe('4');expect(detail.flow?.stage).toBe('open');
  const [native]=await owner.db.execute<{kind:string;cases:number;events:number;postings:number}>(sql`select t.kind,(select count(*)::int from contract_case where tenant_id=${b.tenantId}::uuid and employment_id=${employee.employmentId}::uuid) as cases,(select count(*)::int from contract_shared_event where tenant_id=${b.tenantId}::uuid and case_id=${opened.caseId}::uuid and trigger_event='caseOpened') as events,(select count(*)::int from personnel_posting where tenant_id=${b.tenantId}::uuid) as postings from contract_term t where t.id=${detail.flow!.period.id}::uuid`);
  expect(native).toEqual({kind:'fixed_term',cases:1,events:1,postings:0});
  expect(JSON.stringify((await contractSharedTracker(admin)).rows)).not.toMatch(/salaryCents|allowanceCents|candidatePersonIds/);
  await owner.db.execute(sql`update employment set contract_number=5 where tenant_id=${b.tenantId}::uuid and id=${employee.employmentId}::uuid`);
  const changed=(await contractSharedTracker(admin)).rows.find(item=>item.id===employee.employmentId)!;
  expect(changed.caseId).toBe(opened.caseId);expect(changed.sourceIssue).toBe('period_changed');expect(changed.canOpen).toBe(false);
  await expect(openContractSharedPeriod(admin,{employmentId:employee.employmentId,sourceRevision:changed.sourceRevision!})).rejects.toMatchObject({code:'conflict'});
 });
 it('checks current scoped authority and source revision, and preserves legacy work in progress without adoption',async()=>{
  const employee=await fixedTerm(),viewer=await ordinary();await grant(viewer,['view']);
  const row=(await contractSharedTracker(viewer)).rows[0];expect(row.canOpen).toBe(false);
  await expect(openContractSharedPeriod(viewer,{employmentId:employee.employmentId,sourceRevision:row.sourceRevision!})).rejects.toMatchObject({code:'forbidden'});
  await grant(viewer,['decide']);
  await expect(openContractSharedPeriod(viewer,{employmentId:employee.employmentId,sourceRevision:'0'.repeat(64)})).rejects.toMatchObject({code:'conflict'});
  const termId=randomUUID(),caseId=randomUUID();
  await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) values(${termId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,1,'project',${start}::date,${end}::date,'legacy-source')`);
  await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,${termId}::uuid,'CT-LEGACY-1',jsonb_build_object('revision',1,'state','in_approval','term',jsonb_build_object('startOn',${start}::text,'endOn',${end}::text),'decision',jsonb_build_object('kind','renew'))) `);
  expect((await contractSharedTracker(viewer)).rows[0].sourceIssue).toBe('legacy_in_progress');
  expect(await openContractSharedPeriod(viewer,{employmentId:employee.employmentId,sourceRevision:row.sourceRevision!})).toEqual({caseId,legacy:true});
  const [native]=await owner.db.execute<{shared:number;state:string}>(sql`select (select count(*)::int from contract_shared_case where tenant_id=${b.tenantId}::uuid) as shared,data->>'state' as state from contract_case where id=${caseId}::uuid`);
  expect(native).toEqual({shared:0,state:'in_approval'});
 });
 it('matches the canonical permission owner for direct superiors and named scoped roles',async()=>{
  const manager=await hireEmployee(admin,{person:{fullName:'Fictional Direct Superior',primaryEmail:randomUUID()+'@tracker.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
  const managerId=await createAppUser(b.tenantId,manager.personId,'employee');
  const superior={...admin,userId:managerId,personId:manager.personId,roles:['employee'],grants:undefined} as SessionContext;
  const employee=await fixedTerm('Fictional direct report',manager.employmentId),other=await fixedTerm('Fictional unrelated employee'),plain=await ordinary();
  for(const actor of [admin,superior,plain]){
   const oracle=await withTenant(actor,tx=>tx.execute<{id:string}>(sql`select id from employment where tenant_id=${b.tenantId}::uuid and id in(${employee.employmentId}::uuid,${other.employmentId}::uuid) and app.contract_shared_permitted('view',company_id,null,id) order by id`));
   expect((await contractSharedTracker(actor)).rows.map(row=>row.id).sort()).toEqual(oracle.map(row=>row.id));
  }
  expect((await contractSharedTracker(superior)).rows.map(row=>row.id)).toEqual([employee.employmentId]);
  await grant(plain,['view']);expect((await contractSharedTracker(plain)).total).toBe(2);
  await createAppUser(b.tenantId,manager.personId,'employee');
  expect((await contractSharedTracker(superior)).rows).toEqual([]);
 });
 it('retains native People Ops and uniquely matched PBP authority, and removes expired or ambiguous grants',async()=>{
  const employee=await fixedTerm(),gbs=await ordinary('Fictional actual People Ops'),pbp=await ordinary('Fictional actual PBP'),unmatched=await ordinary('Fictional unmatched PBP'),expired=await ordinary('Fictional expired viewer');
  const config=(await v9Workspace(admin)).config!,groupId=randomUUID();
  await v9SaveConfig(admin,config.revision,{...config,groups:[...config.groups,{id:groupId,name:'Actual tracker People Ops',members:[gbs.userId!],limit:0}],peopleOpsGroup:groupId,bpRules:[{userId:pbp.userId!,rules:{company:[b.companyId]}}]});
  await owner.db.execute(sql`insert into contract_role_assignment(tenant_id,company_id,user_id,role,valid_from,created_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,${gbs.userId}::uuid,'gbs',${start}::date,${admin.userId}::uuid),(${b.tenantId}::uuid,${b.companyId}::uuid,${pbp.userId}::uuid,'pbp',${start}::date,${admin.userId}::uuid),(${b.tenantId}::uuid,${b.companyId}::uuid,${unmatched.userId}::uuid,'pbp',${start}::date,${admin.userId}::uuid)`);
  const expiredRole=randomUUID();await saveContractSharedRole(admin,{id:expiredRole,name:'Expired fixture',permissions:['view','decide'],expectedRevision:0});
  await saveContractSharedMember(admin,{id:randomUUID(),roleId:expiredRole,userId:expired.userId!,companyId:b.companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:'2021-01-01',revoked:false});
  for(const actor of [gbs,pbp,unmatched,expired]){
   const [native]=await withTenant(actor,tx=>tx.execute<{view:boolean;decide:boolean}>(sql`select app.contract_shared_permitted('view',${b.companyId}::uuid,null,${employee.employmentId}::uuid) as view,app.contract_shared_permitted('decide',${b.companyId}::uuid,null,${employee.employmentId}::uuid) as decide`));
   const page=await contractSharedTracker(actor);expect(page.total).toBe(native.view?1:0);if(native.view)expect(page.rows[0].canOpen).toBe(native.decide);
  }
  expect((await contractSharedTracker(gbs)).total).toBe(1);expect((await contractSharedTracker(pbp)).total).toBe(1);expect((await contractSharedTracker(unmatched)).total).toBe(0);expect((await contractSharedTracker(expired)).total).toBe(0);
  const configured=(await v9Workspace(admin)).config!;
  await v9SaveConfig(admin,configured.revision,{...configured,bpRules:[...configured.bpRules,{userId:unmatched.userId!,rules:{company:[b.companyId]}}]});
  expect((await contractSharedTracker(pbp)).total).toBe(0);expect((await contractSharedTracker(unmatched)).total).toBe(0);
  await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${b.tenantId}::uuid and id=${gbs.userId}::uuid`);
  expect((await contractSharedTracker(gbs)).rows).toEqual([]);
 });
 it('matches native inherited HR company authority without granting unrelated companies',async()=>{
  const employee=await fixedTerm(),operator=await ordinary('Fictional scoped HR operator');
  const [parent]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${b.tenantId}::uuid,'Fictional parent company') returning id`);
  await owner.db.execute(sql`update company set parent_company_id=${parent.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${b.companyId}::uuid`);
  await owner.db.execute(sql`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${b.tenantId}::uuid,${operator.userId}::uuid,'hr_admin',${parent.id}::uuid)`);
  const [native]=await withTenant(operator,tx=>tx.execute<{ok:boolean}>(sql`select app.contract_shared_permitted('view',${b.companyId}::uuid,null,${employee.employmentId}::uuid) as ok`));
  expect(native.ok).toBe(true);expect((await contractSharedTracker(operator)).rows.map(row=>row.id)).toEqual([employee.employmentId]);
 });
 it('retains converted cases and their unfinished manual-pay confirmation in the tracker',async()=>{
  const employee=await fixedTerm(),initial=(await contractSharedTracker(admin)).rows[0];
  const opened=await openContractSharedPeriod(admin,{employmentId:employee.employmentId,sourceRevision:initial.sourceRevision!});
  await owner.db.execute(sql`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{stage}','"pay"'::jsonb),'{revision}',to_jsonb(revision+1)) where tenant_id=${b.tenantId}::uuid and case_id=${opened.caseId}::uuid`);
  await owner.db.execute(sql`update assignment set employment_type='full_time' where tenant_id=${b.tenantId}::uuid and employment_id=${employee.employmentId}::uuid and superseded_at is null`);
  await owner.db.execute(sql`update employment set contract_start_date=null,contract_end_date=null where tenant_id=${b.tenantId}::uuid and id=${employee.employmentId}::uuid`);
  const pending=await contractSharedTracker(admin,{status:'progress'});expect(pending.total).toBe(1);expect(pending.rows[0]).toMatchObject({caseId:opened.caseId,stage:'pay',payPendingCaseId:opened.caseId,canOpen:false,sourceIssue:null});
  expect(pending.companies.map(company=>company.id)).toEqual([b.companyId]);
  await owner.db.execute(sql`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{stage}','"converted"'::jsonb),'{revision}',to_jsonb(revision+1)) where tenant_id=${b.tenantId}::uuid and case_id=${opened.caseId}::uuid`);
  const closed=await contractSharedTracker(admin,{status:'closed'});expect(closed.total).toBe(1);expect(closed.rows[0].caseId).toBe(opened.caseId);expect(closed.rows[0].stage).toBe('converted');
  expect((await contractSharedTracker(admin,{status:'decision'})).total).toBe(0);
 });
 it('carries an older pay task onto the new native period, while holding conflicting unfinished work for reconciliation',async()=>{
  const employee=await fixedTerm(),initial=(await contractSharedTracker(admin)).rows[0];
  const opened=await openContractSharedPeriod(admin,{employmentId:employee.employmentId,sourceRevision:initial.sourceRevision!});
  await owner.db.execute(sql`update employment set contract_start_date=${`${year+2}-01-01`}::date,contract_end_date=${`${year+2}-12-31`}::date,contract_number=5 where tenant_id=${b.tenantId}::uuid and id=${employee.employmentId}::uuid`);
  const held=(await contractSharedTracker(admin)).rows[0];expect(held).toMatchObject({caseId:opened.caseId,canOpen:false,sourceIssue:'period_changed'});
  await owner.db.execute(sql`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{stage}','"pay"'::jsonb),'{revision}',to_jsonb(revision+1)) where tenant_id=${b.tenantId}::uuid and case_id=${opened.caseId}::uuid`);
  const next=(await contractSharedTracker(admin)).rows[0];expect(next).toMatchObject({caseId:null,contractNumber:5,canOpen:true,previousPayPending:true,payPendingCaseId:opened.caseId,sourceIssue:null});
  const newCase=await openContractSharedPeriod(admin,{employmentId:employee.employmentId,sourceRevision:next.sourceRevision!});expect(newCase.caseId).not.toBe(opened.caseId);
  const current=(await contractSharedTracker(admin)).rows[0];expect(current).toMatchObject({caseId:newCase.caseId,previousPayPending:true,payPendingCaseId:opened.caseId,canOpen:false});
 });
 it('pages and counts 1,000 fixed-term employments across 70 companies without requiring 1,000 case records',async()=>{
  await owner.db.execute(sql`with companies as(insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Tracker company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name),departments as(insert into department(tenant_id,company_id,name) select ${b.tenantId}::uuid,id,'Tracker department' from companies returning id,company_id),numbered as materialized(select c.id,d.id as department_id,row_number() over(order by c.legal_name) as n from companies c join departments d on d.company_id=c.id),fixture as materialized(select series.n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,c.id as company_id,c.department_id from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1),people as(insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Tracker employee '||lpad(n::text,4,'0'),'scale-'||n||'@tracker.test' from fixture),employments as(insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number) select employment_id,${b.tenantId}::uuid,person_id,company_id,${start}::date,'SCALE-'||n,${start}::date,${end}::date,4 from fixture) insert into assignment(id,tenant_id,employment_id,company_id,department_id,employment_type,valid_from) select gen_random_uuid(),${b.tenantId}::uuid,employment_id,company_id,department_id,'contract',${start}::date from fixture`);
  admin={...await entitledCtx(b),personId:admin.personId};
  const first=await contractSharedTracker(admin,{limit:100}),second=await contractSharedTracker(admin,{limit:100,offset:100}),last=await contractSharedTracker(admin,{limit:100,offset:900});
  expect(first.total).toBe(1000);expect(first.rows).toHaveLength(100);expect(first.hasMore).toBe(true);expect(last.hasMore).toBe(false);
  expect(first.companies).toHaveLength(70);expect(first.businessGroups).toHaveLength(70);
  expect(first.rows.map(row=>row.employeeName)).toEqual(Array.from({length:100},(_,i)=>'Tracker employee '+String(i+1).padStart(4,'0')));
  expect(new Set([...first.rows,...second.rows].map(row=>row.id)).size).toBe(200);expect(first.rows.every(row=>row.caseId===null&&row.contractNumber===4)).toBe(true);
  const company=first.rows[0].companyId,viewer=await ordinary();await grant(viewer,['view'],company);
  const scoped=await contractSharedTracker(viewer,{limit:100});expect(scoped.total).toBe(15);expect(scoped.rows.every(row=>row.companyId===company)).toBe(true);
  expect(scoped.companies).toEqual([{id:company,name:first.companies.find(item=>item.id===company)!.name}]);
  const single=await contractSharedTracker(admin,{companyId:company,limit:100});expect(single.rows.map(row=>row.id)).toEqual(scoped.rows.map(row=>row.id));expect(single.total).toBe(15);
  const other=first.rows.find(row=>row.companyId!==company)!;expect((await contractSharedTracker(viewer,{companyId:other.companyId})).total).toBe(0);
  const [effects]=await owner.db.execute<{count:number}>(sql`select count(*)::int as count from contract_case where tenant_id=${b.tenantId}::uuid`);expect(effects.count).toBe(0);
 },180000);
});
