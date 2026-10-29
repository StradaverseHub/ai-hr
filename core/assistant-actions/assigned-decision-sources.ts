/** ADR-0151 wave 1b source adapters: an assigned approver decides one pending claim, attendance request or
 * replacement-leave (TOIL) request through the SAME native service the approvals inbox uses, under the
 * caller's own context. The native service decides authority (assertCanDecide and the frozen attendance
 * workflow), limits, levels and effects; these adapters only read the stored facts a decider recognises,
 * refuse the decider's own requests outright (even where a native role would allow it), and require the
 * reviewed facts to be unchanged before the native write. Nothing here computes or moves money. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {assertCanDecide} from '../approvals';
import {scopeOf} from '../../lib/delegation-scope';
import {decideClaimTx} from '../../packs/claims/service';
import {decideAttendanceCorrection,assertCanDecideAttendanceApplicationTx} from '../../packs/attendance/service';
import {decideReplacementLeaveRequestTx} from '../../packs/leave/service';
import {myOwnEmploymentSubjectsTx} from '../read';
import type {AssignedSubject} from './generic-assigned-review-store';
import {AssignedClaimDecision,AssignedAttendanceDecision,AssignedToilDecision,type AssignedClaimHuman,type AssignedAttendanceHuman,type AssignedToilHuman} from '../../lib/assistant-actions/assigned-decision-contract';
export class AssignedDecisionUnavailable extends Error{constructor(){super('That decision needs another look. Please reopen your approvals.');this.name='AssignedDecisionUnavailable';}}
export const assignedDecisionUnavailable=():never=>{throw new AssignedDecisionUnavailable();};
const fail=assignedDecisionUnavailable;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const digestOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowsOf=<T>(rows:unknown)=>rows as unknown as T[];
type Module='claims'|'attendance'|'toil';
async function actor(tx:Tx,supplied:SessionContext,module:Module){const ctx=capture(supplied);await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlementsError:undefined,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,module);await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}
/** Self-decision is refused here for every role, before and independently of the native ban. */
const notSelf=(fresh:SessionContext,subjectPersonId:string)=>{if(!subjectPersonId||fresh.personId===subjectPersonId)return fail();};
const currentEvent=sql`d.actor_type='user' and d.xmin=pg_current_xact_id()::xid`;

// Claims
type ClaimRow=z.infer<typeof AssignedClaimDecision.Item>&{companyId:string;subjectPersonId:string;status:string};
const claimSql=sql`select q.id as "subjectId",q.employment_id as "employmentId",e.company_id as "companyId",e.person_id as "subjectPersonId",e.employee as "employeeName",e.employee_code as "employeeCode",
 t.name as "claimTypeName",i.name as "itemName",to_char(q.incurred_on,'YYYY-MM-DD') as "incurredOn",to_char(q.amount,'FM999999999990.00') as amount,q.description,q.status::text as status
 from public.claim_request q cross join lateral app.delegated_approval_subject(q.employment_id,'claims','claims.claim') e
 join public.claim_type t on t.id=q.claim_type_id and t.tenant_id=q.tenant_id left join public.claim_item i on i.id=q.claim_item_id`;
