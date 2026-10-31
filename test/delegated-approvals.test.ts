/** Owner-approved delegated approvals: real DB, native services and Assistant custody; fictional fixtures.
 * Authored for GitHub Actions only. No installation or provider request. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {setCompensation} from '../core/comp';
import {setRestDay} from '../core/roster';
import {grantAssistant} from '../core/assistant-grant';
import {withApprovalDelegatesTx} from '../core/notifications';
import {withDelegatedRequestEffectTx} from '../core/delegated-request-effect';
import {createClaimType,setClaimPolicy,submitClaim,decideClaim,listPendingClaims,pendingClaimTaskMetadata,pendingClaimTaskSummary} from '../packs/claims/service';
import {requestAttendanceCorrection,decideAttendanceCorrection,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../packs/attendance/service';
import {setToilPolicy,submitReplacementLeaveRequest,decideReplacementLeaveRequest,listPendingReplacementLeaveRequests,listPendingReplacementLeaveTasks} from '../packs/leave/service';
import {claimDecisionReviews,attendanceDecisionReviews,toilDecisionReviews,readClaimDecisionChoices,readAttendanceDecisionChoices,readToilDecisionChoices} from '../core/assistant-actions/assigned-decision-review-store';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={employmentId:string;personId:string};
let b:Base,root:SessionContext,subject:Person,manager:Person,stand:Person,me:SessionContext,delegate:SessionContext,lineId:string,claimTypeId:string;
const day=(n:number)=>{const d=new Date(todayInKualaLumpur()+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
async function hire(name:string,dept:string=b.deptB){return hireEmployee(root,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:dept,employmentType:'full_time',hiredOn:'2020-01-01'});}
async function login(p:Person,role:'employee'|'manager'){
 const userId=await createAppUser(b.tenantId,p.personId,role);await grantAssistant(root,{appUserId:userId});
 return {...await entitledCtx(b,[role]),userId,personId:p.personId,grants:[{role,companyId:null}]} satisfies SessionContext;
}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-delegation-custody-secret-2026');await resetDb();b=await seedBase();
 for(const code of ['assistant','claims','attendance','toil'])await setModule(b.tenantId,code,'active');
 root={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 subject=await hire('Fictional Claim Subject',b.deptA);manager=await hire('Fictional Manager');stand=await hire('Fictional Stand-in');
 const report=await hire('Fictional Stand-in Report');
 for(const [sub,mgr] of [[subject,manager],[report,stand]])await setReportingLine(root,{subordinateEmploymentId:sub.employmentId,managerEmploymentId:mgr.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const line=await setReportingLine(root,{subordinateEmploymentId:manager.employmentId,managerEmploymentId:stand.employmentId,lineType:'delegate',validFrom:'2020-01-01'});lineId=line.reportingLineId;
 await login(manager,'manager');delegate=await login(stand,'manager');me=await login(subject,'employee');
 await setCompensation(root,{employmentId:subject.employmentId,basicSalary:8000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
 await setToilPolicy(root,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true});
 claimTypeId=(await createClaimType(root,{code:'DELEGATE',name:'Fictional taxi',defaultTaxable:true,requiresReceipt:false})).id;
 await setClaimPolicy(root,{claimTypeId,annualBudget:10000,perClaimCap:1000,effectiveFrom:'2020-01-01'});
});
async function claim(amount=42){return (await submitClaim(me,{employmentId:subject.employmentId,claimTypeId,amount,incurredOn:todayInKualaLumpur(),description:'Fictional taxi'})).id;}
async function attendance(workflow=false){
 if(workflow){await saveAttendanceWorkflow(root,{companyId:b.companyId,code:'DELEGATE_OT',name:'Fictional delegated OT',applicationType:'self_overtime',priority:100,criteria:{departmentIds:[b.deptA]},stages:[{name:'Manager',level:{kind:'direct_manager',employmentId:null,alternates:[]}}],active:true});await setAttendanceWorkflowEnabled(root,b.companyId,'self_overtime',true);}
 return (await requestAttendanceCorrection(me,{employmentId:subject.employmentId,date:day(7),plannedStartTime:'18:00',plannedEndTime:'19:00',requestedOtMinutes:60,reason:'Fictional planned release work',requestKind:'self_overtime'})).correctionId;
}
async function toil(){await setRestDay(root,{employmentId:subject.employmentId,shiftDate:day(-3)});return (await submitReplacementLeaveRequest(me,{employmentId:subject.employmentId,unit:'day',lines:[{workedDate:day(-3),days:1}],reason:'Fictional rest-day support',today:todayInKualaLumpur()})).requestId;}
async function noPersonnel(){
 await withTenant(delegate,async tx=>{
  expect(await tx.select().from(schema.employment).where(eq(schema.employment.id,subject.employmentId))).toEqual([]);
  expect(await tx.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId,subject.employmentId))).toEqual([]);
 });
}
const kinds={
 claim:{action:'approvals.claim.decide',store:claimDecisionReviews,choices:readClaimDecisionChoices,create:()=>claim(),native:(id:string,decision:'approved'|'rejected')=>decideClaim(delegate,{claimRequestId:id,decision:decision==='approved'?'approve':'reject'}),table:'claim_request',event:'claim-request.'},
 attendance:{action:'approvals.attendance.decide',store:attendanceDecisionReviews,choices:readAttendanceDecisionChoices,create:()=>attendance(),native:(id:string,decision:'approved'|'rejected')=>decideAttendanceCorrection(delegate,{correctionId:id,decision,...(decision==='rejected'?{rejectReason:'Fictional refusal'}:{})}),table:'attendance_correction',event:'attendance-correction.'},
 toil:{action:'approvals.toil.decide',store:toilDecisionReviews,choices:readToilDecisionChoices,create:()=>toil(),native:(id:string,decision:'approved'|'rejected')=>decideReplacementLeaveRequest(delegate,{requestId:id,decision,note:'Fictional decision'}),table:'replacement_leave_request',event:'replacement-leave-request.'},
};
describe.each(Object.keys(kinds) as (keyof typeof kinds)[])('delegated %s decisions',name=>{
 it.each(['approved','rejected'] as const)('the native service records the stand-in as the final %s actor, with no Personnel inheritance',async decision=>{
  const k=kinds[name],id=await k.create();await noPersonnel();
  if(name==='attendance'&&decision==='approved')await withTenant(delegate,async tx=>{
   const identity=await tx.execute(sql`select * from app.delegated_request_effect_identity(${id}::uuid,'attendance')`);expect(identity).toHaveLength(1);
  });
  await k.native(id,decision);
  const [row]=await owner.db.execute<{status:string}>(sql`select status::text as status from ${sql.raw(k.table)} where id=${id}::uuid`);expect(row.status).toBe(decision);
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,id));
  expect(events.filter(e=>e.eventType===k.event+decision)).toEqual([expect.objectContaining({actorId:delegate.userId,actorType:'user',subjectEmploymentId:subject.employmentId})]);
  if(name==='toil'&&decision==='approved'){
   const lots=await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId,subject.employmentId));expect(lots).toHaveLength(1);
   expect(Number(lots[0].daysCredited)).toBe(1);
  }
  await noPersonnel();
 });
 it('offers, prepares, confirms and reopens the same stand-in receipt through the Assistant',async()=>{
  const k=kinds[name],id=await k.create();expect(JSON.stringify(await k.choices(delegate))).toContain(id);
  const prepared=await k.store.prepare(delegate,{action:k.action,contractVersion:1,employmentId:subject.employmentId,subjectId:id,decision:'approved',...(name==='toil'?{note:'Fictional decision'}:{})});
  const packet={actionId:prepared.review.actionId,reviewedDigest:prepared.review.reviewedDigest};
  expect((await k.store.confirm(delegate,packet)).kind).toBe('completed');
  expect((await k.store.confirm(delegate,packet)).kind).toBe('completed');
  await noPersonnel();
 });
 it.each(['expired','wrong_module'] as const)('refuses a %s delegation on source read, preparation and native decision',async mode=>{
  const k=kinds[name],id=await k.create();
  if(mode==='expired')await owner.db.update(schema.reportingLine).set({validTo:day(-1)}).where(eq(schema.reportingLine.id,lineId));
  else await owner.db.insert(schema.reportingLineScope).values({tenantId:b.tenantId,reportingLineId:lineId,module:name==='claim'?'leave':'claims',taskType:name==='claim'?'leave.application':'claims.claim'});
  expect(JSON.stringify(await k.choices(delegate))).not.toContain(id);
  await expect(k.native(id,'approved')).rejects.toThrow();
  await expect(k.store.prepare(delegate,{action:k.action,contractVersion:1,employmentId:subject.employmentId,subjectId:id,decision:'approved'})).rejects.toThrow();
 });
});

describe('request-bound delegated approval effects',()=>{
 it('lists narrow names in native claims and replacement inboxes and task metadata',async()=>{
  const c=await claim(),t=await toil();
  expect((await listPendingClaims(delegate)).map(r=>r.id)).toContain(c);
  expect((await pendingClaimTaskMetadata(delegate)).map(r=>r.id)).toContain(c);
  expect((await listPendingReplacementLeaveRequests(delegate)).map(r=>r.id)).toContain(t);
  expect((await listPendingReplacementLeaveTasks(delegate)).map(r=>r.id)).toContain(t);
  await noPersonnel();
 });
 it.each(['approved','rejected'] as const)('confirms the routed attendance delegate %s cell that WP8 declared narrower',async decision=>{
  const id=await attendance(true),k=kinds.attendance;
  const prepared=await k.store.prepare(delegate,{action:k.action,contractVersion:1,employmentId:subject.employmentId,subjectId:id,decision,...(decision==='rejected'?{note:'Fictional refusal'}:{})});
  const done=await k.store.confirm(delegate,{actionId:prepared.review.actionId,reviewedDigest:prepared.review.reviewedDigest});expect(done.kind).toBe('completed');
  await noPersonnel();
 });
 it('keeps the counted claim preview aligned with delegated metadata outside Personnel visibility',async()=>{
  const id=await claim();await noPersonnel();
  const full=await pendingClaimTaskMetadata(delegate),preview=await pendingClaimTaskSummary(delegate,undefined,25);
  expect(full.map(row=>row.id)).toContain(id);expect(preview.total).toBe(full.length);expect(preview.items).toEqual(full.slice(0,25));
  expect(await pendingClaimTaskSummary(delegate,[],25)).toEqual({items:[],total:0});
  await owner.db.insert(schema.reportingLineScope).values({tenantId:b.tenantId,reportingLineId:lineId,module:'leave',taskType:'leave.application'});
  expect(await pendingClaimTaskMetadata(delegate)).toEqual([]);
  expect(await pendingClaimTaskSummary(delegate,undefined,25)).toEqual({items:[],total:0});await noPersonnel();
 });
 it('requires explicit company coverage for a stand-in in another company',async()=>{
  const id=await claim();const company=await createCompany(root,{legalName:'Fictional Other Company',country:'MY',currency:'MYR'});
  await owner.db.update(schema.employment).set({companyId:company.id}).where(eq(schema.employment.id,stand.employmentId));
  expect(JSON.stringify(await readClaimDecisionChoices(delegate))).not.toContain(id);
  await expect(decideClaim(delegate,{claimRequestId:id,decision:'approve'})).rejects.toThrow();
  await owner.db.update(schema.reportingLine).set({scopeCompanyId:b.companyId}).where(eq(schema.reportingLine.id,lineId));
  await decideClaim(delegate,{claimRequestId:id,decision:'approve'});
  const [q]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,id));expect(q.status).toBe('approved');await noPersonnel();
 });
 it('fans out only to active matching delegates of the nominated approver',async()=>{
  const read=()=>withTenant(root,tx=>withApprovalDelegatesTx(tx,subject.employmentId,'claims','claims.claim',[manager.employmentId]));
  expect(await read()).toEqual([manager.employmentId,stand.employmentId]);
  await owner.db.insert(schema.reportingLineScope).values({tenantId:b.tenantId,reportingLineId:lineId,module:'leave',taskType:'leave.application'});
  expect(await read()).toEqual([manager.employmentId]);
  expect(await withTenant(delegate,tx=>tx.execute(sql`select * from app.active_delegate_employments(${subject.employmentId}::uuid,'leave','leave.application',ARRAY[${manager.employmentId}::uuid])`))).toHaveLength(0);
 });
 it('adds replacement leave to the existing on-behalf history owner',async()=>{
  const id=await toil();await decideReplacementLeaveRequest(delegate,{requestId:id,decision:'rejected',note:'Fictional refusal'});
  const rows=await withTenant(root,tx=>tx.execute<{aggregate_id:string;on_behalf_of_employment_id:string}>(sql`select * from app.approval_history(NULL,NULL,ARRAY['replacement-leave-request']::text[],NULL,NULL,50,0)`));
  expect(rows).toEqual([expect.objectContaining({aggregate_id:id,on_behalf_of_employment_id:manager.employmentId})]);
 });
 it('does not let a foreign-tenant scope row influence this delegation',async()=>{
  const id=await claim(),other=await seedBase();
  await owner.db.insert(schema.reportingLineScope).values({tenantId:other.tenantId,reportingLineId:lineId,module:'leave',taskType:'leave.application'});
  expect(JSON.stringify(await readClaimDecisionChoices(delegate))).toContain(id);
  // A foreign matching row must not reopen a real tenant's wrong-module restriction either.
  await owner.db.insert(schema.reportingLineScope).values({tenantId:b.tenantId,reportingLineId:lineId,module:'leave',taskType:'leave.application'});
  await owner.db.insert(schema.reportingLineScope).values({tenantId:other.tenantId,reportingLineId:lineId,module:'claims',taskType:'claims.claim'});
  expect(JSON.stringify(await readClaimDecisionChoices(delegate))).not.toContain(id);
  await expect(decideClaim(delegate,{claimRequestId:id,decision:'approve'})).rejects.toThrow();
  await owner.db.delete(schema.reportingLineScope).where(and(eq(schema.reportingLineScope.tenantId,b.tenantId),eq(schema.reportingLineScope.reportingLineId,lineId)));
  await decideClaim(delegate,{claimRequestId:id,decision:'approve'});
 });
 it('clamps history for company HR even though the inherited function used admin-somewhere',async()=>{
  const own=await claim();await decideClaim(root,{claimRequestId:own,decision:'reject'});
  const company=await createCompany(root,{legalName:'Fictional History Other Company',country:'MY',currency:'MYR'});
  const dept=await createDepartment(root,{companyId:company.id,name:'Fictional Other Department'});
  const employee=await hireEmployee(root,{person:{fullName:'Fictional Hidden Claimant',primaryEmail:randomUUID()+'@fixture.test'},companyId:company.id,departmentId:dept.id,employmentType:'full_time',hiredOn:'2020-01-01'});
  const foreign=(await submitClaim(root,{employmentId:employee.employmentId,claimTypeId,amount:42,incurredOn:todayInKualaLumpur()})).id;
  await decideClaim(root,{claimRequestId:foreign,decision:'reject'});
  const userId=await createAppUser(b.tenantId,stand.personId,'hr_admin');
  await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,userId));
  const scoped={...await entitledCtx(b,['hr_admin']),userId,personId:stand.personId,grants:[{role:'hr_admin' as const,companyId:b.companyId}]};
  const rows=await withTenant(scoped,tx=>tx.execute<{aggregate_id:string}>(sql`select * from app.approval_history(NULL,NULL,ARRAY['claim-request']::text[],NULL,NULL,50,0)`));
  expect(rows.map(r=>r.aggregate_id)).toEqual([own]);
 });
 it('uses the real subject grade on approval, never the more generous no-grade policy',async()=>{
  const [g]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'LIMITED',name:'Limited',rank:1}).returning({id:schema.jobGrade.id});
  await owner.db.update(schema.employment).set({gradeId:g.id}).where(eq(schema.employment.id,subject.employmentId));
  const id=await claim(200);
  await setClaimPolicy(root,{claimTypeId,gradeId:g.id,annualBudget:100,perClaimCap:1000,effectiveFrom:todayInKualaLumpur()});
  await expect(decideClaim(delegate,{claimRequestId:id,decision:'approve'})).rejects.toThrow();
  const [q]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,id));expect(q.status).toBe('pending');
  const facts=await withTenant(delegate,tx=>tx.execute<{grade_id:string}>(sql`select * from app.claim_decision_subject_facts(${id}::uuid)`));expect(facts[0].grade_id).toBe(g.id);
  await noPersonnel();
 });
 it('counts earlier settled claims against the same subject limit',async()=>{
  const first=await claim(80),second=await claim(80);
  await decideClaim(root,{claimRequestId:first,decision:'approve'});
  await setClaimPolicy(root,{claimTypeId,annualBudget:100,perClaimCap:1000,effectiveFrom:todayInKualaLumpur()});
  await expect(decideClaim(delegate,{claimRequestId:second,decision:'approve'})).rejects.toThrow();
  const rows=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.employmentId,subject.employmentId));
  expect(rows.find(r=>r.id===first)?.status).toBe('approved');expect(rows.find(r=>r.id===second)?.status).toBe('pending');
 });
 it('reads non-draft receipts without exposing drafts or their receipts',async()=>{
  const id=await claim(),[q]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,id));
  const draft=randomUUID();await owner.db.insert(schema.claimRequest).values({...q,id:draft,status:'draft'});
  for(const claimRequestId of [id,draft])await owner.db.insert(schema.claimAttachment).values({tenantId:b.tenantId,claimRequestId,employmentId:subject.employmentId,fileName:'fictional.txt',mimeType:'text/plain',content:Buffer.from('fictional'),sizeBytes:9});
  await withTenant(delegate,async tx=>{
   expect((await tx.select().from(schema.claimRequest).where(eq(schema.claimRequest.employmentId,subject.employmentId))).map(r=>r.id)).toEqual([id]);
   expect((await tx.select().from(schema.claimAttachment).where(eq(schema.claimAttachment.employmentId,subject.employmentId))).map(r=>r.claimRequestId)).toEqual([id]);
  });
 });
 it('does not let a live alternate account authorise an archived calling login',async()=>{
  await claim();await createAppUser(b.tenantId,stand.personId,'manager');
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,delegate.userId!));
  const [row]=await withTenant(delegate,tx=>tx.execute<{ok:boolean}>(sql`select app.can_decide_via_delegation(${subject.employmentId}::uuid,'claims','claims.claim') as ok`));expect(row.ok).toBe(false);
 });
 it('does not grant DELETE, editing amounts, or general decision-event visibility',async()=>{
  const id=await claim();
  await withTenant(delegate,async tx=>{
   const deleted=await tx.delete(schema.claimRequest).where(eq(schema.claimRequest.id,id)).returning({id:schema.claimRequest.id});expect(deleted).toEqual([]);
   await expect(tx.transaction(inner=>inner.update(schema.claimRequest).set({status:'approved',amount:'999.00'}).where(eq(schema.claimRequest.id,id)))).rejects.toThrow();
   const foreign=await tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId,subject.employmentId));expect(foreign).toEqual([]);
  });
 });
 it('restores caller settings after success and SQL failure under the request-bound identity',async()=>{
  const id=await toil();
  await withTenant(delegate,async tx=>{
   const snapshot=()=>tx.execute(sql`select current_setting('app.user_id') as u,current_setting('app.roles') as r,current_setting('app.grants') as g`);
   const before=await snapshot();
   await withDelegatedRequestEffectTx(tx,delegate,{id,kind:'replacement_leave',employmentId:subject.employmentId},async effectTx=>{
    const [e]=await effectTx.select().from(schema.employment).where(eq(schema.employment.id,subject.employmentId));expect(e.id).toBe(subject.employmentId);
   });expect(await snapshot()).toEqual(before);
   await expect(withDelegatedRequestEffectTx(tx,delegate,{id,kind:'replacement_leave',employmentId:subject.employmentId},effectTx=>effectTx.execute(sql`select 1/0`))).rejects.toThrow();expect(await snapshot()).toEqual(before);
   expect(await tx.select().from(schema.employment).where(eq(schema.employment.id,subject.employmentId))).toEqual([]);
  });
 });
 it('refuses the subject deciding their own claim and another tenant resolving the request',async()=>{
  const id=await claim();await expect(decideClaim(me,{claimRequestId:id,decision:'approve'})).rejects.toThrow();
  const other=await seedBase();const facts=await withTenant(adminCtx(other),tx=>tx.execute(sql`select * from app.claim_decision_subject_facts(${id}::uuid)`));expect(facts).toHaveLength(0);
 });
});
