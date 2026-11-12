/** The probation ending loop's automatic step: a REQUEST-ONLY step (owner decision, 11 November 2026).
 *
 * At Prepare the loop puts a confirmation review card on HR's Today. Above Prepare it opens the probation review itself
 * and routes it to the employee's manager with its due date, through the employment-review owner's own opener
 * (core/employment-review.ts startReviewTx, the same body the review sweep uses). It DECIDES NOTHING: it never confirms,
 * extends or ends employment, and changes no employment record; the manager evaluates and HR decides as usual.
 *  - Conditions, read under the sponsor's current authority: the employment is active with no resignation pending, the
 *    probation still ends on the date the case found, no probation review exists for it yet (the owner allows one per
 *    employment), and there is a manager to route it to.
 *  - Apply: the owner's opener in a transaction carrying the loop's attribution (core/loops/attribution.ts), so its
 *    'employment-review.started' event records the loop, its agent principal and the sponsor who answers for it, on
 *    behalf of the company. The loop's switch, the stop, the pause and the level are re-checked before and after.
 *  - Once per probation period: one action per case (migration 2004), and the owner refuses a second open or completed
 *    review.
 *  - Undo (owner, 13 November 2026): HR cancels the review the loop opened, within the window, through the owner's
 *    narrow cancelLoopOpenedReviewTx (core/loops/undo.ts). A cancelled review no longer blocks a later one.
 *  - Legacy path only (owner, 13 November 2026): an employment owned by the Probation module keeps its manual flow. It is
 *    skipped without recording an attempt (evaluateProbation returns null), so the act never fires for it.
 * No model is called. */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {domainEvent} from '../../db/schema';
import {probationDecisionFacts,probationOwnsLegacyReviewTx,reviewManagerTx,startReviewTx} from '../employment-review';
import {setLoopAttributionTx} from './attribution';
import {requireLoopMayStillActTx} from './act-gate';
import type {LoopAttribution} from '../../lib/ai-centre/loop-attribution';
import {LoopActRefused} from './act-clock-outs';
import type {LoopActionCheck,LoopActionFacts,LoopActionReason} from './autonomy-types';

export const PROBATION_ACT_VERSION='loop_probation_ending.act@v1';
const OWNER='core/employment-review.ts#probationDecisionFacts';
const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const check=(name:string,ruleVersion:string|null,ok:boolean):LoopActionCheck=>Object.freeze({check:name,ruleVersion,result:ok?'pass':'fail'});

export type ProbationCandidate=Readonly<{caseId:string;companyId:string;employmentId:string;endDate:string}>;
export type ProbationEvaluation=Readonly<{ok:boolean;reason:LoopActionReason|null;checks:readonly LoopActionCheck[]}>;

/** An open probation case with no review yet as a candidate: the employment and the end date the loop found. */
export function probationCandidate(row:Readonly<{id:string;companyId:string;employmentId:string|null;facts:Readonly<Record<string,unknown>>}>):ProbationCandidate|null{
 return row.employmentId&&isDate(row.facts.endDate)&&row.facts.stage==='none'
  ?Object.freeze({caseId:row.id,companyId:row.companyId,employmentId:row.employmentId,endDate:row.facts.endDate}):null;
}

/** The conditions, or null when the employment's review belongs to the Probation module: nothing is recorded and the
 * card stays with HR, who use the module's own flow. */
export async function evaluateProbation(sponsor:SessionContext,item:ProbationCandidate):Promise<ProbationEvaluation|null>{
 const route=await withTenant(sponsor,async tx=>({moduleOwned:await probationOwnsLegacyReviewTx(tx,item.employmentId),
  manager:await reviewManagerTx(tx,sponsor.tenantId,item.employmentId)}));
 if(route.moduleOwned)return null;
 const [fact]=(await probationDecisionFacts(sponsor,{companyIds:[],employmentIds:[item.employmentId]})).filter(row=>row.employmentId===item.employmentId);
 const active=!!fact&&!fact.terminated&&!fact.resigning;
 const same=!!fact&&fact.endDate===item.endDate&&(fact.review===null||fact.review.status==='cancelled');
 const managed=route.manager!==null;
 const checks=[check('employment_active',OWNER,active),check('probation_end_unchanged_and_no_review',OWNER,same),
  check('manager_to_route_to','core/employment-review.ts#reviewManagerTx',managed)];
 const reason:LoopActionReason|null=!active?'condition_inactive':!same?'condition_record_changed':!managed?'condition_no_manager':null;
 return Object.freeze({ok:reason===null,reason,checks:Object.freeze(checks)});
}

/** Dates and keys only: the probation end date the review is for (its due date is added once it is open). */
export const probationFacts=(item:ProbationCandidate):LoopActionFacts=>Object.freeze({date:item.endDate});

/** Open the review through its owner, attributed to the loop. The review is the owner's record of it. */
export async function applyProbation(sponsor:SessionContext,p:Readonly<{item:ProbationCandidate;actionId:string;workerId:string;attribution:LoopAttribution}>)
 :Promise<Readonly<{ownerRef:string;facts:LoopActionFacts}>>{
 try{
  return await withTenant(sponsor,async tx=>{
   await setLoopAttributionTx(tx,p.attribution);
   const gate={tenantId:sponsor.tenantId,workerId:p.workerId,companyId:p.item.companyId};
   await requireLoopMayStillActTx(tx,gate);
   const opened=await startReviewTx(tx,sponsor,{employmentId:p.item.employmentId,auto:true});
   // Only the probation review the case found; anything else rolls back.
   if(opened.reviewType!=='probation')throw new LoopActRefused('condition_record_changed');
   await requireLoopMayStillActTx(tx,gate);
   return Object.freeze({ownerRef:opened.reviewId,facts:Object.freeze({date:p.item.endDate,dueDate:opened.dueDate})});
  });
 }catch(error){throw error instanceof LoopActRefused?error:new LoopActRefused('owner_refused');}
}

/** For an attempt left half-way: the review's own start event, attributed to this action, says whether it was opened. */
export async function openedRecordOf(sponsor:SessionContext,actionId:string):Promise<Readonly<{ownerRef:string;at:Date}>|null>{
 return withTenant(sponsor,async tx=>{
  const [row]=await tx.select({id:domainEvent.aggregateId,at:domainEvent.occurredAt}).from(domainEvent)
   .where(and(eq(domainEvent.aggregateType,'employment-review'),eq(domainEvent.eventType,'employment-review.started'),
    sql`${domainEvent.payload}->'agentAttribution'->>'actionId'=${actionId}`)).limit(1);
  return row?Object.freeze({ownerRef:row.id,at:row.at}):null;
 });
}
