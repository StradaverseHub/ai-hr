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
 const subjectUser=await createAppUser(b.tenantId,f.hire.personId,'employee');
 const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');const foreignSubject=await hireEmployee(adminCtx(foreign),{person:{fullName:'Hidden foreign member',primaryEmail:randomUUID()+'@waiting.example.test'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2026-01-01'}),foreignUser=await createAppUser(foreign.tenantId,foreignSubject.personId,'hr_admin');
 const group={id:'waiting',name:'Configured waiting people',limit:10,members:[...active.map(person=>person.userId),active[0].userId,archived.userId,blocked.userId,subjectUser,foreignUser,'malformed historical member','123-not-a-uuid']};
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
 const subject={...admin,userId:subjectUser,personId:f.hire.personId,roles:['employee'],grants:undefined};
 expect(await native(subject,[posting.id])).toEqual([]);expect(await native(adminCtx(foreign),[posting.id])).toEqual([]);
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
