import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,terminateEmployment} from '../core/org';
import {setCompensation} from '../core/comp';
import {defaultConfig} from '../lib/onboarding-model';
import {loadOffboardingPostingApprovers,createPersonnelPostingTx,listPersonnelPostings,personnelPosting,editPersonnelPosting} from '../core/personnel-posting';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'ops',groups:[{id:'ops',name:'Fictional Operations',members:[admin.userId],limit:10}],offboarding:{postingApproverGroupId:'ops'}})}::jsonb)`);});
// Generic HR status does not imply Offboarding membership. Supply the actual shared access/group facts.
beforeEach(async()=>{
 const config=defaultConfig(admin.userId!);config.access.offboarding=[admin.userId!];config.groups.push({id:'ops',name:'Fictional Operations',members:[admin.userId!],limit:10});
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify(config)}::jsonb)`);
});
/** Owner fixtures pin released source facts; every tested command uses the native app role. */
async function retained(currency?:string|null){
 const hire=await hireEmployee(admin,{person:{fullName:'Fictional Retained Employee',primaryEmail:randomUUID()+'@postings.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const journey=randomUUID(),workflow=randomUUID(),run=randomUUID(),step='pay',offer={position:'Fictional Analyst',jobGrade:'G4',basicSalary:'12345.67',effectiveDate:'2026-11-16'};
 // Seed historical source records during a genuinely disabled Lifecycle interval, then restore the real gate.
 await setModule(b.tenantId,'lifecycle','disabled');
 await owner.db.execute(sql`insert into resignation_request(id,tenant_id,employment_id,person_id,last_working_day) values(${journey}::uuid,${b.tenantId}::uuid,${hire.employmentId}::uuid,${hire.personId}::uuid,'2026-12-16')`);
 await owner.db.execute(sql`insert into resignation_journey(tenant_id,id,employment_id,company_id,person_id,stage,data,participant_ids,submitted_on) values(${b.tenantId}::uuid,${journey}::uuid,${hire.employmentId}::uuid,${b.companyId}::uuid,${hire.personId}::uuid,'retained',${JSON.stringify({offer,facts:{currency:currency??null}})}::jsonb,${`{${admin.userId}}`}::uuid[],'2026-11-16')`);
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${workflow}::uuid,1,'off','live',false,${JSON.stringify({name:'Fixture retention posting',steps:[{id:step,type:'createPosting',params:{eventType:'Promotion',fields:['salary']}}]})}::jsonb,'Fictional fixture',${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into automation_run(tenant_id,id,module,workflow_id,workflow_revision,subject_id,event_key,trigger_event,status) values(${b.tenantId}::uuid,${run}::uuid,'off',${workflow}::uuid,1,${journey}::uuid,'accepted','accepted','running')`);
 const input={source:'offboarding' as const,sourceRef:journey,employmentId:hire.employmentId,eventType:'promotion' as const,proposed:{effectiveDate:offer.effectiveDate,basicSalary:offer.basicSalary},approverGroupId:'ops',idempotencyKey:`${run}:${step}:1`};
 await setModule(b.tenantId,'lifecycle','active');
 return {hire,journey,input};
}
describe('Native Offboarding posting isolation',()=>{
 it('refuses an old-case amount after currency changes, before creating any posting',async()=>{
  const f=await retained('SGD');await expect(withTenant(admin,tx=>createPersonnelPostingTx(tx,f.input))).rejects.toThrow(/salary currency changed/i);await setCompensation(admin,{employmentId:f.hire.employmentId,basicSalary:1000,currency:'USD',effectiveFrom:'2026-01-01'});
  await expect(withTenant(admin,tx=>createPersonnelPostingTx(tx,f.input))).rejects.toThrow(/salary currency changed/i);
  expect((await listPersonnelPostings(admin,{source:'offboarding',status:'all'})).rows).toHaveLength(0);
 });
 it('keeps a pending posting unchanged when its frozen currency no longer matches the applicable salary',async()=>{
  const f=await retained('SGD');await setCompensation(admin,{employmentId:f.hire.employmentId,basicSalary:1000,currency:'SGD',effectiveFrom:'2026-01-01'});
  const posting=await withTenant(admin,tx=>createPersonnelPostingTx(tx,f.input));expect((await personnelPosting(admin,posting.id))?.baseline?.currency).toBe('SGD');
  await setCompensation(admin,{employmentId:f.hire.employmentId,basicSalary:1000,currency:'USD',effectiveFrom:'2026-11-01'});
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.personnel_posting_approve(${posting.id}::uuid,1,null)`))).rejects.toMatchObject({cause:{code:'40001',message:'The salary currency changed since this resignation case; review the agreed offer before approving this posting'}});
  expect(await personnelPosting(admin,posting.id)).toMatchObject({status:'pending',revision:1,applied:null,movementId:null});
 });
 it('does not invent a currency for genuinely unknown legacy source facts',async()=>{
  const f=await retained(null);await setCompensation(admin,{employmentId:f.hire.employmentId,basicSalary:1000,currency:'USD',effectiveFrom:'2026-01-01'});
  const posting=await withTenant(admin,tx=>createPersonnelPostingTx(tx,f.input));expect((await personnelPosting(admin,posting.id))?.baseline?.currency).toBeNull();
 });

 it('requires a matching pinned workflow/source/offer; repeated creation returns one frozen proposal',async()=>{
  const f=await retained(),create=(input=f.input)=>withTenant(admin,tx=>createPersonnelPostingTx(tx,input));
  for(const input of [{...f.input,sourceRef:randomUUID()},{...f.input,employmentId:randomUUID()},{...f.input,idempotencyKey:'spoofed'},{...f.input,proposed:{...f.input.proposed,basicSalary:'999'}},{...f.input,approverGroupId:'unknown'}])await expect(create(input)).rejects.toThrow();
  const p=await create();expect((await create()).id).toBe(p.id);expect(p.number).toBeGreaterThan(1000);
  expect((await listPersonnelPostings(admin,{source:'probation',status:'all'})).rows).toHaveLength(0);
  expect((await listPersonnelPostings(admin,{source:'offboarding',status:'all'})).rows.map(p=>p.id)).toEqual([p.id]);
  // A later case cannot rewrite the old source snapshot on retry.
  await owner.db.execute(sql`update resignation_journey set revision=2 where tenant_id=${b.tenantId}::uuid and id=${f.journey}::uuid`);
  expect((await create()).id).toBe(p.id);expect((await personnelPosting(admin,p.id))?.proposed.basicSalary).toBe('12345.67');
 });
 it('keeps rejection durable, comment mandatory, approval atomic, and salary hidden from unrelated users',async()=>{
  const f=await retained(),p=await withTenant(admin,tx=>createPersonnelPostingTx(tx,f.input));
  const outsiderUser=await createAppUser(b.tenantId,f.hire.personId,'employee'),outsider={...admin,userId:outsiderUser,personId:f.hire.personId,roles:['employee'],grants:undefined} as SessionContext;
  expect(await personnelPosting(outsider,p.id)).toBeNull();await expect(editPersonnelPosting(outsider,{id:p.id,revision:1,values:f.input.proposed})).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.offboarding_posting_reject(${p.id}::uuid,1,' ')`))).rejects.toThrow();
  // A native approval without the same-transaction canonical movement is refused at commit.
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.personnel_posting_approve(${p.id}::uuid,1,null)`))).rejects.toThrow();expect((await personnelPosting(admin,p.id))?.status).toBe('pending');
  await withTenant(admin,tx=>tx.execute(sql`select app.offboarding_posting_reject(${p.id}::uuid,1,'Review the agreed effective date')`));
  expect(await personnelPosting(admin,p.id)).toMatchObject({status:'rejected',rejectionReason:'Review the agreed effective date',canRetry:true});
  await expect(editPersonnelPosting(admin,{id:p.id,revision:2,values:f.input.proposed})).rejects.toThrow();
 });
 it('refuses termination before clearance and rejects a null posting group instead of falling back',async()=>{
  const f=await retained();await expect(withTenant(admin,tx=>createPersonnelPostingTx(tx,{...f.input,eventType:'termination',idempotencyKey:'clearance:'+randomUUID(),proposed:{effectiveDate:'2026-12-16',resignationDate:'2026-11-16',exitReason:'Resignation'}}))).rejects.toThrow();
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{offboarding,postingApproverGroupId}','null'::jsonb) where tenant_id=${b.tenantId}::uuid`);
  await expect(withTenant(admin,tx=>createPersonnelPostingTx(tx,f.input))).rejects.toThrow();
 });
});

