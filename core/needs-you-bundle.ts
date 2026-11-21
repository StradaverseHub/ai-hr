/** Today's "Needs you" owners in ONE statement (docs/adr/2026-11-10-home-request-read-scope.md, decision 13).
 *
 * components/today/reads.ts readNeedsYou combines the approvals preview, the three governed leave review indices, the
 * loops' cards, the letter requests waiting for HR and, when a leave decision waits, the approver recommendation's run
 * gate. Each owner opened its own reads. Here the owners below are sections of a single statement, each built beside the
 * owner it reproduces (they share their select, joins, predicate and order) and evaluated in the caller's own session,
 * so row-level security is the owner's own:
 *  - the cancellation and decision review indices: the owner's own index function behind the owner's own presentation
 *    proof (aiPresentationPrincipalSql), called only where that function cannot refuse (core/home-leave-review-presentation.ts);
 *  - the loops' cards of a viewer without HR cards: the own open undo windows, every loop's gate, the pauses, the open
 *    cases and the Watch levels, with the owner's card rules on the rows (core/loops/cards.ts);
 *  - the letter requests waiting in the companies where the viewer holds `generate` (core/letter-requests.ts);
 *  - the recommender's run gate: its teras_worker_control switch and the tenant stop switch, read by the loops' own gate
 *    select (core/agent-registry/controls.ts). The owner's gate (workerRunGateTx) first takes the access-configuration
 *    lock and asserts the AI Centre generation (app.ai_centre_assert_running, which takes the ai-control lock and needs a
 *    READ COMMITTED transaction). Those locks are the authority of a worker's run: they hold a stop off until the run's
 *    effect commits. Needs you takes no effect under the gate; it only decides whether to offer the recommendation link,
 *    and the recommender asks its own gate, with both locks, before it computes and again before it records. So the
 *    offer reads the two switches in the shared read-only snapshot: one statement in one snapshot sees a state every
 *    writer committed, and the locks could only delay this read until an in-flight stop or access change commits
 *    (decision 3's reasoning). Inside an AI Centre activity (a generation to match, function checks) the owner reads.
 * Not here: the approvals preview (core/account-task-bundle.ts, its own statement), the own leave application index (its
 * owner installs statement and lock time bounds for its own transaction, which a shared snapshot cannot take for one
 * read), an administrator's loop feeds, proposals, readiness and digest (their owners read them), and the prepared
 * reviews' reopen (each repeats its owner's full current checks).
 *
 * A section the statement cannot answer exactly is null and its owner reads itself, unchanged, in the same snapshot.
 * Without a login, for an agent principal, when a section cannot be built or the statement fails, every owner reads
 * exactly as before. Read only; never cached beyond one response. withOwnerCardSectionReads (core/home-owner-reads.ts)
 * keeps the owners' path for equivalence. */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {aiCentreActivity} from '../lib/ai/centre-activity';
import {aiPresentationPrincipalSql} from './ai-principal';
import {ownerCardSectionReads} from './home-owner-reads';
import {homeLeaveReviewIndexBundleSql,homeLeaveReviewIndexFromBundle} from './home-leave-review-presentation';
import type {readHomeLeaveCancellationReviewIndex,readHomeLeaveDecisionReviewIndex} from './home-leave-review-presentation';
import {readLoopCardsFromSection,readLoopCardsSectionSql,type LoopCard} from './loops/cards';
import {countWaitingLetterRequestsBundleSql,countWaitingLetterRequestsFromBundle} from './letter-requests';
import {workerRunGatesBundleSql,workerRunGatesFromBundle,type WorkerGate} from './agent-registry/controls';