const claimItem=(row:ClaimRow)=>AssignedClaimDecision.Item.parse({employmentId:row.employmentId,subjectId:row.subjectId,employeeName:row.employeeName,employeeCode:row.employeeCode,claimTypeName:row.claimTypeName,itemName:row.itemName,incurredOn:row.incurredOn,amount:row.amount,description:row.description});
async function claimRow(tx:Tx,fresh:SessionContext,id:string){return rowsOf<ClaimRow>(await tx.execute(sql`${claimSql} where q.id=${z.guid().parse(id)}::uuid and q.tenant_id=${fresh.tenantId}::uuid`))[0];}
const claimAuthority=(tx:Tx,fresh:SessionContext,row:{employmentId:string})=>assertCanDecide(tx,fresh,row.employmentId,'claim',scopeOf('claims.claim'));
export async function readAssignedClaimChoicesTx(tx:Tx,supplied:SessionContext){
 const fresh=await actor(tx,supplied,'claims'),rows=rowsOf<ClaimRow>(await tx.execute(sql`${claimSql} where q.tenant_id=${fresh.tenantId}::uuid and q.status='pending' and not app.is_self_person(e.person_id) order by q.created_at,q.id limit 60`));
 const items=[];for(const row of rows){if(row.subjectPersonId===fresh.personId)continue;try{await claimAuthority(tx,fresh,row);}catch{continue;}items.push(claimItem(row));if(items.length>25)break;}
 return AssignedClaimDecision.Choices.parse({kind:'choices',items:items.slice(0,25),truncated:items.length>25||rows.length>=60});
}
export async function withAssignedClaimSubjectTx<T>(tx:Tx,supplied:SessionContext,subjectId:string,mode:'pending'|'recorded',work:(fresh:SessionContext,subject:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,supplied,'claims'),row=await claimRow(tx,fresh,subjectId);if(!row)return fail();notSelf(fresh,row.subjectPersonId);
 if(mode==='pending'){if(row.status!=='pending')return fail();await claimAuthority(tx,fresh,row);}
 return work(fresh,{subjectId:row.subjectId,employmentId:row.employmentId,companyId:row.companyId,subjectPersonId:row.subjectPersonId});
}
async function claimReview(tx:Tx,fresh:SessionContext,human:AssignedClaimHuman){const row=await claimRow(tx,fresh,human.subjectId);if(!row||row.employmentId!==human.employmentId||row.status!=='pending')return fail();notSelf(fresh,row.subjectPersonId);return claimItem(row);}
export async function prepareAssignedClaimSourceTx(tx:Tx,fresh:SessionContext,human:AssignedClaimHuman){const review=await claimReview(tx,fresh,human);return{review,reviewedDigest:digestOf(review)};}
export async function confirmAssignedClaimSourceTx(tx:Tx,fresh:SessionContext,human:AssignedClaimHuman,reviewedDigest:string){
 if(digestOf(await claimReview(tx,fresh,human))!==reviewedDigest)return fail();
 const decider=(await myOwnEmploymentSubjectsTx(tx,fresh))[0]?.employmentId??null;
 // decideClaimTx takes the limit lock, then the row lock, and re-reads the claim before deciding.
 const done=await decideClaimTx(tx,fresh,{claimRequestId:human.subjectId,decision:human.decision==='approved'?'approve':'reject',deciderEmploymentId:decider,...human.decision==='rejected'&&human.note!==undefined?{rejectReason:human.note}:{}});
 if(done.employmentId!==human.employmentId||done.status!==human.decision)return fail();
 return{eventId:done.eventId,receipt:await reconcileAssignedClaimSourceTx(tx,fresh,{subjectId:human.subjectId,eventId:done.eventId,employmentId:human.employmentId})};
}
export async function reconcileAssignedClaimSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 const [row]=rowsOf<{status:string;eventType:string}>(await tx.execute(sql`select q.status::text as status,d.event_type as "eventType" from public.claim_request q join public.domain_event d on d.aggregate_id=q.id and d.tenant_id=q.tenant_id
  where q.id=${reference.subjectId}::uuid and q.tenant_id=${fresh.tenantId}::uuid and q.employment_id=${reference.employmentId}::uuid and d.id=${reference.eventId}::uuid
   and d.aggregate_type='claim-request' and d.event_type in ('claim-request.approved','claim-request.rejected') and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid`));
 if(!row)return fail();
 return AssignedClaimDecision.Receipt.parse({kind:'decided',subjectId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId,decision:row.eventType==='claim-request.approved'?'approved':'rejected',recorded:'final',currentStatus:row.status});
}

// Attendance
type AttendanceRow=z.infer<typeof AssignedAttendanceDecision.Item>&{companyId:string;subjectPersonId:string;status:string;clockChanges:boolean};
const attendanceSql=sql`select q.id as "subjectId",q.employment_id as "employmentId",s.company_id as "companyId",s.person_id as "subjectPersonId",s.employee as "employeeName",s.employee_code as "employeeCode",
 to_char(q.attendance_date,'YYYY-MM-DD') as date,q.requested_ot_minutes is not null as overtime,to_char(q.proposed_check_in,'HH24:MI') as "proposedCheckIn",to_char(q.proposed_check_out,'HH24:MI') as "proposedCheckOut",
 to_char(q.planned_start_time,'HH24:MI') as "plannedStartTime",to_char(q.planned_end_time,'HH24:MI') as "plannedEndTime",q.requested_ot_minutes as "requestedOtMinutes",q.reason,q.status::text as status,q.clock_changes is not null as "clockChanges"
 from public.attendance_correction q cross join lateral app.attendance_application_subject(q.id) s`;
