/** Closed presentation choice only. No identity, salary, rating, history or proposed amount is sent. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
const reasons=['matrix','below_midpoint','above_range','promotion_nomination','separate_pools','bonus_matrix','long_without_increase'] as const;
const source=z.object({sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),reasonRefs:z.array(z.enum(reasons)).min(2).max(3)}).strict();
export function captureRewardAdvisorOutline(input:unknown){const p=source.parse(input);return{args:Object.freeze({system:'Order the supplied native explanation references for a human reviewing an advisory compensation suggestion. Return only JSON {"items":[0,1]} with two or three distinct supplied indexes. The deterministic owner has calculated and checked every figure. No person, pay, rating, history or amount is supplied. Never calculate, invent a fact, decide an award or produce prose.',prompt:JSON.stringify({items:p.reasonRefs.map((kind,index)=>({index,kind}))}),maxTokens:200,timeoutMs:15000}),local:Object.freeze({reasonRefs:p.reasonRefs})};}
export function rewardAdvisorOutlineFingerprint(input:unknown){return createHash('sha256').update(JSON.stringify(source.parse(input))).digest('hex');}
