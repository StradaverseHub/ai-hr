/** Historical canonical completion selected by its human owner, never a quality score or causal
 * attribution. Candidate evaluation still reads fresh facts as the actual independent evaluator. */
import {z} from 'zod';
import {NATIVE_OUTCOME_ACTIONS} from './module-native-outcomes';
import {isAgentModuleCode} from './module-agents';
const Id=z.uuid().transform(value=>value.toLowerCase()),Digest=z.string().regex(/^[a-f0-9]{64}$/);
const Ref=z.object({associationId:Id,jobId:Id,associationReceiptDigest:Digest,nativeDigest:Digest,jobReceiptDigest:Digest,
 action:z.string().refine(value=>Object.hasOwn(NATIVE_OUTCOME_ACTIONS,value)),module:z.string().refine(isAgentModuleCode),expiresAt:z.iso.datetime()}).strict()
 .refine(value=>Object.hasOwn(NATIVE_OUTCOME_ACTIONS,value.action)&&NATIVE_OUTCOME_ACTIONS[value.action as keyof typeof NATIVE_OUTCOME_ACTIONS].module===value.module);
export type NativeCandidateSignal=Readonly<z.infer<typeof Ref>>;
/** One original native source per candidate keeps canonical source ownership a single interval.
 * Multiple actions are separate candidate hypotheses, not an unordered union of HR locks. */
export function captureNativeCandidateSignalIds(value:unknown):readonly string[]{
 const ids=z.array(Id).max(1).parse(value===undefined?[]:structuredClone(value));return Object.freeze(ids);
}
export function captureNativeCandidateSignals(value:unknown):readonly NativeCandidateSignal[]{
 const refs=z.array(Ref).max(1).parse(value===undefined?[]:structuredClone(value));return Object.freeze(refs.map(ref=>Object.freeze(ref)));
}
