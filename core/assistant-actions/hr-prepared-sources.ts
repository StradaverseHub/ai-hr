/** ADR-0151 (amendment 2026-10-29) source adapters: an HR administrator applies one employee's leave
 * adjustment or assignment-only movement through the SAME native service the HR screen uses, under the
 * administrator's own context. The adapters refuse the administrator's own employment outright (for every
 * role), run the native owner's own authority check before preparing, read only the stored labels HR
 * recognises, and require the reviewed facts to be unchanged before the native write. Nothing here
 * computes a balance or money; the native service decides every effect and checks authority again. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {applyLeaveAdjustmentBatchTx,grantLeaveCreditRowsTx,leaveCreditGrantDayFactsTx,leaveCreditGrantContextTx,leaveCreditClaimReviewTx} from '../../packs/leave/service';
import {createMovementEventTx} from '../movement';
import {assertWorkforceEmploymentTx} from '../workforce-access';
import type {AssignedSubject} from './generic-assigned-review-store';
import {HrChoicesSelection,HrLeaveAdjustment,HrMovementTransfer,HrLeaveCredit,type HrLeaveAdjustmentHuman,type HrMovementTransferHuman,type HrLeaveCreditHuman} from '../../lib/assistant-actions/hr-prepared-contract';
export class HrPreparedUnavailable extends Error{constructor(){super('That change needs another look. Please reopen it from the employee.');this.name='HrPreparedUnavailable';}}
export const hrPreparedUnavailable=():never=>{throw new HrPreparedUnavailable();};
const fail=hrPreparedUnavailable;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const digestOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowsOf=<T>(rows:unknown)=>rows as unknown as T[];
type Module='leave'|'employees'|'toil';
async function actor(tx:Tx,supplied:SessionContext,module:Module){
 const ctx=capture(supplied);await assertAiPrincipalTx(tx,ctx);
 const fresh={...ctx,entitlementsError:undefined,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
 await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,module);await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');
 // Mirror of the screens' own admission (requireAdmin); the native service is the authority.
 if(!isAdmin(fresh))return fail();
 return fresh;
}
/** Acting on one's own employment is refused here for every role, before and independently of the native rules. */
const notSelf=(fresh:SessionContext,subjectPersonId:string)=>{if(!subjectPersonId||fresh.personId===subjectPersonId)return fail();};
const currentEvent=sql`d.actor_type='user' and d.xmin=pg_current_xact_id()::xid`;

type SubjectRow={employmentId:string;companyId:string;subjectPersonId:string;employeeName:string;employeeCode:string|null;companyName:string};
const subjectSql=sql`select e.id as "employmentId",e.company_id as "companyId",e.person_id as "subjectPersonId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName"
 from public.employment e join public.person p on p.id=e.person_id and p.tenant_id=e.tenant_id join public.company c on c.id=e.company_id and c.tenant_id=e.tenant_id`;
async function subjectRow(tx:Tx,fresh:SessionContext,employmentId:string){
 return rowsOf<SubjectRow>(await tx.execute(sql`${subjectSql} where e.id=${z.guid().parse(employmentId)}::uuid and e.tenant_id=${fresh.tenantId}::uuid and e.terminated_on is null`))[0];
}
/** The administrator's bounded employee search: active employments they administer, never their own. */
async function searchSubjects(tx:Tx,fresh:SessionContext,query:string){
 const pattern=`%${query.replace(/[\\%_]/g,'\\$&')}%`;
 const rows=rowsOf<SubjectRow>(await tx.execute(sql`${subjectSql} where e.tenant_id=${fresh.tenantId}::uuid and e.terminated_on is null
  and app.can_admin_employment(e.id) and not app.is_self_person(e.person_id) and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern})
  order by p.full_name,e.id limit 26`)).filter(row=>row.subjectPersonId!==fresh.personId);
 return{employees:rows.slice(0,25).map(row=>({employmentId:row.employmentId,employeeName:row.employeeName,employeeCode:row.employeeCode,companyName:row.companyName})),truncated:rows.length>25};
}
const subjectOf=(row:SubjectRow):AssignedSubject=>({subjectId:row.employmentId,employmentId:row.employmentId,companyId:row.companyId,subjectPersonId:row.subjectPersonId});

