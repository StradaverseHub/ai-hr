/** WP13 c/d/e: real migrated DB, canonical lifecycle rules and current notification projection.
 * Fictional fixtures only. No model call, clock assertion, document edit or task completion is an effect. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const model=vi.hoisted(()=>({calls:0}));
vi.mock('../lib/ai',async original=>({...await original<typeof import('../lib/ai')>(),generateDraft:async()=>{model.calls++;throw Error('Model forbidden');},converse:async()=>{model.calls++;throw Error('Model forbidden');}}));
import * as dbClient from '../db/client';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {agentContext,agentStamp,agentSwitchStatesTx,attributedEnablements,ensureAgentPrincipal} from '../core/agent-principal';
import {resolveEntitlementsTx} from '../core/entitlements';
import {runAutomaticFollowups,followupItemsTx,FOLLOWUP_EVENT,currentFollowupTargetsTx} from '../core/automatic-followups';
import {AutomaticChaserRefusal,engineWorkingDayCalendar} from '../core/automatic-chasers';
import {dispatchNotifications} from '../core/notifications';
import {assistantOutcomes} from '../core/assistant-outcomes';
import {assertAiActionUnpausedTx} from '../core/ai-governance';
import {addDaysIso} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,root:SessionContext,employee:{personId:string;employmentId:string},staff:{personId:string;employmentId:string};let seq=0;
const today=()=>todayInKualaLumpur(),yesterday=()=>addDaysIso(today(),-1),date=(n:number)=>addDaysIso(today(),n);
const clockKey='notifications.missing_clock_reminders_enabled',docKey='notifications.passport_expiry_reminders_enabled',lifeKey='notifications.lifecycle_step_chasers_enabled';
const past=new Date(Date.now()-20*86400000);
async function hire(name:string,clocked=true){const e=await hireEmployee(root,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});if(clocked)await owner.db.insert(s.attendance).values({tenantId:b.tenantId,employmentId:e.employmentId,attendanceDate:yesterday(),checkInAt:'08:00:00'});return e;}
async function enabled(key:string){await setSetting(b.tenantId,key,true);await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'tenant-setting',aggregateId:b.tenantId,eventType:'tenant-setting.changed',actorType:'user',actorId:b.adminUserId,payload:{key,value:true}});}
async function agent(base=b){const principal=await ensureAgentPrincipal(owner.db,base.tenantId),entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,base.tenantId));const bare=agentContext(base.tenantId,principal,entitlements);const enablements=attributedEnablements(await withTenant(bare,tx=>agentSwitchStatesTx(tx,bare)));return agentContext(base.tenantId,principal,entitlements,enablements);}
const run=async(calendar=async()=>5)=>runAutomaticFollowups(await agent(),{calendar});
const events=()=>owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,FOLLOWUP_EVENT));
async function passport(expiry=date(10),personId=employee.personId){return owner.db.insert(s.employeeStatutoryMy).values({tenantId:b.tenantId,personId,passportNumber:'FICTIONAL-SECRET-PASSPORT',passportExpiryDate:expiry}).returning();}
async function lifecycle(){
 await owner.db.insert(s.lcStepDef).values([{tenantId:b.tenantId,kind:'onboarding',stepKey:'first',phase:0,label:'Fictional first',ownerTeam:'IT',rule:'always',sort:1},{tenantId:b.tenantId,kind:'onboarding',stepKey:'later',phase:1,label:'Fictional next',ownerTeam:'HR',rule:'always',sort:2},{tenantId:b.tenantId,kind:'onboarding',stepKey:'carpark',phase:0,label:'Fictional unused',rule:'carpark',sort:3}]);
 const [c]=await owner.db.insert(s.lcCase).values({tenantId:b.tenantId,kind:'onboarding',companyId:b.companyId,number:'FICT-'+(++seq),fullName:'FICTIONAL-PRIVATE-CASE',employeeNo:'FICT',employmentId:employee.employmentId,personId:employee.personId,laptopRequired:false,carparkRequired:false,createdAt:past}).returning();return c;
}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
beforeEach(async()=>{await resetDb();b=await seedBase();for(const module of ['notifications','attendance','lifecycle'])await setModule(b.tenantId,module,'active');root={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};await owner.db.insert(s.attendancePolicy).values({tenantId:b.tenantId,companyId:b.companyId,workingDays:[1,2,3,4,5,6,7],halfWorkingDays:[]}).onConflictDoUpdate({target:s.attendancePolicy.companyId,set:{workingDays:[1,2,3,4,5,6,7],halfWorkingDays:[]}});employee=await hire('FICTIONAL-PRIVATE-EMPLOYEE',false);staff=await hire('Fictional lifecycle staff');const userId=await createAppUser(b.tenantId,staff.personId,'employee');await owner.db.insert(s.lcStaff).values({tenantId:b.tenantId,userId,companyId:b.companyId,level:'agent'});model.calls=0;});

describe('Automatic missing-clock record reminders',()=>{
 it('reminds the employee once, without creating any clock/attendance fact or claiming work',async()=>{
  await enabled(clockKey);const before=await owner.db.select().from(s.attendance),ctx=await agent();await Promise.all([runAutomaticFollowups(ctx,{calendar:async()=>1}),runAutomaticFollowups(ctx,{calendar:async()=>1})]);
  const receipts=(await events()).filter(e=>e.subjectEmploymentId===employee.employmentId);expect(receipts).toHaveLength(1);expect(receipts[0].payload).toMatchObject({action:'attendance.missing_clock.remind',source:'missing_clock',stage:yesterday(),chaseNumber:1});expect(await owner.db.select().from(s.attendance)).toEqual(before);
  await dispatchNotifications(root,{});const notices=await owner.db.select().from(s.notification).where(eq(s.notification.kind,'attendance.missing-clock'));expect(notices.map(n=>n.recipientEmploymentId)).toContain(employee.employmentId);expect(notices[0].body).toContain('does not establish whether you worked');
 });
 it('skips a non-working or unknown calendar and does not widen principal roster access',async()=>{
  await enabled(clockKey);await run(async()=>0);expect(await events()).toHaveLength(0);await run(async()=>null as never);expect(await events()).toHaveLength(0);
  const ctx=await agent();expect(await withTenant(ctx,tx=>tx.select().from(s.assignment))).toEqual([]);
 });
 it('suppresses an actual clock, a leave date, or a pending correction before dispatch',async()=>{
  await enabled(clockKey);await run();const [receipt]=(await events()).filter(e=>e.subjectEmploymentId===employee.employmentId);
  await owner.db.insert(s.attendance).values({tenantId:b.tenantId,employmentId:employee.employmentId,attendanceDate:yesterday(),checkInAt:'09:00:00'});
  expect(await withTenant(root,tx=>currentFollowupTargetsTx(tx,'missing_clock',employee.employmentId,yesterday(),employee.employmentId))).toEqual([]);await dispatchNotifications(root,{});expect(await owner.db.select().from(s.notification).where(eq(s.notification.sourceEventId,receipt.id))).toEqual([]);
 });
});

describe('Recorded passport-expiry reminders',()=>{
 it('selects only a recorded expiry in the next 30 days; never exposes passport values',async()=>{
  await passport();await enabled(docKey);await run();const receipts=await events();expect(receipts).toHaveLength(1);expect(receipts[0].payload).toMatchObject({source:'passport_expiry',stage:'passport:'+date(10),waitingOn:date(10)});expect(JSON.stringify(receipts)).not.toContain('FICTIONAL-SECRET-PASSPORT');
  await dispatchNotifications(root,{});expect((await owner.db.select().from(s.notification).where(eq(s.notification.kind,'profile.passport-expiry'))).map(n=>n.recipientEmploymentId)).toContain(employee.employmentId);
  expect(await withTenant(await agent(),tx=>tx.select().from(s.employeeStatutoryMy))).toEqual([]);
 });
 it.each([-1,31])('does not manufacture eligibility outside the recorded expiry window (%s days)',async days=>{await passport(date(days));await enabled(docKey);expect((await run()).sent).toBe(0);});
 it('honours cooldown, per-item cap and renewal before delivery',async()=>{
  const [p]=await passport();await enabled(docKey);expect((await run()).sent).toBe(1);expect((await run()).byAction['employees.passport_expiry.remind'].cooled).toBe(1);
  for(let n=1;n<4;n++){await owner.db.update(s.domainEvent).set({occurredAt:new Date(Date.now()-8*86400000)}).where(eq(s.domainEvent.eventType,FOLLOWUP_EVENT));expect((await run()).sent).toBe(1);}
  await owner.db.update(s.domainEvent).set({occurredAt:new Date(Date.now()-8*86400000)}).where(eq(s.domainEvent.eventType,FOLLOWUP_EVENT));expect((await run()).byAction['employees.passport_expiry.remind'].exhausted).toBe(1);
  await owner.db.update(s.employeeStatutoryMy).set({passportExpiryDate:date(365)}).where(eq(s.employeeStatutoryMy.id,p.id));await dispatchNotifications(root,{});expect(await owner.db.select().from(s.notification).where(eq(s.notification.kind,'profile.passport-expiry'))).toHaveLength(0);
 });
});

describe('Actionable lifecycle steps, not invented deadlines',()=>{
 it('chases only currently actionable steps and tells current scoped staff, never completes a step',async()=>{
  const c=await lifecycle();await enabled(lifeKey);expect((await run()).sent).toBe(1);const [receipt]=await events();expect(receipt.payload).toMatchObject({action:'lifecycle.step.chase',stage:expect.stringMatching(/^first:/)});expect(JSON.stringify(receipt.payload)).not.toMatch(/PRIVATE|Fictional|IT|HR/);expect(await owner.db.select().from(s.lcCaseStep)).toHaveLength(0);
  await dispatchNotifications(root,{});const notices=await owner.db.select().from(s.notification).where(eq(s.notification.kind,'lifecycle.step-waiting'));expect(notices.map(n=>n.recipientEmploymentId)).toContain(staff.employmentId);expect(notices.map(n=>n.recipientEmploymentId)).not.toContain(employee.employmentId);
  await owner.db.insert(s.lcCaseStep).values({tenantId:b.tenantId,caseId:c.id,stepKey:'first',done:true,doneAt:new Date()});expect(await withTenant(root,tx=>currentFollowupTargetsTx(tx,'lifecycle_step',c.id,(receipt.payload as {stage:string}).stage,employee.employmentId))).toEqual([]);
 });
 it('restarts the wait when the next phase opens or a case reopens, not when notes change',async()=>{
  const c=await lifecycle();await enabled(lifeKey);await owner.db.insert(s.lcCaseStep).values({tenantId:b.tenantId,caseId:c.id,stepKey:'first',done:true,doneAt:new Date()});
  const [transition]=await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'lifecycle-case',aggregateId:c.id,eventType:'lifecycle-case.step-done',actorType:'user',actorId:b.adminUserId,payload:{step:'first'}}).returning();
  const calendar=async(_e:string,from:string,to:string)=>from===to?0:5;expect((await runAutomaticFollowups(await agent(),{calendar})).sent).toBe(0);
  await owner.db.update(s.domainEvent).set({occurredAt:past}).where(eq(s.domainEvent.id,transition.id));await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'lifecycle-case',aggregateId:c.id,eventType:'lifecycle-case.commented',actorType:'user',actorId:b.adminUserId,payload:{}});expect((await runAutomaticFollowups(await agent(),{calendar})).sent).toBe(1);
  await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'lifecycle-case',aggregateId:c.id,eventType:'lifecycle-case.reopened',actorType:'user',actorId:b.adminUserId,payload:{}});expect((await runAutomaticFollowups(await agent(),{calendar})).sent).toBe(0);
 });
 it('starts a new wait for an applicability flag change, while unrelated edited fields do not reset it',async()=>{
  const c=await lifecycle();await enabled(lifeKey);await owner.db.insert(s.lcCaseStep).values({tenantId:b.tenantId,caseId:c.id,stepKey:'first',done:true,doneAt:past});await owner.db.update(s.lcCase).set({carparkRequired:true}).where(eq(s.lcCase.id,c.id));
  const [changed]=await owner.db.insert(s.lcHistory).values({tenantId:b.tenantId,refType:'case',refId:c.id,action:'case.edited',detail:{fields:['carparkRequired']}}).returning();
  const calendar=async(_e:string,from:string,to:string)=>from===to?0:5;expect((await runAutomaticFollowups(await agent(),{calendar})).sent).toBe(0);
  await owner.db.update(s.lcHistory).set({at:past}).where(eq(s.lcHistory.id,changed.id));await owner.db.insert(s.lcHistory).values({tenantId:b.tenantId,refType:'case',refId:c.id,action:'case.edited',detail:{fields:['notes']}});
  expect((await runAutomaticFollowups(await agent(),{calendar})).sent).toBe(1);expect((await events())[0].payload).toMatchObject({stage:expect.stringMatching(/^carpark:/)});
 });
 it('does not chase cancelled cases',async()=>{const c=await lifecycle();await enabled(lifeKey);await owner.db.update(s.lcCase).set({status:'cancelled'}).where(eq(s.lcCase.id,c.id));expect((await run()).sent).toBe(0);});
});

describe('Reminder authority, boundaries and observations',()=>{
 it('requires a named principal, attributed current switch, and module; switch off stops a captured run',async()=>{
  await passport();await setSetting(b.tenantId,docKey,true);expect((await run()).sent).toBe(0);await enabled(docKey);const ctx=await agent();await setSetting(b.tenantId,docKey,false);expect((await runAutomaticFollowups(ctx,{calendar:async()=>5})).sent).toBe(0);
  await expect(runAutomaticFollowups(root,{calendar:async()=>5})).rejects.toBeInstanceOf(AutomaticChaserRefusal);await enabled(docKey);await setModule(b.tenantId,'notifications','disabled');expect((await run()).sent).toBe(0);
 });
 it('refuses re-switched attribution and SETTING_KILL and never enters model admission',async()=>{
  await passport();await enabled(docKey);const ctx=await agent();await enabled(docKey);expect((await runAutomaticFollowups(ctx,{calendar:async()=>5})).sent).toBe(0);vi.stubEnv('SETTING_KILL',docKey);expect((await run()).sent).toBe(0);vi.unstubAllEnvs();
  for(const feature of ['clock_reminders','document_reminders','lifecycle_chasers'] as const)await expect(withTenant(root,tx=>assertAiActionUnpausedTx(tx,root,feature))).rejects.toThrow('no model call');expect(model.calls).toBe(0);
 });
 it('keeps another tenant source hidden and denies unscoped login projection',async()=>{
  await passport();await enabled(docKey);const other=await seedBase();const otherPrincipal=await agent(other);expect(await withTenant(otherPrincipal,tx=>followupItemsTx(tx,'passport_expiry',today(),[employee.employmentId]))).toEqual([]);
  const userId=await createAppUser(b.tenantId,employee.personId,'employee'),plain={...await entitledCtx(b,['employee']),userId,personId:employee.personId,roles:['employee' as const],grants:[{role:'employee' as const,companyId:null}]};expect(await withTenant(plain,tx=>followupItemsTx(tx,'passport_expiry',today(),[employee.employmentId]))).toEqual([]);
 });
 it.each(['inapplicable','reconfigured','phase_locked'] as const)('observes an old lifecycle stage as no longer waiting when it becomes %s',async change=>{
  await lifecycle();await enabled(lifeKey);await run();expect((await assistantOutcomes(root,30)).automatic.find(r=>r.action==='lifecycle.step.chase')).toMatchObject({items:1,waiting:1,acted:0});
  if(change==='inapplicable')await owner.db.update(s.lcStepDef).set({rule:'laptop'}).where(and(eq(s.lcStepDef.tenantId,b.tenantId),eq(s.lcStepDef.stepKey,'first')));
  else if(change==='phase_locked'){await owner.db.update(s.lcStepDef).set({phase:1}).where(and(eq(s.lcStepDef.tenantId,b.tenantId),eq(s.lcStepDef.stepKey,'first')));await owner.db.insert(s.lcStepDef).values({tenantId:b.tenantId,kind:'onboarding',stepKey:'new_prerequisite',phase:0,label:'Fictional prerequisite',rule:'always',sort:0});}
  else await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'lifecycle-config',aggregateId:b.tenantId,eventType:'lifecycle-config.steps-saved',actorType:'user',actorId:b.adminUserId,payload:{kind:'onboarding'}});
  expect((await assistantOutcomes(root,30)).automatic.find(r=>r.action==='lifecycle.step.chase')).toMatchObject({items:1,waiting:0,acted:1});
  const [raw]=await withTenant(root,tx=>tx.execute<{acted:number|null;waiting:number|null}>(sql`select acted,waiting from app.automatic_chase_outcome_summary((now()-interval '30 days')) where action_id='lifecycle.step.chase'`));expect(raw).toEqual({acted:null,waiting:null});
  await expect(withTenant(await agent(),tx=>tx.execute(sql`select * from app.automatic_lifecycle_chased_stages(now()-interval '30 days')`))).rejects.toThrow();
 });
 it('observes a pending clock correction as no longer needing the record-gap nudge, without attesting work',async()=>{
  await enabled(clockKey);await run();expect((await assistantOutcomes(root,30)).automatic.find(r=>r.action==='attendance.missing_clock.remind')).toMatchObject({waiting:1,acted:0});
  await owner.db.insert(s.attendanceCorrection).values({tenantId:b.tenantId,employmentId:employee.employmentId,attendanceDate:yesterday(),proposedCheckIn:'09:00:00',reason:'Fictional waiting correction',status:'pending'});
  expect((await assistantOutcomes(root,30)).automatic.find(r=>r.action==='attendance.missing_clock.remind')).toMatchObject({waiting:0,acted:1});expect(await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,employee.employmentId))).toEqual([]);
 });
 it('records scoped outcome observations after renewal without calling it causal credit',async()=>{
  const [p]=await passport();await enabled(docKey);await run();let result=await assistantOutcomes(root,30);expect(result.automatic.find(r=>r.action==='employees.passport_expiry.remind')).toMatchObject({chased:1,items:1,waiting:1,acted:0});await owner.db.update(s.employeeStatutoryMy).set({passportExpiryDate:date(365)}).where(eq(s.employeeStatutoryMy.id,p.id));result=await assistantOutcomes(root,30);expect(result.automatic.find(r=>r.action==='employees.passport_expiry.remind')).toMatchObject({waiting:0,acted:1});expect(model.calls).toBe(0);
 });
});

describe('Additional source and recipient refusals',()=>{
 it('excludes recorded leave and pending clock-correction dates before the sweep',async()=>{
  const [leave]=await owner.db.insert(s.leaveRequest).values({tenantId:b.tenantId,employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:yesterday(),endDate:yesterday(),days:'1',status:'approved'}).returning();
  await owner.db.insert(s.leaveRequestDate).values({tenantId:b.tenantId,leaveRequestId:leave.id,subjectEmploymentId:employee.employmentId,leaveDate:yesterday(),days:'1',status:'approved'});await enabled(clockKey);
  expect((await withTenant(await agent(),tx=>followupItemsTx(tx,'missing_clock',today(),[employee.employmentId])))).toEqual([]);
  await owner.db.delete(s.leaveRequestDate).where(eq(s.leaveRequestDate.leaveRequestId,leave.id));await owner.db.insert(s.attendanceCorrection).values({tenantId:b.tenantId,employmentId:employee.employmentId,attendanceDate:yesterday(),proposedCheckIn:'09:00:00',reason:'Fictional correction waiting',status:'pending'});
  expect(await withTenant(await agent(),tx=>followupItemsTx(tx,'missing_clock',today(),[employee.employmentId]))).toEqual([]);
 });
 it('does not let another-company HR query a target source or receive its lifecycle notice',async()=>{
  await passport();const c=await lifecycle();await enabled(lifeKey);await run();const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional unrelated employer',country:'MY',currency:'MYR'}).returning();
  const userId=await createAppUser(b.tenantId,staff.personId,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:other.id}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...root,userId,personId:staff.personId,roles:['hr_admin' as const],grants:[{role:'hr_admin' as const,companyId:other.id}]};expect(await withTenant(who,tx=>followupItemsTx(tx,'passport_expiry',today(),[employee.employmentId]))).toEqual([]);
  await owner.db.delete(s.lcStaff).where(eq(s.lcStaff.tenantId,b.tenantId));await dispatchNotifications(root,{});expect(await owner.db.select().from(s.notification).where(eq(s.notification.kind,'lifecycle.step-waiting'))).toHaveLength(0);
 });
 it('suppresses renewed source immediately between candidate selection and its effect transaction',async()=>{
  const [p]=await passport();await enabled(docKey);const ctx=await agent(),real=dbClient.withTenant;
  const changed:typeof withTenant=async(who,work,opts)=>{await owner.db.update(s.employeeStatutoryMy).set({passportExpiryDate:date(365)}).where(eq(s.employeeStatutoryMy.id,p.id));return real(who,work,opts);};
  const spy=vi.spyOn(dbClient,'withTenant').mockImplementationOnce(real).mockImplementationOnce(changed);
  try{expect((await runAutomaticFollowups(ctx,{calendar:async()=>5})).sent).toBe(0);}finally{spy.mockRestore();}
  const foreignId=randomUUID();await expect(withTenant(ctx,tx=>tx.execute(sql`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${b.tenantId}::uuid,'employment',${foreignId}::uuid,'employment.terminated','agent',${ctx.agent!.principalId}::uuid,'{}'::jsonb)`))).rejects.toThrow();
 });
 it('rejects free-text or non-numeric data hidden in an otherwise valid reminder envelope',async()=>{
  await passport();await enabled(docKey);const ctx=await agent();const valid={action:'employees.passport_expiry.remind',source:'passport_expiry',stage:'passport:'+date(10),companyId:b.companyId,waitingOn:date(10),eligibleOn:today(),chaseNumber:1,...agentStamp(ctx,['document_reminders'])};
  for(const payload of [{...valid,privateName:'Fictional secret'},{...valid,chaseNumber:{privateName:'Fictional secret'}}])await expect(withTenant(ctx,tx=>tx.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'automatic-chase',aggregateId:employee.employmentId,eventType:FOLLOWUP_EVENT,actorType:'agent',actorId:ctx.agent!.principalId,subjectEmploymentId:employee.employmentId,payload}))).rejects.toThrow();
 });
 it('caps a passport run at 100 recorded subjects',async()=>{
  await passport();for(let n=0;n<100;n++){const e=await hire('Fictional bounded passport '+n);await passport(date(10),e.personId);}await enabled(docKey);const result=await run();expect(result.byAction['employees.passport_expiry.remind']).toMatchObject({sent:100,cappedOut:true});expect(await events()).toHaveLength(100);
 });
});