const attendanceItem=(row:AttendanceRow)=>AssignedAttendanceDecision.Item.parse({employmentId:row.employmentId,subjectId:row.subjectId,employeeName:row.employeeName,employeeCode:row.employeeCode,date:row.date,overtime:row.overtime,
 proposedCheckIn:row.proposedCheckIn,proposedCheckOut:row.proposedCheckOut,plannedStartTime:row.plannedStartTime,plannedEndTime:row.plannedEndTime,requestedOtMinutes:row.requestedOtMinutes==null?null:Number(row.requestedOtMinutes),reason:row.reason});
async function attendanceRow(tx:Tx,fresh:SessionContext,id:string){return rowsOf<AttendanceRow>(await tx.execute(sql`${attendanceSql} where q.id=${z.guid().parse(id)}::uuid and q.tenant_id=${fresh.tenantId}::uuid`))[0];}
/** Clock-data changes show punches this card cannot render faithfully; they stay on the approvals inbox. */
const decidable=(row:AttendanceRow)=>row.status==='pending'&&!row.clockChanges;
/** The native frozen-workflow check runs SQL; a savepoint keeps one refusal from aborting the listing. */
const attendanceAuthority=(tx:Tx,fresh:SessionContext,row:{subjectId:string;employmentId:string})=>tx.transaction(inner=>assertCanDecideAttendanceApplicationTx(inner as unknown as Tx,fresh,row.subjectId,row.employmentId));
export async function readAssignedAttendanceChoicesTx(tx:Tx,supplied:SessionContext){
 const fresh=await actor(tx,supplied,'attendance'),rows=rowsOf<AttendanceRow>(await tx.execute(sql`${attendanceSql} where q.tenant_id=${fresh.tenantId}::uuid and q.status='pending' and q.cancelled_at is null and q.clock_changes is null and not app.is_self_person(s.person_id) order by q.created_at,q.id limit 60`));
 const items=[];for(const row of rows){if(row.subjectPersonId===fresh.personId||!decidable(row))continue;try{await attendanceAuthority(tx,fresh,row);}catch{continue;}items.push(attendanceItem(row));if(items.length>25)break;}
 return AssignedAttendanceDecision.Choices.parse({kind:'choices',items:items.slice(0,25),truncated:items.length>25||rows.length>=60});
}
export async function withAssignedAttendanceSubjectTx<T>(tx:Tx,supplied:SessionContext,subjectId:string,mode:'pending'|'recorded',work:(fresh:SessionContext,subject:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,supplied,'attendance'),row=await attendanceRow(tx,fresh,subjectId);if(!row)return fail();notSelf(fresh,row.subjectPersonId);
 if(mode==='pending'){if(!decidable(row))return fail();await assertCanDecideAttendanceApplicationTx(tx,fresh,row.subjectId,row.employmentId);}
 return work(fresh,{subjectId:row.subjectId,employmentId:row.employmentId,companyId:row.companyId,subjectPersonId:row.subjectPersonId});
}
async function attendanceReview(tx:Tx,fresh:SessionContext,human:AssignedAttendanceHuman){
 const row=await attendanceRow(tx,fresh,human.subjectId);if(!row||row.employmentId!==human.employmentId||!decidable(row))return fail();notSelf(fresh,row.subjectPersonId);
 const note=human.note?.trim()??'';if(human.decision==='rejected'&&(note.length<1||note.length>1000))return fail();
 return attendanceItem(row);
}
/** The pending level (and, for participant workflows, this decider's slot) the native service must still be at.
 * It is bound into the reviewed digest, so a level that advanced elsewhere is refused as stale. */