// Leave adjustment
/** The adjustment screen's own boundary: an administered employment (the ledger and batch writes are RLS-bound to it). */
async function leaveAuthority(tx:Tx,employmentId:string){const [row]=rowsOf<{allowed:boolean}>(await tx.execute(sql`select app.can_admin_employment(${employmentId}::uuid) as allowed`));if(row?.allowed!==true)return fail();}
export async function readHrLeaveAdjustmentChoicesTx(tx:Tx,supplied:SessionContext,selection?:unknown){
 const fresh=await actor(tx,supplied,'leave'),{query}=HrChoicesSelection.parse(selection??{query:''});
 const found=await searchSubjects(tx,fresh,query);
 const leaveTypes=rowsOf<{id:string;name:string}>(await tx.execute(sql`select t.id,t.name from public.leave_type t where t.tenant_id=${fresh.tenantId}::uuid and t.archived_at is null order by t.name,t.id limit 60`));
 return HrLeaveAdjustment.Choices.parse({kind:'choices',...found,leaveTypes});
}
export async function withHrLeaveAdjustmentSubjectTx<T>(tx:Tx,supplied:SessionContext,subjectId:string,mode:'pending'|'recorded',work:(fresh:SessionContext,subject:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,supplied,'leave'),row=await subjectRow(tx,fresh,subjectId);if(!row)return fail();notSelf(fresh,row.subjectPersonId);
 if(mode==='pending')await leaveAuthority(tx,row.employmentId);
 return work(fresh,subjectOf(row));
}
const signed=(human:HrLeaveAdjustmentHuman)=>(human.direction==='deduct'?-1:1)*Number(human.days);
async function leaveAdjustmentReview(tx:Tx,fresh:SessionContext,human:HrLeaveAdjustmentHuman){
 const row=await subjectRow(tx,fresh,human.subjectId);if(!row||row.employmentId!==human.employmentId)return fail();notSelf(fresh,row.subjectPersonId);
 const [type]=rowsOf<{name:string}>(await tx.execute(sql`select t.name from public.leave_type t where t.id=${human.leaveTypeId}::uuid and t.tenant_id=${fresh.tenantId}::uuid and t.archived_at is null`));
 if(!type)return fail();
 return HrLeaveAdjustment.Item.parse({employmentId:row.employmentId,subjectId:row.employmentId,employeeName:row.employeeName,employeeCode:row.employeeCode,companyName:row.companyName,
  leaveTypeName:type.name,signedDays:signed(human).toFixed(2),effectiveOn:human.effectiveOn,reason:human.reason.trim()});
}
export async function prepareHrLeaveAdjustmentSourceTx(tx:Tx,fresh:SessionContext,human:HrLeaveAdjustmentHuman){const review=await leaveAdjustmentReview(tx,fresh,human);return{review,reviewedDigest:digestOf(review)};}
export async function confirmHrLeaveAdjustmentSourceTx(tx:Tx,fresh:SessionContext,human:HrLeaveAdjustmentHuman,reviewedDigest:string){
 if(digestOf(await leaveAdjustmentReview(tx,fresh,human))!==reviewedDigest)return fail();
 // The native write locks the leave dependencies, re-reads the nominated employment under RLS and skips a frozen balance.
 const done=await applyLeaveAdjustmentBatchTx(tx,fresh,{targetMode:'individual',employmentIds:[human.employmentId],leaveTypeIds:[human.leaveTypeId],days:signed(human),effectiveOn:human.effectiveOn,reason:human.reason.trim()});
 // A frozen (encashed) balance writes nothing: that is not a completed adjustment.
 if(done.written!==1)return fail();
 return{eventId:done.eventId,receipt:await reconcileHrLeaveAdjustmentSourceTx(tx,fresh,{subjectId:human.subjectId,eventId:done.eventId,employmentId:human.employmentId})};
}
export async function reconcileHrLeaveAdjustmentSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 const [row]=rowsOf<{batchId:string;written:number}>(await tx.execute(sql`select b.id as "batchId",b.written_count as written from public.leave_adjustment_batch b join public.domain_event d on d.aggregate_id=b.id and d.tenant_id=b.tenant_id
  where d.id=${reference.eventId}::uuid and b.tenant_id=${fresh.tenantId}::uuid and d.aggregate_type='leave-adjustment-batch' and d.event_type='leave.adjustment.applied'
   and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid and b.actor_user_id=${fresh.userId}::uuid and b.target_mode='individual'
   and exists(select 1 from public.leave_ledger l where l.adjustment_batch_id=b.id and l.employment_id=${reference.employmentId}::uuid)`));
 if(!row||reference.subjectId!==reference.employmentId)return fail();
 return HrLeaveAdjustment.Receipt.parse({kind:'adjusted',subjectId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId,batchId:row.batchId,written:Number(row.written)});
}