/** One section's owner result: its value, the owner's own refusal, or null where the owner must read itself. */
export type NeedsYouAnswer<T>=Readonly<{value:T}>|Readonly<{refused:true}>|null;
export type NeedsYouBundle=Readonly<{
 cancellations:NeedsYouAnswer<Awaited<ReturnType<typeof readHomeLeaveCancellationReviewIndex>>>;
 decisions:NeedsYouAnswer<Awaited<ReturnType<typeof readHomeLeaveDecisionReviewIndex>>>;
 loops:NeedsYouAnswer<readonly LoopCard[]>;
 letterRequests:NeedsYouAnswer<number>;
 /** The recommender's gate as workerRunGateTx answers it outside an AI Centre activity. */
 recommender:NeedsYouAnswer<WorkerGate>;
}>;
export type NeedsYouBundleRead=Readonly<{scopeIds:readonly string[];admin:boolean;
 /** The Leave module is on: the review indices are read. */
 leave:boolean;
 /** The recommender's worker id (core/recommenders/leave-decision.ts RECOMMENDER_WORKER). */
 recommender:string}>;

const REFUSED=Object.freeze({refused:true as const});
/** The owner's value from `project`, or null (the owner reads) where the projection declines or refuses its rows. */
function answer<T>(project:()=>T|null):NeedsYouAnswer<T>{
 try{const value=project();return value===null?null:Object.freeze({value});}catch{return null;}
}

/** One Needs you response's statement. Resolves null when every owner must read on its own; never rejects. */
export async function readNeedsYouBundle(ctx:SessionContext,read:NeedsYouBundleRead):Promise<NeedsYouBundle|null>{
 if(ownerCardSectionReads()||!ctx.userId||ctx.agent)return null;
 try{
  const proof=aiPresentationPrincipalSql(ctx),now=new Date(),activity=Boolean(aiCentreActivity(ctx.tenantId));
  const cancellations=read.leave?homeLeaveReviewIndexBundleSql(ctx,'cancellations',proof):null;
  const decisions=read.leave?homeLeaveReviewIndexBundleSql(ctx,'decisions',proof):null;
  // An administrator's loop cards carry HR's feeds, which their owner reads; the recommender's gate is then its own section.
  const loops=read.admin?null:readLoopCardsSectionSql(ctx,now,[read.recommender]);
  const gates=read.admin&&!activity?workerRunGatesBundleSql(ctx,[read.recommender]):null;
  const letterRequests=countWaitingLetterRequestsBundleSql(ctx,read.scopeIds);
  const sections:[string,SQL|null][]=[['cancellations',cancellations==='refused'?null:cancellations],['decisions',decisions==='refused'?null:decisions],
   ['loops',loops],['gates',gates],['letterRequests',letterRequests]];
  const built=sections.filter((entry):entry is [string,SQL]=>entry[1]!==null);
  let raw:Record<string,unknown>={};
  if(built.length){
   const [row]=await withTenant(ctx,tx=>tx.execute<{bundle:Record<string,unknown>|null}>(sql`select jsonb_build_object(${
    sql.join(built.map(([name,section])=>sql`${sql.raw(`'${name}'`)},${section}`),sql`, `)}) as bundle`),{readOnlySnapshot:true});
   if(!row?.bundle)return null;
   raw=row.bundle;
  }
  // A review index refuses exactly where its owner throws its one "unavailable": a refusal decided without reading, or a
  // proof the statement found false (the section is SQL null). A malformed row is left to the owner's own schema check.
  const refusedOr=<T,>(section:SQL|'refused'|null,value:unknown,project:()=>T):NeedsYouAnswer<T>=>
   section===null?null:section==='refused'||value===null?REFUSED:answer(project);
  const gate=(value:unknown)=>()=>workerRunGatesFromBundle([read.recommender],value)?.get(read.recommender)?.gate??null;
  return Object.freeze({
   cancellations:refusedOr(cancellations,raw.cancellations,()=>homeLeaveReviewIndexFromBundle('cancellations',raw.cancellations)),
   decisions:refusedOr(decisions,raw.decisions,()=>homeLeaveReviewIndexFromBundle('decisions',raw.decisions)),
   loops:loops?answer(()=>readLoopCardsFromSection(ctx,read.scopeIds,raw.loops)):null,
   letterRequests:letterRequests?answer(()=>countWaitingLetterRequestsFromBundle(raw.letterRequests)):null,
   recommender:activity?null:loops?answer(gate((raw.loops as {gates?:unknown}|undefined)?.gates)):gates?answer(gate(raw.gates)):null,
  });
 }catch{
  // The owners report their own failures (or succeed) exactly as before.
  return null;
 }
}