it('projects only bounded current waiting names for visible pending Offboarding postings, outside shared posting payloads',async()=>{
 const f=await retained();
 const member=async(name:string)=>{const hire=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@waiting.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});return{...hire,userId:await createAppUser(b.tenantId,hire.personId,'hr_admin')};};
 const active=[];for(const name of ['Waiting Aina','Waiting Bala','Waiting Chen','Waiting Devi','Waiting Elena'])active.push(await member(name));
 const archived=await member('Hidden archived member'),blocked=await member('Hidden ended member');
 await owner.db.execute(sql`update app_user set archived_at=now() where id=${archived.userId}::uuid`);
 await terminateEmployment(admin,{employmentId:blocked.employmentId,terminationDate:'2026-01-02',terminationType:'voluntary',terminationReason:'Fictional completed exit'});
 const subjectUser=await createAppUser(b.tenantId,f.hire.personId,'hr_admin');
 const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');const foreignSubject=await hireEmployee(adminCtx(foreign),{person:{fullName:'Hidden foreign member',primaryEmail:randomUUID()+'@waiting.example.test'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2026-01-01'}),foreignUser=await createAppUser(foreign.tenantId,foreignSubject.personId,'hr_admin');
 const ordinary=await member('Hidden ordinary employee'),wrongCompany=await member('Hidden other-company HR'),otherScope=randomUUID();
 await owner.db.execute(sql`insert into company(id,tenant_id,legal_name) values(${otherScope}::uuid,${b.tenantId}::uuid,'Fictional member other scope')`);
 await owner.db.execute(sql`update role_assignment set role='employee' where app_user_id=${ordinary.userId}::uuid and tenant_id=${b.tenantId}::uuid`);
 await owner.db.execute(sql`update role_assignment set company_id=${otherScope}::uuid where app_user_id=${wrongCompany.userId}::uuid and tenant_id=${b.tenantId}::uuid`);
 for(const candidate of [{...admin,userId:ordinary.userId,personId:ordinary.personId,roles:['employee']},{...admin,userId:wrongCompany.userId,personId:wrongCompany.personId,grants:[{role:'hr_admin',companyId:otherScope}]}] as SessionContext[])expect(await withTenant(candidate,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${f.hire.employmentId}::uuid,'workforce.maintain') as allowed`))).toEqual([{allowed:false}]);
 const group={id:'waiting',name:'Configured waiting people',limit:10,members:[...active.map(person=>person.userId),active[0].userId,archived.userId,blocked.userId,subjectUser,foreignUser,ordinary.userId,wrongCompany.userId,'malformed historical member','123-not-a-uuid']};
 await owner.db.execute(sql`update lc_onboarding_config set data=jsonb_set(data,'{groups}',data->'groups'||${JSON.stringify([group])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
 await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(jsonb_set(data,'{groups}',data->'groups'||${JSON.stringify([group])}::jsonb),'{offboarding,postingApproverGroupId}','"waiting"'::jsonb) where tenant_id=${b.tenantId}::uuid`);
 const posting=await withTenant(admin,tx=>createPersonnelPostingTx(tx,{...f.input,approverGroupId:group.id}));
 expect(await personnelPosting(admin,posting.id)).toMatchObject({canApprove:false,canRetry:true});
 expect(await personnelPosting(admin,posting.id)).not.toHaveProperty('offboardingApprovers');
 const expected={[posting.id]:{names:['Waiting Aina','Waiting Bala','Waiting Chen'],total:5}};
 expect(await loadOffboardingPostingApprovers(admin,[posting.id,posting.id])).toEqual(expected);
 const native=(ctx:SessionContext,ids:string[])=>withTenant(ctx,tx=>tx.execute<{posting_id:string;names:string[];total_members:number}>(sql`select * from app.offboarding_posting_waiting_members(${`{${ids.join(',')}}`}::uuid[])`));
 expect(await native(admin,[posting.id])).toEqual([{posting_id:posting.id,names:expected[posting.id].names,total_members:5}]);
 expect(await native(admin,[])).toEqual([]);expect(await native(admin,[posting.id,...Array.from({length:100},()=>randomUUID())])).toEqual([]);
 const subject={...admin,userId:subjectUser,personId:f.hire.personId,roles:['hr_admin'],grants:undefined};
 expect(await native(subject,[posting.id])).toEqual([]);expect(await native(adminCtx(foreign),[posting.id])).toEqual([]);
 expect(await withTenant(subject,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${f.hire.employmentId}::uuid,'workforce.maintain') as allowed`))).toEqual([{allowed:true}]); // Workforce maintenance alone never admits approval of one's own posting.
 for(const inactive of [archived,blocked])expect(await withTenant({...admin,userId:inactive.userId,personId:inactive.personId},tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${f.hire.employmentId}::uuid,'workforce.maintain') as allowed`))).toEqual([{allowed:false}]);
 const managerUser=await createAppUser(b.tenantId,null,'manager');await owner.db.execute(sql`update lc_onboarding_config set data=jsonb_set(data,'{access,offboarding}',data->'access'->'offboarding'||${JSON.stringify([managerUser])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
 const manager:SessionContext={...admin,userId:managerUser,personId:null,roles:['manager']};expect((await listPersonnelPostings(manager,{source:'offboarding',status:'all'})).rows).toEqual([]);expect(await native(manager,[posting.id])).toEqual([]); // Module access alone is not queue membership.
 const company=randomUUID(),restricted=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.execute(sql`insert into company(id,tenant_id,legal_name) values(${company}::uuid,${b.tenantId}::uuid,'Fictional other company')`);
 await owner.db.execute(sql`update role_assignment set company_id=${company}::uuid where tenant_id=${b.tenantId}::uuid and app_user_id=${restricted}::uuid`);
 const scoped:SessionContext={...admin,userId:restricted,personId:null,grants:[{role:'hr_admin',companyId:company}]};expect(await native(scoped,[posting.id])).toEqual([]);
 const probation=randomUUID();await owner.db.execute(sql`insert into personnel_posting(id,tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,idempotency_key) values(${probation}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${f.hire.employmentId}::uuid,99999,'probation',${randomUUID()}::uuid,'confirmation','{"effectiveDate":"2026-11-16"}'::jsonb,'waiting','fictional-existing-probation')`);
 expect(await native(admin,[probation])).toEqual([]);
 const approver={...admin,userId:active[0].userId,personId:active[0].personId};
 await withTenant(approver,tx=>tx.execute(sql`select app.offboarding_posting_reject(${posting.id}::uuid,1,'Fictional review required')`));
 expect(await native(admin,[posting.id])).toEqual([]);expect(await loadOffboardingPostingApprovers(admin,[posting.id])).toEqual({});
},90000);

it('pins the Access owner bodies and security attributes used by the derived human waiting projection',async()=>{
 const contracts=[
  ['app.access_workforce_company(uuid,text)','a44f92a105ec55bb504516b17a3b4966','sql',true,'search_path=pg_catalog, public, pg_temp'],
  ['app.access_workforce_employment(uuid,text)','dcdb6797287dc5c3339ffab3873fd892','sql',true,'search_path=pg_catalog, public, pg_temp'],
  ['app.access_allowed_for_tenant(uuid,uuid,text,uuid)','37b7ff9f10ef68cee3efa754cc259a08','plpgsql',true,'search_path=pg_catalog, public, pg_temp'],
  ['app.company_org_parent_for_tenant(uuid,uuid)','3ae3f6628230ba9775a4a5609922e1e2','sql',true,'search_path=pg_catalog, public, pg_temp'],
  ['app.company_org_descendant_for_tenant(uuid,uuid,uuid)','54a42a4016a905df5f0d00551dc07117','sql',true,'search_path=pg_catalog, public, pg_temp'],
  ['app.access_scope_covers(uuid,uuid,uuid)','b8fdee28a9b177b35f8cd10bfeeb79e7','sql',true,'search_path=pg_catalog, public, pg_temp'],
  ['app.access_workforce_employment_permitted(uuid,uuid,timestamp with time zone,uuid,uuid[])','4dcea99560326ecaba91f1f7942d402c','sql',false,null],
  ['app.has_role_for(text,uuid)','e8a6315d53cf3e89b21852823e1d3589','sql',true,'search_path=pg_catalog, public, pg_temp'],
  ['app.grants_have_role_for(jsonb,text,uuid)','3f18bf0fb0482ea472c649521198989c','sql',true,'search_path=pg_catalog, public, app'],
 ] as const;
 for(const [signature,body,language,definer,config] of contracts){const[actual]=await owner.db.execute<{body:string;language:string;definer:boolean;volatility:string;config:string[]|null}>(sql`select md5(p.prosrc) as body,l.lanname as language,p.prosecdef as definer,p.provolatile as volatility,p.proconfig as config from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`);expect(actual,signature+' changed: review derived waiting eligibility together with the canonical owner').toEqual({body,language,definer,volatility:'s',config:config?[config]:null});}
});

it('matches actual native-principal Workforce eligibility for configured waiting members, including capability precedence and employment state',async()=>{
 const f=await retained(),parent=randomUUID(),beta=randomUUID();
 await owner.db.execute(sql`insert into company(id,tenant_id,legal_name) values(${parent}::uuid,${b.tenantId}::uuid,'Fictional role parent'),(${beta}::uuid,${b.tenantId}::uuid,'Fictional unrelated scope')`);
 await owner.db.execute(sql`update company set parent_company_id=${parent}::uuid where id=${b.companyId}::uuid and tenant_id=${b.tenantId}::uuid`);
 const candidate=async(name:string,role:'employee'|'hr_admin',scope:string|null)=>{const person=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@waiting-parity.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});const id=await createAppUser(b.tenantId,person.personId,role);await owner.db.execute(sql`update role_assignment set company_id=${scope}::uuid where tenant_id=${b.tenantId}::uuid and app_user_id=${id}::uuid`);return{id,name,ctx:{...admin,userId:id,personId:person.personId,roles:[role],grants:[{role,companyId:scope}]} as SessionContext};};
 const employee=await candidate('Parity ordinary employee','employee',null),wrong=await candidate('Parity other-company HR','hr_admin',beta),allow=await candidate('Parity allowed HR','hr_admin',b.companyId),deny=await candidate('Parity denied HR','hr_admin',parent),effective=await candidate('Parity effective-group HR','hr_admin',parent),none=await candidate('Parity no grant HR','hr_admin',b.companyId);
 const candidates=[employee,wrong,allow,deny,effective,none],group={id:'parity',name:'Parity configured group',members:candidates.map(c=>c.id),limit:0};
 await owner.db.execute(sql`update lc_onboarding_config set data=jsonb_set(data,'{groups}',data->'groups'||${JSON.stringify([group])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
 await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(jsonb_set(data,'{groups}',data->'groups'||${JSON.stringify([group])}::jsonb),'{offboarding,postingApproverGroupId}','"parity"'::jsonb) where tenant_id=${b.tenantId}::uuid`);
 const posting=await withTenant(admin,tx=>createPersonnelPostingTx(tx,{...f.input,approverGroupId:'parity'}));
 const [original]=await owner.db.execute<{supported:boolean;bindings:unknown}>(sql`select supported,bindings from access_capability where id='workforce.maintain'`);
 const setMembers=async(ids:string[])=>{await owner.db.execute(sql`update lc_onboarding_config set data=jsonb_set(data,'{groups}',(select jsonb_agg(case when g->>'id'='parity' then jsonb_set(g,'{members}',${JSON.stringify(ids)}::jsonb) else g end) from jsonb_array_elements(data->'groups') g)) where tenant_id=${b.tenantId}::uuid`);};
 const expected=async()=>{const permitted=[];for(const c of candidates){const[row]=await withTenant(c.ctx,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${f.hire.employmentId}::uuid,'workforce.maintain') as allowed`));if(row.allowed)permitted.push(c.name);}return permitted.sort();};
 const compare=async(label:string)=>{const names=await expected(),labels=await loadOffboardingPostingApprovers(admin,[posting.id]);expect(labels[posting.id],label).toEqual({names:names.slice(0,3),total:names.length});for(const c of candidates){await setMembers([c.id]);const result=await loadOffboardingPostingApprovers(admin,[posting.id]);expect(result[posting.id],label+'/'+c.name).toEqual({names:names.includes(c.name)?[c.name]:[],total:Number(names.includes(c.name))});}await setMembers(candidates.map(c=>c.id));return names;};
 try{
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"waiting-eligibility-fixture","operation":"maintain"}]'::jsonb where id='workforce.maintain'`);
  await owner.db.execute(sql`update access_configuration set initialized=true where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`update access_group_grant set retired_at=now() where tenant_id=${b.tenantId}::uuid and capability_id='workforce.maintain' and retired_at is null`);
  for(const user of [admin.userId!,employee.id,wrong.id,allow.id,deny.id])await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${user}::uuid,'workforce.maintain',null,'allow')`);
  await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${deny.id}::uuid,'workforce.maintain',${b.companyId}::uuid,'deny')`);
  const accessGroup=randomUUID();await owner.db.execute(sql`insert into access_group(id,tenant_id,name) values(${accessGroup}::uuid,${b.tenantId}::uuid,'Fictional waiting capability group')`);
  await owner.db.execute(sql`insert into access_membership(tenant_id,group_id,user_id,company_id) values(${b.tenantId}::uuid,${accessGroup}::uuid,${effective.id}::uuid,${parent}::uuid)`);
  await owner.db.execute(sql`insert into access_group_grant(tenant_id,group_id,capability_id,company_id) values(${b.tenantId}::uuid,${accessGroup}::uuid,'workforce.maintain',${parent}::uuid)`);
  expect(await compare('supported: deny beats global allow; effective group covers child')).toEqual(['Parity allowed HR','Parity effective-group HR']);
  await owner.db.execute(sql`update access_capability set supported=false where id='workforce.maintain'`);
  expect(await compare('unsupported capability preserves canonical HR-role fallback')).toEqual(['Parity allowed HR','Parity denied HR','Parity effective-group HR','Parity no grant HR']);
  await owner.db.execute(sql`update access_capability set supported=true where id='workforce.maintain'`);
  const attempt=randomUUID();await owner.db.execute(sql`insert into import_attempt(id,tenant_id,kind,created_by,company_ids,mime_type,operation_key,plan,source_content,source_hash,source_name) values(${attempt}::uuid,${b.tenantId}::uuid,'employee_full',${admin.userId}::uuid,${`{${b.companyId}}`}::uuid[],'text/csv',${randomUUID()}::uuid,'{}'::jsonb,decode('','hex'),encode(sha256(decode('','hex')),'hex'),'waiting-fixture.csv')`);
  await owner.db.execute(sql`update employment set import_pending_attempt_id=${attempt}::uuid where id=${f.hire.employmentId}::uuid and tenant_id=${b.tenantId}::uuid`);
  expect(await expected()).toEqual([]);expect(await loadOffboardingPostingApprovers(admin,[posting.id])).toEqual({});
  // This is the real import owner's current reader context, not a candidate impersonation or an authority grant.
  await withTenant(admin,async tx=>{await tx.execute(sql`select set_config('app.import_attempt',${attempt},true)`);expect(await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${f.hire.employmentId}::uuid,'workforce.maintain') as allowed`)).toEqual([{allowed:true}]);expect(await tx.execute<{names:string[];total_members:number}>(sql`select names,total_members from app.offboarding_posting_waiting_members(${`{${posting.id}}`}::uuid[])`)).toEqual([{names:['Parity allowed HR','Parity effective-group HR'],total_members:2}]);});
  await owner.withTenant(admin,tx=>tx.execute(sql`select app.import_release(${attempt}::uuid)`));
  expect(await compare('released import marker uses the existing visibility owner')).toEqual(['Parity allowed HR','Parity effective-group HR']);
  await owner.db.execute(sql`update employment set voided_at=now(),voided_by=${admin.userId}::uuid,void_reason='Fictional import void',voided_import_attempt_id=${attempt}::uuid,voided_employee_code=employee_code,employee_code=null where id=${f.hire.employmentId}::uuid and tenant_id=${b.tenantId}::uuid`);
  expect(await expected()).toEqual([]);expect(await loadOffboardingPostingApprovers(admin,[posting.id])).toEqual({});
 }finally{await owner.db.execute(sql`update access_capability set supported=${original.supported},bindings=${JSON.stringify(original.bindings)}::jsonb where id='workforce.maintain'`);}
},270000);
