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
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {terasOutcomeFollowup,terasOutcomeRecord} from '../../db/teras-schema';
import {terasGapExample,terasGapOccurrence,terasLearningSignal} from '../../db/teras-learning-schema';
import {hasTeamAccess,isAdmin,isGroupAdmin,isPayrollPartner} from '../../lib/authz-model';
import {AGENT_ACTIONS} from '../../lib/ai/agent-action-registry';
import {MODULE_AREA} from '../product-context/capability-catalogue';
import {verifyProposal} from '../proposals/proposal';
import {RECOMMENDER_AGENT_IDENTITY} from '../recommenders/leave-decision';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {terasCapabilityRegistry} from '../semantic-model/generate';
import {ASSISTANT_TURN_IDENTITY} from '../outcome-record/summary';
import {gapKindOf,intentOf,type GapTurn} from './gaps';
export {gapTurnOf} from './gaps';
import {REDACTION_VERSION,looksRedacted,redact} from './redact';
import {isCardSignal,isLearningLocale,type CardSignal,type LearningLocale,type LearningRole} from './types';

const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const person=(ctx:SessionContext):ctx is SessionContext&{userId:string}=>Boolean(ctx.userId)&&!ctx.agent;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const EXAMPLE_MAX_CHARS=400;

/** The role band a signal is recorded under: the eval set's roles. Group administrator first, then HR administrator, then
 * payroll, then manager; anyone else is an employee. */
export function roleBand(ctx:SessionContext):LearningRole{
 if(isGroupAdmin(ctx))return 'group_admin';
 if(isAdmin(ctx))return 'hr_admin';
 if(isPayrollPartner(ctx))return 'payroll';
 if(hasTeamAccess(ctx))return 'manager';
 return 'employee';
}
const localeOf=(value:unknown):LearningLocale=>isLearningLocale(value)?value:'en';

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

type OwnRecord=Readonly<{id:string;companyId:string;agentIdentity:string;reads:readonly {tool:string}[]}>;
/** The caller's own open record of a person's run, by run id (a turn) or id. A record private to the asker, another
 * login's record (invisible under 0928) or one without a company is null. */
async function ownRecordTx(tx:Tx,ctx:SessionContext&{userId:string},by:Readonly<{runId:string}|{id:string}>):Promise<OwnRecord|null>{
 const r=terasOutcomeRecord;
 const [row]=await tx.select({id:r.id,companyId:r.companyId,agentIdentity:r.agentIdentity,reads:r.reads,privateToAsker:r.privateToAsker,authorityKind:r.authorityKind,askedByUserId:r.askedByUserId})
  .from(r).where(and(eq(r.tenantId,ctx.tenantId),'runId' in by?eq(r.runId,by.runId):eq(r.id,by.id))).limit(1);
 if(!row||row.privateToAsker||row.authorityKind!=='person'||row.askedByUserId!==ctx.userId||!row.companyId)return null;
 return Object.freeze({id:row.id,companyId:row.companyId,agentIdentity:row.agentIdentity,reads:row.reads});
}

/** Rows a statement without RETURNING wrote (postgres-js reports `count`). */
const affected=(result:unknown)=>Number((result as {count?:unknown}|null)?.count??0);
type SignalRow=typeof terasLearningSignal.$inferInsert;
/** One signal per record and key: a repeat records nothing (the first stands). */
async function insertSignalTx(tx:Tx,row:SignalRow):Promise<boolean>{
 const inserted=await tx.insert(terasLearningSignal).values(row).onConflictDoNothing().returning({id:terasLearningSignal.id});
 return inserted.length===1;
}

export type SignalOutcome=Readonly<{recorded:boolean}>;
const NOT_RECORDED:SignalOutcome=Object.freeze({recorded:false});

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

/** An answer marked helpful (true) or not helpful (false), on the turn `turnId`. The first mark stands. */
export async function recordAnswerMark(supplied:SessionContext,input:Readonly<{turnId:unknown;helpful:unknown;locale?:unknown}>):Promise<SignalOutcome>{
 const ctx=capture(supplied);
 if(!person(ctx)||typeof input.helpful!=='boolean'||typeof input.turnId!=='string'||!UUID.test(input.turnId))return NOT_RECORDED;
 const turnId=input.turnId,helpful=input.helpful;
 return withTenant(ctx,async tx=>{
  const record=await ownRecordTx(tx,ctx,{runId:turnId});
  if(!record||record.agentIdentity!==ASSISTANT_TURN_IDENTITY)return NOT_RECORDED;
  return {recorded:await insertSignalTx(tx,{tenantId:ctx.tenantId,companyId:record.companyId,recordId:record.id,signalKey:'answer',
   kind:helpful?'answer_helpful':'answer_unhelpful',action:'answer',area:areasOfReads(record.reads)[0]??'general',role:roleBand(ctx),locale:localeOf(input.locale),
   proposalId:null,byUserId:ctx.userId})};
 });
}

/** The approver decided against a recommendation: recorded only once the recommender's own follow-up says so. */
export async function recordRecommendationSignal(supplied:SessionContext,input:Readonly<{recordId:unknown;locale?:unknown}>):Promise<SignalOutcome>{
 const ctx=capture(supplied);
 if(!person(ctx)||typeof input.recordId!=='string'||!UUID.test(input.recordId))return NOT_RECORDED;
 const recordId=input.recordId;
 return withTenant(ctx,async tx=>{
  const record=await ownRecordTx(tx,ctx,{id:recordId});
  if(!record||record.agentIdentity!==RECOMMENDER_AGENT_IDENTITY)return NOT_RECORDED;
  const f=terasOutcomeFollowup;
  const [rejected]=await tx.select({id:f.id}).from(f).where(and(eq(f.tenantId,ctx.tenantId),eq(f.recordId,record.id),eq(f.kind,'decision'),eq(f.decision,'rejected'))).limit(1);
  if(!rejected)return NOT_RECORDED;
  return {recorded:await insertSignalTx(tx,{tenantId:ctx.tenantId,companyId:record.companyId,recordId:record.id,signalKey:'recommendation',
   kind:'recommendation_rejected',action:'approvals.leave.decide',area:'approvals',role:roleBand(ctx),locale:localeOf(input.locale),proposalId:null,byUserId:ctx.userId})};
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
export async function recordGapFromTurn(supplied:SessionContext,input:Readonly<{turnId:string;turn:GapTurn;question:string;companyId:string;locale?:unknown}>):Promise<GapCapture>{
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
  const redacted=redact(input.question,{knownNames:await knownNamesTx(tx),maxLength:EXAMPLE_MAX_CHARS});
  const example=redacted.text.length>0&&looksRedacted(redacted.text);
  if(example)await tx.insert(terasGapExample).values({tenantId:ctx.tenantId,companyId:record.companyId,recordId:record.id,intentKey,text:redacted.text,
   redactionVersion:REDACTION_VERSION}).onConflictDoNothing();
  return {captured:true,intentKey,example} as const;
 });
}
