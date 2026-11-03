/** AI v2 Phase 2, P2-6 — capturing learning signals and gaps (migration 0972), as the person who acted.
 *
 * WHAT IS CAPTURED, and from where:
 *  - a prepared card confirmed unchanged, opened to edit, or discarded (components/ai-centre/proposal-card-actions.tsx posts
 *    it after the press; the signed proposal is verified for this caller first, so nobody records a signal on a card they
 *    were not given);
 *  - a recommendation the approver decided against (app/assistant/centre/recommendation.ts, after the recommender's own
 *    follow-up recorded the disagreement: core/recommenders/leave-decision.ts recordRecommendationDecision);
 *  - an answer marked helpful or not helpful;
 *  - a gap: a turn AI Centre could not answer or do (./gaps.ts), with its question redacted (./redact.ts), from the chat
 *    wiring after the reply was shown (app/assistant/launcher-actions.ts).
 * Every one names the outcome record of the turn it came from, read here as the caller: their own record, of a person's
 * run, not private to the asker. A gated turn's record IS private to the asker (migration 0905/0928), so it is refused here
 * and again by the 0972 insert policies: gated sensitive turns store no words and are never learned from.
 *
 * WHAT IS STORED: kinds, closed-vocabulary names (the action, the product area, the role band, the locale), the record and
 * proposal references, and the person's login for attribution (never shown; the page shows the role). A gap example is
 * the only text, redacted before it is written and kept for the tenant's "Keep chats for" window. Capture never changes a
 * reply, a card or a decision: every failure is swallowed by the callers and logged by kind only. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {terasGapExample,terasGapOccurrence,terasLearningSignal} from '../../db/teras-learning-schema';
import {AGENT_ACTIONS} from '../../lib/ai/agent-action-registry';
import {MODULE_AREA} from '../product-context/capability-catalogue';
import {verifyProposal} from '../proposals/proposal';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {terasCapabilityRegistry} from '../semantic-model/generate';
import {gapKindOf,intentOf,type GapTurn} from './gaps';
export {gapTurnOf} from './gaps';
import {REDACTION_VERSION,looksRedacted,redact} from './redact';
import {isAnswerReason,isCardSignal,type CardSignal} from './types';
import {ASSISTANT_TURN_IDENTITY,NOT_RECORDED,UUID,affected,capture,insertSignalTx,localeOf,ownRecordTx,person,roleBand,type SignalOutcome} from './capture';
export {recordRecommendationSignal} from './recommendation-signal';
export {roleBand,type SignalOutcome} from './capture';

export const EXAMPLE_MAX_CHARS=400;

/** An action's product area, from the module the semantic model or the action registry declares for it. */
export function actionArea(action:string):string{
 const module=SEMANTIC_ACTIONS.find(row=>row.id===action)?.module??AGENT_ACTIONS.find(row=>row.id===action)?.module;
 return (module&&MODULE_AREA[module])||'general';
}
let readAreas:ReadonlyMap<string,string>|null=null;
/** The product areas of a record's private reads (context tools have no area). */
function areasOfReads(reads:readonly {tool:string}[]):string[]{
 readAreas??=new Map(terasCapabilityRegistry().filter(row=>row.effect==='read'&&row.module).map(row=>[row.name,MODULE_AREA[row.module!]??'general']));
 return [...new Set(reads.map(read=>readAreas!.get(read.tool)).filter((area):area is string=>Boolean(area)&&area!=='general'))];
}

/** A prepared card's Confirm (unchanged), Edit or Discard, on the turn `turnId`. */
export async function recordCardSignal(supplied:SessionContext,input:Readonly<{proposal:unknown;turnId:unknown;signal:unknown;locale?:unknown;now?:Date}>):Promise<SignalOutcome>{
 const ctx=capture(supplied);
 if(!person(ctx)||!isCardSignal(input.signal)||typeof input.turnId!=='string'||!UUID.test(input.turnId))return NOT_RECORDED;
 const verified=verifyProposal(input.proposal,ctx,input.now??new Date());
 if(!verified.ok)return NOT_RECORDED;
 const body=verified.proposal.body,signal:CardSignal=input.signal,turnId=input.turnId;
 return withTenant(ctx,async tx=>{
  const record=await ownRecordTx(tx,ctx,{runId:turnId});
  if(!record||record.agentIdentity!==ASSISTANT_TURN_IDENTITY)return NOT_RECORDED;
  return {recorded:await insertSignalTx(tx,{tenantId:ctx.tenantId,companyId:record.companyId,recordId:record.id,signalKey:`card:${body.id}`,kind:signal,
   action:body.what.action,area:actionArea(body.what.action),role:roleBand(ctx),locale:localeOf(input.locale),proposalId:body.id,byUserId:ctx.userId})};
 });
}

/** What the reply's Helpful / Not helpful control learns back: whether the mark was recorded, the mark that now counts,
 * and whether it may still be changed (once). */
export type AnswerMarkOutcome=Readonly<{recorded:boolean;mark:'helpful'|'unhelpful'|null;canChange:boolean}>;
const NO_MARK:AnswerMarkOutcome=Object.freeze({recorded:false,mark:null,canChange:false});
/** An answer marked helpful (true) or not helpful (false), on the turn `turnId`, with an optional reason for "Not helpful".
 *  - The first mark is recorded as 'answer'. It may be changed once: the other mark is recorded as 'answer_changed', which
 *    counts instead of the first. A third choice records nothing.
 *  - A reason given for the "Not helpful" mark that counts is added to it, once (0972's column grant and trigger).
 * Never for a gated (private) turn or another login's turn. */