async function attendanceLevel(tx:Tx,fresh:SessionContext,correctionId:string){
 const [flow]=rowsOf<{stage:number;routing:number}>(await tx.execute(sql`select w.current_stage as stage,w.routing_version as routing from public.attendance_workflow_request w where w.correction_id=${correctionId}::uuid and w.tenant_id=${fresh.tenantId}::uuid`));
 if(!flow)return{expectedStageIndex:undefined,expectedParticipantSlot:undefined};
 const [slot]=flow.routing===3||flow.routing===4?rowsOf<{slot:string|null}>(await tx.execute(sql`select app.attendance_workflow_v3_decision_slot(${correctionId}::uuid)->>'slot' as slot`)):[{slot:null}];
 if((flow.routing===3||flow.routing===4)&&!slot?.slot)return fail();
 return{expectedStageIndex:Number(flow.stage),expectedParticipantSlot:slot?.slot??undefined};
}
export async function prepareAssignedAttendanceSourceTx(tx:Tx,fresh:SessionContext,human:AssignedAttendanceHuman){const review=await attendanceReview(tx,fresh,human),level=await attendanceLevel(tx,fresh,human.subjectId);return{review,reviewedDigest:digestOf({review,level})};}
export async function confirmAssignedAttendanceSourceTx(tx:Tx,fresh:SessionContext,human:AssignedAttendanceHuman,reviewedDigest:string){
 const review=await attendanceReview(tx,fresh,human),level=await attendanceLevel(tx,fresh,human.subjectId);if(digestOf({review,level})!==reviewedDigest)return fail();
 const note=human.note?.trim()||undefined;
 // The native decision locks the request, checks the frozen workflow and records a level or the final outcome.
 const outcome=await decideAttendanceCorrection(fresh,{correctionId:human.subjectId,decision:human.decision,...(level.expectedStageIndex!==undefined?{expectedStageIndex:level.expectedStageIndex}:{}),...(level.expectedParticipantSlot?{expectedParticipantSlot:level.expectedParticipantSlot}:{}),...(human.decision==='rejected'?{rejectReason:note}:{remarks:note})},tx);
 const final=outcome.status!=='pending';if(final&&outcome.status!==human.decision)return fail();
 const [event]=rowsOf<{id:string}>(await tx.execute(sql`select d.id from public.domain_event d where d.tenant_id=${fresh.tenantId}::uuid and d.aggregate_id=${human.subjectId}::uuid and d.aggregate_type='attendance-correction'
  and d.actor_id=${fresh.userId}::uuid and ${currentEvent} and d.subject_employment_id=${human.employmentId}::uuid
  and d.event_type in (${final?sql`${'attendance-correction.'+human.decision}`:sql`'attendance-workflow.stage.decided','attendance-workflow.participant.decided'`})
  order by d.event_type='attendance-workflow.stage.decided' desc,d.occurred_at desc,d.id desc limit 1`));
 if(!event)return fail();
 return{eventId:event.id,receipt:await reconcileAssignedAttendanceSourceTx(tx,fresh,{subjectId:human.subjectId,eventId:event.id,employmentId:human.employmentId})};
}
export async function reconcileAssignedAttendanceSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 const [row]=rowsOf<{status:string;eventType:string;levelDecision:string|null}>(await tx.execute(sql`select q.status::text as status,d.event_type as "eventType",d.payload->>'decision' as "levelDecision"
  from public.attendance_correction q join public.domain_event d on d.aggregate_id=q.id and d.tenant_id=q.tenant_id
  where q.id=${reference.subjectId}::uuid and q.tenant_id=${fresh.tenantId}::uuid and q.employment_id=${reference.employmentId}::uuid and d.id=${reference.eventId}::uuid and d.aggregate_type='attendance-correction'
   and d.event_type in ('attendance-correction.approved','attendance-correction.rejected','attendance-workflow.stage.decided','attendance-workflow.participant.decided') and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid`));
 if(!row)return fail();
 const final=row.eventType.startsWith('attendance-correction.'),decision=final?row.eventType.slice('attendance-correction.'.length):row.levelDecision;
 return AssignedAttendanceDecision.Receipt.parse({kind:'decided',subjectId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId,decision,recorded:final?'final':'level',currentStatus:row.status});
}

// Replacement leave (TOIL)
type ToilRow=z.infer<typeof AssignedToilDecision.Item>&{companyId:string;subjectPersonId:string;status:string};
const toilSql=sql`select q.id as "subjectId",q.employment_id as "employmentId",e.company_id as "companyId",e.person_id as "subjectPersonId",e.employee as "employeeName",e.employee_code as "employeeCode",
 to_char(q.submitted_on,'YYYY-MM-DD') as "submittedOn",q.total_days::float8 as "totalDays",q.total_hours::float8 as "totalHours",
 (select count(*)::int from public.replacement_leave_request_date l where l.request_id=q.id) as lines,q.reason,q.status::text as status
 from public.replacement_leave_request q cross join lateral app.delegated_approval_subject(q.employment_id,'leave','leave.replacement') e`;
