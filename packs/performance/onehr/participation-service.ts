import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { assessmentParticipationSnapshot, employment, onehrCycle, onehrResult, onehrReview, performanceReview, person, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { ensureAssessmentCycleReviewTx, initializeOnehrCycleTx } from '../service';
import { assessmentParticipation, serviceBeyondYear, type ParticipationOverride, type ParticipationReason } from './participation-model';
import { onehrLabel } from './person-labels';

function defaultParticipation(e:{hiredOn:string;confirmationDate:string|null;terminatedOn:string|null},openedOn:string){
 return assessmentParticipation({left:!!e.terminatedOn&&e.terminatedOn<=todayInKualaLumpur(),yearsOfService:serviceBeyondYear(e.hiredOn,openedOn)?2:0,confirmationDate:e.confirmationDate},openedOn);
}
async function participantCandidates(tx:Tx,ids:string[]){
 if(!ids.length)return [];
 return tx.select({id:employment.id,hiredOn:employment.hiredOn,confirmationDate:employment.confirmationDate,terminatedOn:employment.terminatedOn}).from(employment).where(inArray(employment.id,ids));
}
/** Preview and opening share the source confirmation predicate; standard cycles keep native eligibility. */
export async function previewAssessmentParticipantsTx(tx:Tx,ids:string[],openedOn:string){
 const rows=await participantCandidates(tx,ids);
 return rows.filter(e=>defaultParticipation(e,openedOn).takingPart).map(e=>e.id);
}
/** Snapshot the opening decision, including excluded staff, without manufacturing assessment inputs. */
export async function snapshotAssessmentParticipantsTx(tx:Tx,ctx:SessionContext,cycleId:string,candidateIds:string[],nativeEligibleIds:string[],openedOn:string){
 const [config]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId)).for('update');
 if(!config)return nativeEligibleIds;
 const nativeEligible=new Set(nativeEligibleIds),takingPart:string[]=[];
 const rows=await participantCandidates(tx,candidateIds);
 await tx.update(onehrCycle).set({participationOpenedOn:openedOn}).where(eq(onehrCycle.cycleId,cycleId));
 for(const e of rows){
  const source=defaultParticipation(e,openedOn),eligibleAtOpen=nativeEligible.has(e.id)&&source.takingPart;
  if(eligibleAtOpen)takingPart.push(e.id);
  await tx.insert(assessmentParticipationSnapshot).values({tenantId:ctx.tenantId,cycleId,employmentId:e.id,eligibleAtOpen,reason:nativeEligible.has(e.id)?source.reason:'native_rule'});
 }
 return takingPart;
}
/** HR's list includes non-participants. It never grants access to their private draft inputs. */
export async function assessmentParticipantsTx(tx:Tx,cycleId:string){
 const [cycle]=await tx.select({companyId:reviewCycle.companyId,status:reviewCycle.status,openedOn:onehrCycle.participationOpenedOn}).from(reviewCycle).innerJoin(onehrCycle,eq(onehrCycle.cycleId,reviewCycle.id)).where(eq(reviewCycle.id,cycleId));
 if(!cycle)return [];
 // ADR-0141: the person row when the caller can read it (HR: unchanged rows, names and cost), else the label
 // projection (performance partner, who cannot read person). Same companies as the onehr_admin filter.
 const name=onehrLabel.labelOrPerson(person.fullName,employment.id);
 const rows=await tx.select({employmentId:employment.id,name,companyId:employment.companyId,hiredOn:employment.hiredOn,confirmationDate:employment.confirmationDate,terminatedOn:employment.terminatedOn,snapshot:assessmentParticipationSnapshot})
  .from(employment).leftJoin(person,eq(person.id,employment.personId)).leftJoin(assessmentParticipationSnapshot,and(eq(assessmentParticipationSnapshot.employmentId,employment.id),eq(assessmentParticipationSnapshot.cycleId,cycleId)))
  .where(and(cycle.companyId?eq(employment.companyId,cycle.companyId):undefined,isNull(employment.terminatedOn),sql`app.onehr_admin(${employment.companyId})`,sql`(${person.id} is not null or ${onehrLabel.visible(employment.id)})`)).orderBy(asc(name),asc(employment.id));
 return rows.map(({snapshot,...e})=>{
  const original=snapshot?{takingPart:snapshot.eligibleAtOpen,reason:snapshot.reason as ParticipationReason}:defaultParticipation(e,cycle.openedOn??todayInKualaLumpur());
  const override=snapshot?.override as ParticipationOverride;
  return {employmentId:e.employmentId,name:e.name,companyId:e.companyId,takingPart:override?override==='add':original.takingPart,reason:override?override==='add'?'added' as const:'removed' as const:original.reason,override,revision:snapshot?.revision??null,hasSnapshot:!!snapshot};
 });
}
/** A roster override retains reviews, panels, drafts, evidence and locked history. */
export async function setAssessmentParticipation(ctx:SessionContext,cycleId:string,expectedCycle:number,employmentId:string,expectedParticipant:number|null,mode:'add'|'remove'|'clear'){
 z.uuid().parse(cycleId);z.uuid().parse(employmentId);z.enum(['add','remove','clear']).parse(mode);
 return withPerformanceTenant(ctx,async tx=>{
  const [cycle]=await tx.select().from(reviewCycle).where(eq(reviewCycle.id,cycleId)).for('no key update');
  const [scope]=await tx.execute<{ok:boolean}>(sql`select app.onehr_cycle_admin(${cycleId}::uuid) as ok`);
  if(!cycle||!scope?.ok)throw Error('Performance administrator access is required.');
  const [config]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId)).for('update');
  if(!config||!['open','calibration'].includes(cycle.status))throw Error('Change participants only in an open assessment cycle.');
  if(config.revision!==expectedCycle)throw Error('The cycle changed. Reload before changing participants.');
  const [e]=await participantCandidates(tx,[employmentId]);
  const [allowed]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from employment e where e.id=${employmentId}::uuid and e.tenant_id=app.current_tenant_id() and app.onehr_admin(e.company_id) and (${cycle.companyId}::uuid is null or e.company_id=${cycle.companyId}::uuid)) as ok`);
  if(!e||!allowed?.ok||e.terminatedOn&&e.terminatedOn<=todayInKualaLumpur())throw Error('Choose an active employee in this cycle and your authorized company scope.');
  const [existingReview]=await tx.select({id:performanceReview.id}).from(performanceReview).where(and(eq(performanceReview.cycleId,cycleId),eq(performanceReview.employmentId,employmentId)));
  if(existingReview){await tx.select({id:onehrReview.reviewId}).from(onehrReview).where(eq(onehrReview.reviewId,existingReview.id)).for('update');const [frozen]=await tx.select({id:onehrResult.id}).from(onehrResult).where(eq(onehrResult.reviewId,existingReview.id));if(frozen)throw Error('A finalized assessment retains its participation and history.');}
  const [old]=await tx.select().from(assessmentParticipationSnapshot).where(and(eq(assessmentParticipationSnapshot.cycleId,cycleId),eq(assessmentParticipationSnapshot.employmentId,employmentId))).for('update');
  if((old?.revision??null)!==expectedParticipant)throw Error('This participation record changed. Reload before saving.');
  const initial=defaultParticipation(e,config.participationOpenedOn??cycle.createdAt.toISOString().slice(0,10));
  const override=mode==='clear'?null:mode;
  if(old)await tx.update(assessmentParticipationSnapshot).set({override,revision:old.revision+1,updatedBy:ctx.userId,updatedAt:new Date()}).where(eq(assessmentParticipationSnapshot.id,old.id));
  else await tx.insert(assessmentParticipationSnapshot).values({tenantId:ctx.tenantId,cycleId,employmentId,eligibleAtOpen:initial.takingPart,reason:initial.reason,override,updatedBy:ctx.userId});
  const takingPart=override?override==='add':old?.eligibleAtOpen??initial.takingPart;
  if(takingPart&&!existingReview){
   const reviewId=await ensureAssessmentCycleReviewTx(tx,ctx,cycleId,employmentId);
   await initializeOnehrCycleTx(tx,ctx,cycleId,[reviewId]);
  }
  await tx.update(onehrCycle).set({revision:config.revision+1}).where(eq(onehrCycle.cycleId,cycleId));
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'review-cycle',aggregateId:cycleId,eventType:'review-cycle.participation-changed',actor:actorOf(ctx),payload:{employmentId,previous:old?.override??null,next:override,takingPart}});
 });
}
