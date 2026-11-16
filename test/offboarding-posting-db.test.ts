import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {defaultConfig} from '../lib/onboarding-model';
import {createPersonnelPostingTx,listPersonnelPostings,personnelPosting,editPersonnelPosting} from '../core/personnel-posting';
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