// Assignment-only movement
const movementAuthority=(tx:Tx,fresh:SessionContext,employmentId:string)=>assertWorkforceEmploymentTx(tx,fresh,employmentId,'maintain');
type OrgOption={id:string;name:string};
/** Options of the employee's own company (or global), as the New Event form offers them. */
async function orgOptions(tx:Tx,fresh:SessionContext,companyId:string){
 const of=(table:string,label:string)=>tx.execute(sql`select o.id,${sql.raw(label)} as name from public.${sql.raw(table)} o where o.tenant_id=${fresh.tenantId}::uuid and o.archived_at is null and (o.company_id=${companyId}::uuid or o.is_global is true) order by 2,1 limit 200`);
 const loc=()=>tx.execute(sql`select o.id,o.name from public.location o where o.tenant_id=${fresh.tenantId}::uuid and o.archived_at is null and o.company_id=${companyId}::uuid order by 2,1 limit 200`);
 // One transaction connection: read in sequence.
 const departments=await of('department','o.name'),positions=await of('position','o.title'),businessUnits=await of('business_unit','o.name'),locations=await loc();
 return{departments:rowsOf<OrgOption>(departments),positions:rowsOf<OrgOption>(positions),businessUnits:rowsOf<OrgOption>(businessUnits),locations:rowsOf<OrgOption>(locations)};
}
export async function readHrMovementChoicesTx(tx:Tx,supplied:SessionContext,selection?:unknown){
 const fresh=await actor(tx,supplied,'employees'),{query,employmentId}=HrChoicesSelection.parse(selection??{query:''});
 const found=await searchSubjects(tx,fresh,query);
 let options={departments:[] as OrgOption[],positions:[] as OrgOption[],businessUnits:[] as OrgOption[],locations:[] as OrgOption[]};
 if(employmentId){const row=await subjectRow(tx,fresh,employmentId);if(!row)return fail();notSelf(fresh,row.subjectPersonId);await movementAuthority(tx,fresh,row.employmentId);options=await orgOptions(tx,fresh,row.companyId);}
 return HrMovementTransfer.Choices.parse({kind:'choices',...found,...options});
}
export async function withHrMovementSubjectTx<T>(tx:Tx,supplied:SessionContext,subjectId:string,mode:'pending'|'recorded',work:(fresh:SessionContext,subject:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,supplied,'employees'),row=await subjectRow(tx,fresh,subjectId);if(!row)return fail();notSelf(fresh,row.subjectPersonId);
 if(mode==='pending')await movementAuthority(tx,fresh,row.employmentId);
 return work(fresh,subjectOf(row));
}
async function movementReview(tx:Tx,fresh:SessionContext,human:HrMovementTransferHuman){
 const row=await subjectRow(tx,fresh,human.subjectId);if(!row||row.employmentId!==human.employmentId)return fail();notSelf(fresh,row.subjectPersonId);
 const options=await orgOptions(tx,fresh,row.companyId);
 const label=(list:OrgOption[],id:string|null)=>{if(id==null)return null;const hit=list.find(option=>option.id===id);return hit?hit.name:fail();};
 return HrMovementTransfer.Item.parse({employmentId:row.employmentId,subjectId:row.employmentId,employeeName:row.employeeName,employeeCode:row.employeeCode,companyName:row.companyName,
  kind:human.kind,effectiveDate:human.effectiveDate,department:label(options.departments,human.departmentId),position:label(options.positions,human.positionId),
  businessUnit:label(options.businessUnits,human.businessUnitId),location:label(options.locations,human.locationId),remarks:human.remarks?.trim()||null,
  scheduled:human.effectiveDate>todayInKualaLumpur()});
}
export async function prepareHrMovementSourceTx(tx:Tx,fresh:SessionContext,human:HrMovementTransferHuman){const review=await movementReview(tx,fresh,human);return{review,reviewedDigest:digestOf(review)};}
export async function confirmHrMovementSourceTx(tx:Tx,fresh:SessionContext,human:HrMovementTransferHuman,reviewedDigest:string){
 if(digestOf(await movementReview(tx,fresh,human))!==reviewedDigest)return fail();
 // The native dispatcher checks workforce maintenance again, resolves the tenant's event type, refuses a
 // no-change movement and either applies it now or records it as pending for its effective date.
 await createMovementEventTx(tx,fresh,{employmentId:human.employmentId,kind:human.kind,effectiveDate:human.effectiveDate,remarks:human.remarks?.trim()||null,
  departmentId:human.departmentId,positionId:human.positionId,businessUnitId:human.businessUnitId,locationId:human.locationId});
 // The movement's owning event: its history tag is the one leg that is not secondary.
 const [event]=rowsOf<{id:string}>(await tx.execute(sql`select d.id from public.domain_event d where d.tenant_id=${fresh.tenantId}::uuid and d.subject_employment_id=${human.employmentId}::uuid
  and d.actor_id=${fresh.userId}::uuid and ${currentEvent} and jsonb_typeof(d.payload->'movement')='object' and coalesce(d.payload->'movement'->>'secondary','false')<>'true'
  order by d.occurred_at desc,d.sequence desc limit 1`));
 if(!event)return fail();
 return{eventId:event.id,receipt:await reconcileHrMovementSourceTx(tx,fresh,{subjectId:human.subjectId,eventId:event.id,employmentId:human.employmentId})};
}
export async function reconcileHrMovementSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 const [row]=rowsOf<{eventType:string}>(await tx.execute(sql`select d.event_type as "eventType" from public.domain_event d where d.id=${reference.eventId}::uuid and d.tenant_id=${fresh.tenantId}::uuid
  and d.subject_employment_id=${reference.employmentId}::uuid and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid and jsonb_typeof(d.payload->'movement')='object'`));
 if(!row||reference.subjectId!==reference.employmentId)return fail();
 return HrMovementTransfer.Receipt.parse({kind:'moved',subjectId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId,recorded:row.eventType==='employment.movement.scheduled'?'scheduled':'applied'});
}

