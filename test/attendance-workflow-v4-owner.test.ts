import {listPendingTasks} from '../core/approvals-inbox';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,decideAttendanceCorrection,cancelAttendanceApplication,listAttendanceCorrections} from '../core/attendance';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled,previewAttendanceWorkflow,retireAttendanceWorkflow,restoreAttendanceWorkflow,listAttendanceWorkflows,listRetiredAttendanceWorkflows,decideAttendanceWorkflowStageTx} from '../core/attendance-workflow';
import {attendanceApplicationDetail,attendanceApplicationFilterOptions} from '../core/attendance-application-history';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {createNotificationEmailService} from '../deploy/identity-email/notifications';
import type {AttendanceV4WorkflowInput,AttendanceV4Mode} from '../lib/attendance-workflow-v4';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,createAppUser,owner,closeAll,migrateTestDb,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
async function actor(name:string,role:'employee'|'hr_admin'='employee',departmentId=base.deptB) {
 const email=`${randomUUID()}@example.invalid`;
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:email},companyId:base.companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 const ctx:SessionContext={...adminCtx(base),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:base.companyId}]};return{...hired,ctx,email};
}
async function fixture(mode:AttendanceV4Mode='all_required',applicationType:'irregularity'|'self_overtime'='irregularity',withCc=false) {
 const root=adminCtx(base),worker=await actor('Fictional v4 applicant','employee',base.deptA),first=await actor('Fictional v4 superior'),second=await actor('Fictional v4 selected participant'),hr=await actor('Fictional v4 final HR','hr_admin');
 const today=todayInKualaLumpur(),next=new Date(`${today}T12:00:00Z`);next.setUTCDate(next.getUTCDate()+1);const on=applicationType==='self_overtime'?next.toISOString().slice(0,10):today;
 await setReportingLine(root,{subordinateEmploymentId:worker.employmentId,managerEmploymentId:first.employmentId,lineType:'administrative',validFrom:today});
 if(applicationType==='irregularity'){await checkIn(root,{employmentId:worker.employmentId,date:on,time:'08:00',manual:true});await checkOut(root,{employmentId:worker.employmentId,date:on,time:'17:00',manual:true});}
 const input:AttendanceV4WorkflowInput={companyId:base.companyId,applicationType,routingVersion:4,code:'V4_ACCOUNTABLE',name:'Fictional mixed-source approval',priority:100,active:true,criteria:{employeeIds:[worker.employmentId]},stages:[{name:'Level 1',mode,sources:[{kind:'direct_manager',depth:1},{kind:'specific_employee',employmentIds:[second.employmentId]}],hrAlternative:false},{name:'Level 2',mode:'sequential',sources:[{kind:'specific_employee',employmentIds:[hr.employmentId]}],hrAlternative:false}],cc:withCc?[{kind:'direct_manager',depth:1},{kind:'specific_employee',employmentIds:[first.employmentId]},{kind:'custom_email',addresses:[first.email.toUpperCase(),'fictional-external@example.invalid']}]:[]};
 const template=await saveAttendanceWorkflow(root,input);await setAttendanceWorkflowEnabled(root,base.companyId,applicationType,true);
 const submit=()=>requestAttendanceCorrection(worker.ctx,{employmentId:worker.employmentId,date:on,...(applicationType==='self_overtime'?{requestedOtMinutes:60,requestKind:'self_overtime' as const}:{checkIn:'09:00',checkOut:'18:00'}),reason:'Fictional v4 verification'});
 const id=(await submit()).correctionId;return{root,worker,first,second,hr,input,template,id,on,submit};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const detail=async(f:Fixture)=>(await attendanceApplicationDetail(f.root,[base.companyId],f.id))!;
const decide=(f:Fixture,who:Fixture['first'],slot:string,decision:'approved'|'rejected'='approved')=>decideAttendanceCorrection(who.ctx,{correctionId:f.id,expectedStageIndex:0,expectedParticipantSlot:slot,decision,...(decision==='rejected'?{rejectReason:'Fictional rejection'}:{})});
const day=async(f:Fixture)=>(await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId,f.worker.employmentId),eq(schema.attendance.attendanceDate,f.on))).orderBy(asc(schema.attendance.id)))[0];
describe('v4 uses the immutable participant and final Attendance owners',()=>{
 it('exposes a real named v4 assignment through the canonical inbox without granting unrelated queues',async()=>{
  const f=await fixture('all_required');
  const modules={attendance:true,claims:true};
  expect(await listPendingTasks(f.second.ctx,[base.companyId],modules)).toEqual([
   expect.objectContaining({id:f.id,kind:'attendance',linkPath:'/approvals'})
  ]);
  expect(await listPendingTasks(f.worker.ctx,[base.companyId],modules)).toEqual([]);
  expect(await listPendingTasks(f.second.ctx,[base.companyId],{...modules,attendance:false})).toEqual([]);
  await decide(f,f.second,'0:1');
  expect(await listPendingTasks(f.second.ctx,[base.companyId],modules)).toEqual([]);
  expect(await listPendingTasks(f.first.ctx,[base.companyId],modules)).toEqual([
   expect.objectContaining({id:f.id,kind:'attendance',linkPath:'/approvals'})
  ]);
 });

 it.each(['irregularity','self_overtime'] as const)('accepts all-required decisions out of order for %s without a premature Attendance effect',async(type)=>{
  const f=await fixture('all_required',type),before=await detail(f),preview=await previewAttendanceWorkflow(f.root,f.input,f.template.lineageId);
  expect(preview.rows.find(row=>row.employmentId===f.worker.employmentId)?.resolvedStages).toEqual(before.workflow!.stages);
  expect(before.workflow!.stages[0].approvers.map(a=>[a.employmentId,a.slot])).toEqual([[f.first.employmentId,'0:0'],[f.second.employmentId,'0:1']]);
  expect(await listAttendanceCorrections(f.second.ctx,{status:'pending',companyIds:[base.companyId]})).toEqual(expect.arrayContaining([expect.objectContaining({id:f.id,canDecide:true})]));
  await decide(f,f.second,'0:1');let current=await detail(f);expect(current.workflow!.currentStage).toBe(0);expect(current.workflow!.decisions).toHaveLength(0);expect(current.workflow!.participantDecisions).toHaveLength(1);
  if(type==='irregularity')expect((await day(f)).checkInAt).toBe('08:00:00');
  await expect(decide(f,f.second,'0:1')).rejects.toThrow();await decide(f,f.first,'0:0');current=await detail(f);expect(current.workflow!.currentStage).toBe(1);expect(current.application.status).toBe('pending');
  await decideAttendanceCorrection(f.hr.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:1,expectedParticipantSlot:'1:0'});current=await detail(f);expect(current.application.status).toBe('approved');expect(current.workflow!.participantDecisions).toHaveLength(3);expect(current.workflow!.decisions).toHaveLength(2);
  if(type==='irregularity')expect((await day(f)).checkInAt).toBe('09:00:00');
 });
 it('sequential refuses the exact out-of-order click that all-required accepts',async()=>{const f=await fixture('sequential');await expect(decide(f,f.second,'0:1')).rejects.toThrow();expect((await detail(f)).workflow!.participantDecisions).toHaveLength(0);await decide(f,f.first,'0:0');expect((await detail(f)).workflow!.currentParticipantSlot).toBeNull();expect((await listAttendanceCorrections(f.second.ctx,{status:'pending'})).find(row=>row.id===f.id)?.canDecide).toBe(true);});
 it('serializes competing any-one clicks into one participant and one level completion',async()=>{const f=await fixture('any_one');const outcomes=await Promise.allSettled([decide(f,f.first,'0:0'),decide(f,f.second,'0:1')]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);const current=await detail(f);expect(current.workflow!.participantDecisions).toHaveLength(1);expect(current.workflow!.decisions).toHaveLength(1);expect(current.workflow!.currentStage).toBe(1);expect((await day(f)).checkInAt).toBe('08:00:00');});
 it('keeps the submitted sources and evidence after future configuration changes; rejection is terminal',async()=>{const f=await fixture(),before=await detail(f);await saveAttendanceWorkflow(f.root,{...f.input,stages:[f.input.stages[1]]},f.template.lineageId);await decide(f,f.second,'0:1','rejected');const current=await detail(f);expect(current.workflow!.stages).toEqual(before.workflow!.stages);expect(current.workflow!.templateVersion).toBe(1);expect(current.application.status).toBe('rejected');await expect(decide(f,f.first,'0:0')).rejects.toThrow();expect((await day(f)).checkInAt).toBe('08:00:00');});
 it('refuses self/duplicate identities and a caller-supplied administrator role that is absent from actual grants',async()=>{const f=await fixture();await expect(saveAttendanceWorkflow(f.root,{...f.input,stages:[{...f.input.stages[0],sources:[{kind:'specific_employee',employmentIds:[f.worker.employmentId]}]}]},f.template.lineageId)).rejects.toThrow();await expect(saveAttendanceWorkflow(f.root,{...f.input,stages:[{...f.input.stages[0],sources:[...f.input.stages[0].sources,{kind:'specific_employee',employmentIds:[f.first.employmentId]}]}]},f.template.lineageId)).rejects.toThrow();await expect(saveAttendanceWorkflow({...f.second.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},{...f.input,code:'FORGED',active:false})).rejects.toThrow();});
 it('explains no linked login and then exposes only the genuinely eligible named ID after linking',async()=>{const root=adminCtx(base);await hireEmployee(root,{person:{fullName:'Fictional unlinked worker',primaryEmail:`${randomUUID()}@example.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});const empty=await attendanceApplicationFilterOptions(root,[base.companyId]);expect(empty.approverEmployees).toEqual([]);expect(empty.approverAvailability).toBe('noLinkedLogin');const linked=await actor('Fictional linked approver');const populated=await attendanceApplicationFilterOptions(root,[base.companyId]);expect(populated.approverAvailability).toBe('available');expect(populated.approverEmployees).toEqual([expect.objectContaining({id:linked.employmentId,name:'Fictional linked approver'})]);});
});
describe('v4 final effects require fresh real-actor writes and the actual target day',()=>{
 async function readyForFinal(){
  const f=await fixture('all_required');
  await decide(f,f.second,'0:1');await decide(f,f.first,'0:0');
  expect((await detail(f)).workflow!.currentStage).toBe(1);
  return f;
 }
 async function rawFinal(tx:Tx,f:Fixture){
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${base.tenantId+':'+f.worker.employmentId},0))`);
  await tx.execute(sql`select id from public.attendance_correction where id=${f.id}::uuid for update`);
  const result=await decideAttendanceWorkflowStageTx(tx,f.hr.ctx,{correctionId:f.id,employmentId:f.worker.employmentId,decision:'approved',expectedStageIndex:1,expectedParticipantSlot:'1:0'});
  expect(result).toMatchObject({final:true,versionedFinalEffect:true});
  await tx.execute(sql`select app.attendance_workflow_begin_effect(${f.id}::uuid)`);
 }
 it('loses its exact-day capability when the final participant writing savepoint is released',async()=>{
  const f=await readyForFinal(),before=await detail(f),beforeDay=await day(f);
  let observedRelease=false;
  await expect(withTenant(f.hr.ctx,async tx=>{
   await tx.execute(sql`savepoint board2_v4_final_participant`);
   await rawFinal(tx,f);
   const [live]=await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as exact,
    app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date+1) as wrong_day,
    app.attendance_workflow_effect_scope(${f.second.employmentId}::uuid,${f.on}::date) as wrong_subject`) as unknown as {exact:boolean;wrong_day:boolean;wrong_subject:boolean}[];
   expect(live).toEqual({exact:true,wrong_day:false,wrong_subject:false});
   await tx.execute(sql`release savepoint board2_v4_final_participant`);
   const [released]=await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as allowed`) as unknown as {allowed:boolean}[];
   expect(released.allowed).toBe(false);observedRelease=true;
   throw new Error('Rollback after observing released v4 write refusal');
  })).rejects.toThrow('Rollback after observing released v4 write refusal');
  expect(observedRelease).toBe(true);
  const after=await detail(f);
  expect(after.application.status).toBe('pending');
  expect(after.workflow!.participantDecisions).toEqual(before.workflow!.participantDecisions);
  expect(after.workflow!.decisions).toEqual(before.workflow!.decisions);
  expect(await day(f)).toEqual(beforeDay);
 });
 it('refuses a fabricated effect audit event when no actual target-day result was written',async()=>{
  const f=await readyForFinal(),before=await detail(f),beforeDay=await day(f);
  await expect(withTenant(f.hr.ctx,async tx=>{
   await rawFinal(tx,f);
   await tx.insert(schema.domainEvent).values({tenantId:base.tenantId,aggregateType:'attendance-correction',aggregateId:f.id,eventType:'attendance-correction.effect.recorded',actorType:'user',actorId:f.hr.ctx.userId!,subjectEmploymentId:f.worker.employmentId,payload:{forged:true}});
   await tx.update(schema.attendanceCorrection).set({status:'approved',decidedByEmploymentId:f.hr.employmentId,decidedAt:sql`now()`}).where(eq(schema.attendanceCorrection.id,f.id));
  })).rejects.toMatchObject({cause:expect.objectContaining({code:'P0001',message:expect.stringContaining('verified canonical target-day effect')})});
  const after=await detail(f);
  expect(after.application.status).toBe('pending');
  expect(after.workflow!.participantDecisions).toEqual(before.workflow!.participantDecisions);
  expect(after.workflow!.decisions).toEqual(before.workflow!.decisions);
  expect(await day(f)).toEqual(beforeDay);
  expect(await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,f.id),eq(schema.domainEvent.eventType,'attendance-correction.effect.recorded')))).toEqual([]);
 });
 it('does not revive committed final approval by reinstalling its request hint',async()=>{
  const f=await readyForFinal();
  await decideAttendanceCorrection(f.hr.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:1,expectedParticipantSlot:'1:0'});
  const before=await detail(f),beforeDay=await day(f);
  expect(before.application.status).toBe('approved');expect(beforeDay.checkInAt).toBe('09:00:00');
  const [replay]=await withTenant(f.hr.ctx,async tx=>{
   await tx.execute(sql`select set_config('app.attendance_workflow_effect',${f.id},true)`);
   return tx.execute(sql`select app.principal_snapshot_current() as live_principal,app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as allowed`);
  }) as unknown as {live_principal:boolean;allowed:boolean}[];
  expect(replay).toEqual({live_principal:true,allowed:false});
  await expect(withTenant(f.hr.ctx,tx=>tx.execute(sql`select app.attendance_workflow_begin_effect(${f.id}::uuid)`))).rejects.toThrow();
  expect((await detail(f)).workflow!.decisions).toEqual(before.workflow!.decisions);
  expect(await day(f)).toEqual(beforeDay);
 });
});
describe('retirement preserves dependencies and requires a fresh revision',()=>{
 it('refuses a pending dependency in an older version and preserves its frozen route',async()=>{const f=await fixture(),before=await detail(f);const newer=await saveAttendanceWorkflow(f.root,{...f.input,name:'Fictional next version'},f.template.lineageId);await expect(retireAttendanceWorkflow(f.root,f.template.lineageId,newer.version)).rejects.toMatchObject({code:'inUse'});expect((await detail(f)).workflow!.stages).toEqual(before.workflow!.stages);expect(await listAttendanceWorkflows(f.root,[base.companyId])).toEqual([expect.objectContaining({version:2})]);});
 it('deletes future configuration, retains history, refuses no-match fallback and restores as a new version',async()=>{
  const f=await fixture();await decide(f,f.first,'0:0','rejected');await expect(retireAttendanceWorkflow(f.root,f.template.lineageId,f.template.version+1)).rejects.toMatchObject({code:'stale'});await retireAttendanceWorkflow(f.root,f.template.lineageId,f.template.version);expect(await listAttendanceWorkflows(f.root,[base.companyId])).toEqual([]);expect((await detail(f)).workflow!.templateVersion).toBe(1);expect(await listRetiredAttendanceWorkflows(f.root,[base.companyId])).toEqual([expect.objectContaining({lineageId:f.template.lineageId})]);
  await expect(f.submit()).rejects.toMatchObject({code:'noMatch'});const restored=await restoreAttendanceWorkflow(f.root,f.template.lineageId,1,[base.companyId]);expect(restored.version).toBe(2);expect((await detail(f)).workflow!.templateVersion).toBe(1);expect(await listRetiredAttendanceWorkflows(f.root,[base.companyId])).toEqual([]);
 });
 it('serializes a racing submission and retirement without losing a pending route',async()=>{const f=await fixture();await decide(f,f.first,'0:0','rejected');const outcomes=await Promise.allSettled([f.submit(),retireAttendanceWorkflow(f.root,f.template.lineageId,1)]);expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);const submitted=outcomes[0];if(submitted.status==='fulfilled'){const pending=await attendanceApplicationDetail(f.root,[base.companyId],submitted.value.correctionId);expect(pending!.application.status).toBe('pending');expect(pending!.workflow!.templateId).toBe(f.template.id);expect(await listAttendanceWorkflows(f.root,[base.companyId])).toHaveLength(1);}else{expect(await listAttendanceWorkflows(f.root,[base.companyId])).toEqual([]);expect(await listRetiredAttendanceWorkflows(f.root,[base.companyId])).toHaveLength(1);}});
 it('cannot bypass retirement checks by superseding a current version without a successor',async()=>{const f=await fixture();await expect(withTenant(f.root,tx=>tx.update(schema.attendanceWorkflowTemplate).set({supersededAt:new Date()}).where(eq(schema.attendanceWorkflowTemplate.id,f.template.id)))).rejects.toThrow();expect(await listAttendanceWorkflows(f.root,[base.companyId])).toHaveLength(1);});
});
describe('CC outbox follows real committed actions only',()=>{
 it('queues each genuine participant action once per normalized recipient without including private remarks',async()=>{const f=await fixture('all_required','irregularity',true);expect((await owner.client`select count(*)::int n from attendance_workflow_cc_delivery`)[0].n).toBe(0);await decideAttendanceCorrection(f.first.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0',remarks:'Private medical and payroll detail must never leave the app'});let rows=await owner.client`select * from attendance_workflow_cc_delivery order by address,id`;expect(rows).toHaveLength(2);for(const row of rows){expect(row.message).toEqual({reference:f.id,applicant:'Fictional v4 applicant',level:1,action:'approved',actor:'Fictional v4 superior',occurredAt:expect.any(String)});expect(JSON.stringify(row.message)).not.toContain('Private medical');}await expect(decide(f,f.first,'0:0')).rejects.toThrow();expect((await owner.client`select count(*)::int n from attendance_workflow_cc_delivery`)[0].n).toBe(2);await decide(f,f.second,'0:1');rows=await owner.client`select * from attendance_workflow_cc_delivery order by created_at,id`;expect(rows).toHaveLength(4);});
 it.each(['cancelled','withdrawn'] as const)('queues the genuine configured %s action once and excludes its reason',async(kind)=>{const f=await fixture('all_required','irregularity',true);await cancelAttendanceApplication(f.root,{correctionId:f.id,kind,reason:'Private cancellation explanation'});const rows=await owner.client`select message from attendance_workflow_cc_delivery order by address,id`;expect(rows).toHaveLength(2);for(const row of rows){expect(row.message.action).toBe(kind);expect(JSON.stringify(row.message)).not.toContain('Private cancellation');}await expect(cancelAttendanceApplication(f.root,{correctionId:f.id,kind,reason:'Duplicate'})).rejects.toThrow();expect((await owner.client`select count(*)::int n from attendance_workflow_cc_delivery`)[0].n).toBe(2);});
 it('rolls back both participant evidence and queued mail on a rejected transaction',async()=>{const f=await fixture('all_required','irregularity',true);await owner.client`CREATE FUNCTION public.board2_refuse_cc_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='attendance-workflow.participant.decided' THEN RAISE EXCEPTION 'Fictional rollback witness'; END IF; RETURN NEW; END $$`;await owner.client`CREATE TRIGGER board2_refuse_cc_event AFTER INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION public.board2_refuse_cc_event()`;try{await expect(decide(f,f.first,'0:0')).rejects.toThrow();expect((await detail(f)).workflow!.participantDecisions).toHaveLength(0);expect((await owner.client`select count(*)::int n from attendance_workflow_cc_delivery`)[0].n).toBe(0);}finally{await owner.client`DROP TRIGGER board2_refuse_cc_event ON domain_event`;await owner.client`DROP FUNCTION public.board2_refuse_cc_event()`;}});
});

/** Real SQL leases and private ports; SMTP is always a fictional capture. */
const ccIssuer='https://fictional.example.invalid/identity/realms/ai-hr';
async function deliveryFixture() {
 await setModule(base.tenantId,'notifications','active');
 const f=await fixture('all_required','irregularity',true);
 const subject=randomUUID();
 await owner.db.insert(schema.appExternalIdentity).values({issuer:ccIssuer,subject,appUserId:f.first.ctx.userId!});
 await saveNotificationEmailPolicy(f.root,['attendance']);
 await saveNotificationEmailPreferences(f.first.ctx,f.first.employmentId,['attendance'],'en',{
  issuer:ccIssuer,subject,email:f.first.email,emailVerified:true,
 });
 await decide(f,f.first,'0:0');
 return f;
}
async function claimCc(ctx:SessionContext,token=randomUUID(),companies:string[]|null=null) {
 const ids=await withTenant(ctx,tx=>tx.execute(sql`select app.attendance_workflow_cc_claim(${token}::uuid,${companies===null?sql`null::uuid[]`:sql`ARRAY[${sql.join(companies.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`}) as id`)) as unknown as {id:string}[];
 return{token,ids:ids.map(row=>row.id)};
}
async function ccRows() {return owner.client`select * from attendance_workflow_cc_delivery order by created_at,address,id`;}
async function ccTarget(id:string,token:string) {
 return(await owner.client`select identity_email.attendance_cc_target(${id}::uuid,${token}::uuid,${ccIssuer}) as target`)[0].target;
}
function capturedCcService(send=vi.fn(async()=>{})) {
 return{send,service:createNotificationEmailService({
  origin:'https://fictional.example.invalid',ready:async()=>true,target:async()=>null,
  verifyRecipient:async()=> 'verified',start:async()=>false,finish:async()=>false,send,
  cc:{target:ccTarget,
   start:async(id,token,target)=>(await owner.client`select identity_email.start_attendance_cc(${id}::uuid,${token}::uuid,${ccIssuer},${JSON.stringify(target)}::text::jsonb) as ok`)[0].ok,
   finish:async(id,token,outcome,error)=>(await owner.client`select identity_email.finish_attendance_cc(${id}::uuid,${token}::uuid,${outcome},${error}) as ok`)[0].ok,
  },
 })};
}
describe('CC delivery rechecks canonical eligibility at the private database boundary',()=>{
 it('captures internal and external destinations once, with the exact frozen decision and no attachments',async()=>{
  const f=await deliveryFixture(),{token,ids}=await claimCc(f.root),{send,service}=capturedCcService();
  expect(ids).toHaveLength(2);
  for(const id of ids)expect(await service({op:'attendanceCcSend',deliveryId:id,leaseToken:token})).toEqual({outcome:'sent'});
  expect(send).toHaveBeenCalledTimes(2);
  for(const [recipient,mail] of send.mock.calls as unknown as [Record<string,unknown>,Record<string,unknown>][]) {
   expect([f.first.email,'fictional-external@example.invalid']).toContain(recipient.email);
   expect(mail.attendanceCc).toEqual({reference:f.id,applicant:'Fictional v4 applicant',level:1,action:'approved',actor:'Fictional v4 superior',occurredAt:expect.any(String)});
   expect(mail).not.toHaveProperty('attachments');expect(mail).not.toHaveProperty('approvalToken');
  }
  expect((await ccRows()).map(row=>[row.status,row.attempts])).toEqual([['sent',1],['sent',1]]);
  expect((await claimCc(f.root)).ids).toEqual([]);
  for(const id of ids)await service({op:'attendanceCcSend',deliveryId:id,leaseToken:token});
  expect(send).toHaveBeenCalledTimes(2);
 });
 it('does not let a scoped dispatcher claim or expire another company’s occurrences, even with a null filter',async()=>{
  const f=await deliveryFixture();
  const [foreign]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional out-of-scope company',country:'MY'}).returning();
  const scoped={...f.root,grants:[{role:'hr_admin' as const,companyId:foreign.id}]};
  expect((await claimCc(scoped)).ids).toEqual([]);
  expect((await claimCc(scoped,randomUUID(),[base.companyId])).ids).toEqual([]);
  expect((await ccRows()).every(row=>row.lease_token===null&&row.started_at===null)).toBe(true);
  const {token,ids}=await claimCc(f.root);
  await owner.client`update attendance_workflow_cc_delivery set started_at=now(),attempts=1,lease_until=now()-interval '1 second' where id=${ids[0]}::uuid`;
  await claimCc(scoped);
  expect((await ccRows()).find(row=>row.id===ids[0])).toMatchObject({status:'pending',lease_token:token});
  await claimCc(f.root);
  expect((await ccRows()).find(row=>row.id===ids[0])).toMatchObject({status:'uncertain',lease_token:null,last_error:'uncertain'});
 });
 it.each(['role','identity','consent','policy','archive','address','employment'] as const)('refuses the frozen internal destination after %s changes without suppressing unrelated custom delivery',async(change)=>{
  const f=await deliveryFixture(),{token}=await claimCc(f.root);
  const rows=await ccRows(),internal=rows.find(row=>row.recipient_kind==='employee')!,external=rows.find(row=>row.recipient_kind==='custom_email')!;
  expect(await ccTarget(internal.id,token)).toMatchObject({kind:'employee',userId:f.first.ctx.userId,email:f.first.email});
  if(change==='role')await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,f.first.ctx.userId!));
  if(change==='identity')await owner.db.update(schema.appExternalIdentity).set({revokedAt:new Date()}).where(eq(schema.appExternalIdentity.appUserId,f.first.ctx.userId!));
  if(change==='consent')await saveNotificationEmailPreferences(f.first.ctx,f.first.employmentId,[],'en',null);
  if(change==='policy')await saveNotificationEmailPolicy(f.root,[]);
  if(change==='archive')await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,f.first.ctx.userId!));
  if(change==='address')await owner.db.update(schema.person).set({primaryEmail:'changed@example.invalid'}).where(eq(schema.person.id,f.first.personId));
  if(change==='employment')await owner.db.update(schema.employment).set({blacklistedAt:todayInKualaLumpur()}).where(eq(schema.employment.id,f.first.employmentId));
  expect(await ccTarget(internal.id,token)).toBeNull();
  const {send,service}=capturedCcService();
  expect(await service({op:'attendanceCcSend',deliveryId:internal.id,leaseToken:token})).toEqual({outcome:'skipped'});
  expect(send).not.toHaveBeenCalled();
  if(change==='policy')expect(await ccTarget(external.id,token)).toBeNull();
  else expect(await ccTarget(external.id,token)).toMatchObject({kind:'custom_email',email:'fictional-external@example.invalid'});
 });
 it('does not reinterpret a custom address as an employee or bypass their consent after the route was frozen',async()=>{
  const f=await deliveryFixture(),{token}=await claimCc(f.root),external=(await ccRows()).find(row=>row.recipient_kind==='custom_email')!;
  expect(await ccTarget(external.id,token)).toMatchObject({kind:'custom_email'});
  await hireEmployee(f.root,{person:{fullName:'Fictional newly linked destination',primaryEmail:external.address},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  expect(await ccTarget(external.id,token)).toBeNull();
  const {send,service}=capturedCcService();expect(await service({op:'attendanceCcSend',deliveryId:external.id,leaseToken:token})).toEqual({outcome:'skipped'});expect(send).not.toHaveBeenCalled();
 });
 it('rechecks a changed target at atomic start and admits only one concurrent start for an exact live lease',async()=>{
  const f=await deliveryFixture(),{token}=await claimCc(f.root),internal=(await ccRows()).find(row=>row.recipient_kind==='employee')!,expected=await ccTarget(internal.id,token);
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,f.first.ctx.userId!));
  expect((await owner.client`select identity_email.start_attendance_cc(${internal.id}::uuid,${token}::uuid,${ccIssuer},${JSON.stringify(expected)}::text::jsonb) as ok`)[0].ok).toBe(false);
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:f.first.ctx.userId!,role:'employee',companyId:base.companyId});
  const start=()=>owner.client`select identity_email.start_attendance_cc(${internal.id}::uuid,${token}::uuid,${ccIssuer},${JSON.stringify(expected)}::text::jsonb) as ok`;
  expect((await Promise.all([start(),start()])).filter(rows=>rows[0].ok)).toHaveLength(1);
  expect((await ccRows()).find(row=>row.id===internal.id)).toMatchObject({attempts:1,status:'pending'});
 });
 it('bounds explicit temporary SMTP retries at five and never retries an uncertain acknowledgement',async()=>{
  const f=await deliveryFixture(),external=(await ccRows()).find(row=>row.recipient_kind==='custom_email')!;
  const send=vi.fn(async()=>{throw{responseCode:451};}),{service}=capturedCcService(send);
  for(let attempt=1;attempt<=5;attempt++) {
   const {token,ids}=await claimCc(f.root);expect(ids).toContain(external.id);
   expect(await service({op:'attendanceCcSend',deliveryId:external.id,leaseToken:token})).toEqual({outcome:'retry'});
   expect((await ccRows()).find(row=>row.id===external.id)).toMatchObject({status:attempt===5?'failed':'pending',attempts:attempt,last_error:'smtpTemporary',lease_token:null});
   if(attempt<5)await owner.client`update attendance_workflow_cc_delivery set next_attempt_at=now() where id=${external.id}::uuid`;
  }
  expect((await claimCc(f.root)).ids).not.toContain(external.id);expect(send).toHaveBeenCalledTimes(5);
  await decide(f,f.second,'0:1');
  const next=(await ccRows()).filter(row=>row.recipient_kind==='custom_email'&&row.id!==external.id);expect(next).toHaveLength(1);
  const {token}=await claimCc(f.root),uncertain=vi.fn(async()=>{throw{code:'ECONNRESET'};});
  expect(await capturedCcService(uncertain).service({op:'attendanceCcSend',deliveryId:next[0].id,leaseToken:token})).toEqual({outcome:'uncertain'});
  expect((await ccRows()).find(row=>row.id===next[0].id)).toMatchObject({status:'uncertain',attempts:1});
  expect((await claimCc(f.root)).ids).not.toContain(next[0].id);expect(uncertain).toHaveBeenCalledOnce();
 });
 it('exposes no private delivery functions or writable queue to the application role',async()=>{
  const f=await deliveryFixture(),{token}=await claimCc(f.root),job=(await ccRows())[0];
  await expect(withTenant(f.root,tx=>tx.execute(sql`select identity_email.attendance_cc_target(${job.id}::uuid,${token}::uuid,${ccIssuer})`))).rejects.toThrow();
  await expect(withTenant(f.root,tx=>tx.execute(sql`update attendance_workflow_cc_delivery set status='sent' where id=${job.id}::uuid`))).rejects.toThrow();
  await expect(withTenant(f.root,tx=>tx.execute(sql`delete from attendance_workflow_cc_delivery where id=${job.id}::uuid`))).rejects.toThrow();
  const foreign=await seedBase();expect((await claimCc(adminCtx(foreign))).ids).toEqual([]);
  expect(await withTenant(f.first.ctx,tx=>tx.execute(sql`select id from attendance_workflow_cc_delivery`))).toEqual([]);
 });
});