const toilItem=(row:ToilRow)=>AssignedToilDecision.Item.parse({employmentId:row.employmentId,subjectId:row.subjectId,employeeName:row.employeeName,employeeCode:row.employeeCode,submittedOn:row.submittedOn,totalDays:Number(row.totalDays),totalHours:Number(row.totalHours),lines:row.lines,reason:row.reason});
async function toilRow(tx:Tx,fresh:SessionContext,id:string){return rowsOf<ToilRow>(await tx.execute(sql`${toilSql} where q.id=${z.guid().parse(id)}::uuid and q.tenant_id=${fresh.tenantId}::uuid`))[0];}
const toilAuthority=(tx:Tx,fresh:SessionContext,row:{employmentId:string})=>assertCanDecide(tx,fresh,row.employmentId,'replacement leave request',scopeOf('leave.replacement'));
export async function readAssignedToilChoicesTx(tx:Tx,supplied:SessionContext){
 const fresh=await actor(tx,supplied,'toil'),rows=rowsOf<ToilRow>(await tx.execute(sql`${toilSql} where q.tenant_id=${fresh.tenantId}::uuid and q.status='pending' and not app.is_self_person(e.person_id) order by q.created_at,q.id limit 60`));
 const items=[];for(const row of rows){if(row.subjectPersonId===fresh.personId||row.lines<1)continue;try{await toilAuthority(tx,fresh,row);}catch{continue;}items.push(toilItem(row));if(items.length>25)break;}
 return AssignedToilDecision.Choices.parse({kind:'choices',items:items.slice(0,25),truncated:items.length>25||rows.length>=60});
}
export async function withAssignedToilSubjectTx<T>(tx:Tx,supplied:SessionContext,subjectId:string,mode:'pending'|'recorded',work:(fresh:SessionContext,subject:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,supplied,'toil'),row=await toilRow(tx,fresh,subjectId);if(!row)return fail();notSelf(fresh,row.subjectPersonId);
 if(mode==='pending'){if(row.status!=='pending')return fail();await toilAuthority(tx,fresh,row);}
 return work(fresh,{subjectId:row.subjectId,employmentId:row.employmentId,companyId:row.companyId,subjectPersonId:row.subjectPersonId});
}
async function toilReview(tx:Tx,fresh:SessionContext,human:AssignedToilHuman){const row=await toilRow(tx,fresh,human.subjectId);if(!row||row.employmentId!==human.employmentId||row.status!=='pending'||row.lines<1)return fail();notSelf(fresh,row.subjectPersonId);return toilItem(row);}
export async function prepareAssignedToilSourceTx(tx:Tx,fresh:SessionContext,human:AssignedToilHuman){const review=await toilReview(tx,fresh,human);return{review,reviewedDigest:digestOf(review)};}
export async function confirmAssignedToilSourceTx(tx:Tx,fresh:SessionContext,human:AssignedToilHuman,reviewedDigest:string){
 if(digestOf(await toilReview(tx,fresh,human))!==reviewedDigest)return fail();
 // The native decision takes its own configuration, dependency and row locks and mints credits on approval.
 const done=await decideReplacementLeaveRequestTx(tx,fresh,{requestId:human.subjectId,decision:human.decision,note:human.note?.trim()||undefined});
 if(done.employmentId!==human.employmentId||done.status!==human.decision)return fail();
 return{eventId:done.eventId,receipt:await reconcileAssignedToilSourceTx(tx,fresh,{subjectId:human.subjectId,eventId:done.eventId,employmentId:human.employmentId})};
}
export async function reconcileAssignedToilSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 const [row]=rowsOf<{status:string;eventType:string}>(await tx.execute(sql`select q.status::text as status,d.event_type as "eventType" from public.replacement_leave_request q join public.domain_event d on d.aggregate_id=q.id and d.tenant_id=q.tenant_id
  where q.id=${reference.subjectId}::uuid and q.tenant_id=${fresh.tenantId}::uuid and q.employment_id=${reference.employmentId}::uuid and d.id=${reference.eventId}::uuid
   and d.aggregate_type='replacement-leave-request' and d.event_type in ('replacement-leave-request.approved','replacement-leave-request.rejected') and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid`));
 if(!row)return fail();
 return AssignedToilDecision.Receipt.parse({kind:'decided',subjectId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId,decision:row.eventType==='replacement-leave-request.approved'?'approved':'rejected',recorded:'final',currentStatus:row.status});
}