// Leave Credit (hr_manual_grant): one worked date per review.
/** The Leave Credit screen's own boundary: administrator of the employee's company (assertAdminForEmploymentTx). */
const creditAuthority=(tx:Tx,fresh:SessionContext,employmentId:string)=>leaveCreditGrantContextTx(tx,fresh,{employmentId,today:todayInKualaLumpur()});
export async function readHrLeaveCreditChoicesTx(tx:Tx,supplied:SessionContext,selection?:unknown){
 const fresh=await actor(tx,supplied,'toil'),{query}=HrChoicesSelection.parse(selection??{query:''});
 return HrLeaveCredit.Choices.parse({kind:'choices',...await searchSubjects(tx,fresh,query)});
}
export async function withHrLeaveCreditSubjectTx<T>(tx:Tx,supplied:SessionContext,subjectId:string,mode:'pending'|'recorded',work:(fresh:SessionContext,subject:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,supplied,'toil'),row=await subjectRow(tx,fresh,subjectId);if(!row)return fail();notSelf(fresh,row.subjectPersonId);
 if(mode==='pending'){const context=await creditAuthority(tx,fresh,row.employmentId);if(context.ownRecord||!context.policyEnabled)return fail();}
 return work(fresh,subjectOf(row));
}
/** Every figure is the engine's: the roster's day type, the credit preview and the overtime already recorded. */
async function leaveCreditReview(tx:Tx,fresh:SessionContext,human:HrLeaveCreditHuman){
 const row=await subjectRow(tx,fresh,human.subjectId);if(!row||row.employmentId!==human.employmentId)return fail();notSelf(fresh,row.subjectPersonId);
 if(human.workedDate>todayInKualaLumpur())return fail();
 const context=await creditAuthority(tx,fresh,row.employmentId),facts=await leaveCreditGrantDayFactsTx(tx,fresh,{employmentId:row.employmentId,workedDate:human.workedDate});
 if(context.ownRecord||!context.policyEnabled||facts.alreadyCredited)return fail();
 if(context.firstSchedule&&human.firstScheduleConsent&&!context.allowFirstSchedule)return fail();
 const preview=await leaveCreditClaimReviewTx(tx,fresh,{employmentId:row.employmentId,workedDate:human.workedDate,claimStart:human.claimStart,claimEnd:human.claimEnd});
 if(preview.basis==='unavailable'||preview.basis==='formula'&&preview.status!=='ready')return fail();
 return HrLeaveCredit.Item.parse({employmentId:row.employmentId,subjectId:row.employmentId,employeeName:row.employeeName,employeeCode:row.employeeCode,companyName:row.companyName,
  workedDate:human.workedDate,dayType:facts.kind,claimStart:human.claimStart,claimEnd:human.claimEnd,creditDays:preview.basis==='formula'?preview.creditDays:null,
  overtimeMinutes:Math.max(0,Math.round(Number(facts.overtimeMinutes)||0)),firstScheduleEligible:context.firstSchedule,firstScheduleConsent:human.firstScheduleConsent,reason:human.reason.trim()});
}
export async function prepareHrLeaveCreditSourceTx(tx:Tx,fresh:SessionContext,human:HrLeaveCreditHuman){const review=await leaveCreditReview(tx,fresh,human);return{review,reviewedDigest:digestOf(review)};}
export async function confirmHrLeaveCreditSourceTx(tx:Tx,fresh:SessionContext,human:HrLeaveCreditHuman,reviewedDigest:string){
 const review=await leaveCreditReview(tx,fresh,human);if(digestOf(review)!==reviewedDigest)return fail();
 // The native grant re-checks admin authority and own record, locks the dependencies, adjudicates the posted
 // day type against the roster, derives the credit, refuses a credited date and records one accrual and event.
 const done=await grantLeaveCreditRowsTx(tx,fresh,{employmentId:human.employmentId,rows:[{workedDate:human.workedDate,dayType:review.dayType,claimStart:human.claimStart,claimEnd:human.claimEnd}],
  reason:human.reason.trim(),firstScheduleConsent:human.firstScheduleConsent,today:todayInKualaLumpur()});
 if(done.rows.length!==1||done.rows[0].workedDate!==human.workedDate)return fail();
 const [event]=rowsOf<{id:string}>(await tx.execute(sql`select d.id from public.domain_event d where d.tenant_id=${fresh.tenantId}::uuid and d.aggregate_type='toil-accrual'
  and d.aggregate_id=${done.rows[0].accrualId}::uuid and d.event_type='toil.accrued' and d.actor_id=${fresh.userId}::uuid and d.subject_employment_id=${human.employmentId}::uuid and ${currentEvent} limit 1`));
 if(!event)return fail();
 return{eventId:event.id,receipt:await reconcileHrLeaveCreditSourceTx(tx,fresh,{subjectId:human.subjectId,eventId:event.id,employmentId:human.employmentId})};
}
export async function reconcileHrLeaveCreditSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 const [row]=rowsOf<{accrualId:string;workedDate:string;days:string;expiresOn:string|null}>(await tx.execute(sql`select a.id as "accrualId",to_char(a.worked_date,'YYYY-MM-DD') as "workedDate",a.days_credited::text as days,to_char(a.expires_on,'YYYY-MM-DD') as "expiresOn"
  from public.toil_accrual a join public.domain_event d on d.aggregate_id=a.id and d.tenant_id=a.tenant_id
  where d.id=${reference.eventId}::uuid and a.tenant_id=${fresh.tenantId}::uuid and a.employment_id=${reference.employmentId}::uuid and a.source='hr_manual_grant'
   and d.aggregate_type='toil-accrual' and d.event_type='toil.accrued' and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid`));
 if(!row||reference.subjectId!==reference.employmentId)return fail();
 return HrLeaveCredit.Receipt.parse({kind:'credited',subjectId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId,accrualId:row.accrualId,workedDate:row.workedDate,daysCredited:Number(row.days),expiresOn:row.expiresOn});
}
