/** ADR-0170 §3.11, step 5a — persists one harness turn trace (./trace.ts) as its outcome record.
 *
 * The trace already holds only names, versions, counts, verdicts and argument digests, so the whole trace is
 * kept in the record's `trace` column for replay, and its field groups map onto the record's columns:
 * caller → authority (the person who asked); calls → reads; reply checks → checks, each labelled with the
 * harness spec version that defined it; spec and model → replay; outcome → outcome. A turn never prepares,
 * confirms or writes a change, so it is recorded as answered, suggested or fallback, with no human
 * involvement yet: a later decision on a suggestion is appended as a follow-up (core/outcome-record).
 *
 * The record is written as the caller, in the caller's own transaction scope; a trace whose caller is not
 * the session is refused. Not wired: the runner stays off until the ADR-0169 §5.1 review. */
import {createHash} from 'node:crypto';
import type {SessionContext} from '../../db/client';
import {writeOutcomeRecord,type NoticeState,type OutcomeCheck,type OutcomeRecordInput,type OutcomeRead} from '../outcome-record/record';
import {TRACE_KEYS,type TurnTrace} from './trace';

export const ASSISTANT_AGENT_IDENTITY='teras.assistant' as const;
const REPLY_CHECK_OWNER='core/harness/reply-checks.ts#checkReply';
const GATE_OWNER='lib/product-context/request-gate.ts#gateTurn';

export function outcomeRecordFromTrace(trace:TurnTrace,options:Readonly<{companyId?:string|null;notice?:NoticeState}>={}):OutcomeRecordInput{
 for(const key of TRACE_KEYS)if(!(key in trace))throw Error('Trace is missing '+key+'.');
 if(!trace.caller.userId)throw Error('A turn trace without a login has no person to record.');
 const specLabel=`harness_spec:v${trace.spec.version}#${trace.spec.digest.slice(0,16)}`;
 const reads:OutcomeRead[]=trace.calls.map(call=>({tool:call.tool,status:call.status,argumentsDigest:call.argumentsDigest}));
 // The last attempt's reply checks are the ones the shown reply passed or failed.
 const lastChecks=trace.checks.at(-1)?.results??[];
 const checks:OutcomeCheck[]=[
  {check:'turn_gate',owner:GATE_OWNER,ruleVersion:specLabel,result:trace.gate.reason===null?'pass':'needs_review'},
  ...lastChecks.map(result=>({check:result.check,owner:REPLY_CHECK_OWNER,ruleVersion:specLabel,result:result.ok?'pass' as const:'fail' as const})),
 ];
 const provider=trace.model.id.includes('/')?trace.model.id.split('/')[0]:null;
 const catalogue=createHash('sha256').update(JSON.stringify([...trace.offered].sort())).digest('hex').slice(0,16);
 return{
  runId:trace.turnId,runKind:'turn',companyId:options.companyId??null,
  startedAt:new Date(trace.startedAt),finishedAt:new Date(trace.finishedAt),
  authority:{kind:'person',askedByUserId:trace.caller.userId},
  agentIdentity:ASSISTANT_AGENT_IDENTITY,
  reads,checks,
  replay:{model:trace.model.id,provider,instructionSet:specLabel,specVersion:String(trace.spec.version),specDigest:trace.spec.digest,toolCatalogue:`offered:${catalogue}`},
  outcomeKind:trace.outcome.fallback?'fallback':trace.outcome.suggestion?'suggested':'answered',
  outcome:{mode:trace.outcome.mode,slot:trace.outcome.slot,suggestion:trace.outcome.suggestion,openProposals:trace.outcome.openProposals,
   fallback:trace.outcome.fallback,budgetExhausted:trace.budgets.exhausted},
  humanInvolvement:'none',
  // A turn answers the person who asked about their own work unless the surface says otherwise.
  notice:options.notice??'not_applicable',
  trace:JSON.parse(JSON.stringify(trace)) as Record<string,unknown>,
 };
}

/** Writes the trace's outcome record as the caller. */
export async function persistTurnTrace(ctx:SessionContext,trace:TurnTrace,options:Readonly<{companyId?:string|null;notice?:NoticeState}>={}){
 if(trace.caller.tenantId!==ctx.tenantId||trace.caller.userId!==(ctx.userId??null))throw Error('The trace belongs to another caller.');
 return writeOutcomeRecord(ctx,outcomeRecordFromTrace(trace,options));
}