export async function recordAnswerMark(supplied:SessionContext,input:Readonly<{turnId:unknown;helpful:unknown;reason?:unknown;locale?:unknown}>):Promise<AnswerMarkOutcome>{
 const ctx=capture(supplied);
 if(!person(ctx)||typeof input.helpful!=='boolean'||typeof input.turnId!=='string'||!UUID.test(input.turnId))return NO_MARK;
 if(input.reason!==undefined&&input.reason!==null&&(!isAnswerReason(input.reason)||input.helpful))return NO_MARK;
 const turnId=input.turnId,helpful=input.helpful,reason=isAnswerReason(input.reason)?input.reason:null,kind=helpful?'answer_helpful' as const:'answer_unhelpful' as const;
 return withTenant(ctx,async tx=>{
  const record=await ownRecordTx(tx,ctx,{runId:turnId});
  if(!record||record.agentIdentity!==ASSISTANT_TURN_IDENTITY)return NO_MARK;
  const s=terasLearningSignal;
  const marks=await tx.select({id:s.id,key:s.signalKey,kind:s.kind,reason:s.reason}).from(s)
   .where(and(eq(s.tenantId,ctx.tenantId),eq(s.recordId,record.id),inArray(s.signalKey,['answer','answer_changed']),eq(s.byUserId,ctx.userId)));
  const first=marks.find(row=>row.key==='answer'),changed=marks.find(row=>row.key==='answer_changed'),current=changed??first;
  const view=(row:{kind:string}|undefined,canChange:boolean):AnswerMarkOutcome=>Object.freeze({recorded:true,mark:row?.kind==='answer_helpful'?'helpful':row?'unhelpful':null,canChange});
  if(current&&current.kind===kind){
   // The same mark again: only a missing reason may be added.
   if(reason&&!current.reason){
    const updated=await tx.update(s).set({reason}).where(and(eq(s.id,current.id),eq(s.tenantId,ctx.tenantId))).returning({id:s.id});
    return updated.length?view(current,!changed):NO_MARK;
   }
   return Object.freeze({recorded:false,mark:helpful?'helpful':'unhelpful',canChange:!changed});
  }
  if(changed)return Object.freeze({recorded:false,mark:changed.kind==='answer_helpful'?'helpful':'unhelpful',canChange:false});
  const recorded=await insertSignalTx(tx,{tenantId:ctx.tenantId,companyId:record.companyId,recordId:record.id,signalKey:first?'answer_changed':'answer',
   kind,action:'answer',area:areasOfReads(record.reads)[0]??'general',role:roleBand(ctx),locale:localeOf(input.locale),proposalId:null,reason,byUserId:ctx.userId});
  return recorded?Object.freeze({recorded:true,mark:helpful?'helpful':'unhelpful',canChange:!first}):NO_MARK;
 });
}

/** The names redaction removes from the caller's own words: their own name, and the people their row-level security lets
 * them see (at most 2,000, longest first in ./redact.ts). Never shown or stored. */
export async function knownNamesTx(tx:Tx,limit=2000):Promise<string[]>{
 const rows=await tx.execute(sql`select p.full_name,p.preferred_name from public.person p where p.tenant_id=app.current_tenant_id()
  order by p.full_name limit ${limit}`) as unknown as {full_name:string|null;preferred_name:string|null}[];
 return Array.from(rows).flatMap(row=>[row.full_name,row.preferred_name]).filter((name):name is string=>typeof name==='string'&&name.trim().length>=2);
}

export type GapCapture=Readonly<{captured:false}|{captured:true;intentKey:string;example:boolean}>;
/** A turn AI Centre could not answer or do: its intent counted, and its question kept redacted. `turn` is the wiring's
 * ConversationTurn view; `question` is the words the person typed. Nothing for a gated turn or a turn that is not a gap. */
export async function recordGapFromTurn(supplied:SessionContext,input:Readonly<{turnId:string;turn:GapTurn;question:string;companyId:string;locale?:unknown;
 /** The asker's stored chat the turn was written to (core/teras-chats.ts recordChatTurn). Without one, the gap is counted and
  * no example is kept: an example lives only as long as the chat it came from. */
 chatId?:string|null}>):Promise<GapCapture>{
 const ctx=capture(supplied);
 const kind=gapKindOf(input.turn);
 if(!person(ctx)||!kind||!UUID.test(input.turnId)||!UUID.test(input.companyId))return {captured:false};
 return withTenant(ctx,async tx=>{
  const record=await ownRecordTx(tx,ctx,{runId:input.turnId});
  if(!record||record.agentIdentity!==ASSISTANT_TURN_IDENTITY||record.companyId!==input.companyId)return {captured:false} as const;
  const {area,intentKey}=intentOf(kind,input.question,areasOfReads(record.reads));
  // No RETURNING: only the company's administrators may read an occurrence (0972), not the person who asked.
  const occurrence=await tx.insert(terasGapOccurrence).values({tenantId:ctx.tenantId,companyId:record.companyId,recordId:record.id,kind,area,intentKey,
   role:roleBand(ctx),locale:localeOf(input.locale)}).onConflictDoNothing();
  if(affected(occurrence)!==1)return {captured:false} as const;
  const chatId=typeof input.chatId==='string'&&UUID.test(input.chatId)?input.chatId:null;
  if(!chatId)return {captured:true,intentKey,example:false} as const;
  const redacted=redact(input.question,{knownNames:await knownNamesTx(tx),maxLength:EXAMPLE_MAX_CHARS});
  const example=redacted.text.length>0&&looksRedacted(redacted.text);
  // The policy checks the chat is the asker's own; the link is never read back out.
  if(example)await tx.insert(terasGapExample).values({tenantId:ctx.tenantId,companyId:record.companyId,recordId:record.id,chatId,intentKey,text:redacted.text,
   redactionVersion:REDACTION_VERSION}).onConflictDoNothing();
  return {captured:true,intentKey,example} as const;
 });
}
