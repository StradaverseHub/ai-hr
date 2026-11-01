/** ADR-0170 §3.11 — the run trace of one harness turn, shaped so step 5a can persist it as the outcome record.
 *
 * It holds names, versions, counts, verdicts and argument digests: never a tool's data, a figure, a reply phrase
 * or an identifier the screen removed (only how many, and their kinds). The caller's ids are kept for the runner's
 * own checks; the outcome record stores only kinds and counts (./trace-persistence.ts storedTrace).
 * Field groups map to the outcome record: caller = authority; gate, offered, calls = basis; disclosure and
 * checks = constraints; spec and model = replay; outcome = outcome. Human decision fields arrive with 5a. */
import type {TurnGateReason} from '../../lib/product-context/request-gate';
import type {DisclosureApplied} from './disclosure';
import type {MemoryReauthorisation} from './memory';
import type {ReplyCheckResult} from './reply-checks';

export type TraceCallStatus='ok'|'refused'|'not_offered'|'invalid_input'|'unknown_handle'|'repeat'|'error';
export type TraceCall=Readonly<{step:number;tool:string;status:TraceCallStatus;argumentsDigest:string;refusal?:string}>;
export type TraceRetry=Readonly<{step:number;reason:'truncated'|'blank'|ReplyCheckResult['check']}>;
export type BudgetExhausted='steps'|'tokens'|'time'|'spend';
/** Identifiers removed before sending, per part of the request; counts and kinds only, never a value. */
export type TraceScreening=Readonly<{question:number;history:number;memory:number;tools:number;kinds:readonly string[]}>;
export type TurnTrace=Readonly<{
 kind:'teras.turn-trace';version:1;turnId:string;conversationId:string;startedAt:string;finishedAt:string;
 spec:Readonly<{version:number;digest:string}>;
 model:Readonly<{id:string}>;
 caller:Readonly<{tenantId:string;userId:string|null;personId:string|null;roles:readonly string[];authorityKey:string}>;
 gate:Readonly<{privateReads:boolean;actions:boolean;reason:TurnGateReason|null}>;
 offered:readonly string[];
 calls:readonly TraceCall[];
 disclosure:readonly DisclosureApplied[];
 checks:readonly Readonly<{attempt:number;results:readonly ReplyCheckResult[]}>[];
 retries:readonly TraceRetry[];
 screening:TraceScreening;
 budgets:Readonly<{steps:number;inputTokens:number;outputTokens:number;spendUsd:number;wallMs:number;exhausted:BudgetExhausted|null}>;
 restoration:Readonly<{restored:number;refused:readonly Readonly<{placeholder:string;reason:string}>[]}>;
 memory:MemoryReauthorisation;
 outcome:Readonly<{mode:string|null;slot:string|null;suggestion:string|null;openProposals:number;
  /** True when the shown reply is the spec's fixed fallback, not the model's. */
  fallback:boolean}>;
}>;
/** The trace keys step 5a's outcome record reads; test/teras-harness.test.ts asserts each is populated. */
export const TRACE_KEYS=Object.freeze(['kind','version','turnId','conversationId','startedAt','finishedAt','spec','model','caller','gate','offered','calls',
 'disclosure','checks','retries','screening','budgets','restoration','memory','outcome'] as const);
