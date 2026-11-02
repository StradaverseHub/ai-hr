/** Evaluation-only adapter. nativeDispatch MUST be the actual unmodified native owner.
 * Matching descriptors never certify a provider: only its callback, after opaque proof validation,
 * may create a capture here. Finite native policy/certificate/receipt controls remain mandatory.
 * One instance owns one evaluation lifetime; no telemetry, settlement or refund is accepted.
 */
import type {withReviewedAiSpendDispatch} from '../../core/ai-spend-capability';
import {aiSpendConfigurationDigest} from '../../lib/ai/spend-receipt';
import {createAttemptBudget} from '../../.github/ci/eval/attempt-budget.mjs';

type Binding = Readonly<{requestId:string;requestDigest:string;configurationDigest:string;ceilingNanos:bigint}>;
type Capture = Readonly<{requestId:string;requestDigest:string;configurationDigest:string;request:object}>;

export function createNativeEvalBudget(input:Readonly<{
  allocationNanos:bigint;maxAttempts:number;nativeDispatch:typeof withReviewedAiSpendDispatch;
}>) {
  if(typeof input.nativeDispatch!=='function')throw Error('Native evaluation dispatch unavailable.');
  const nativeDispatch=input.nativeDispatch,owned=new WeakMap<object,Binding>(),evidence:Binding[]=[];
  let sequence=0;
  const allocation=createAttemptBudget({allocationNanos:input.allocationNanos,maxAttempts:input.maxAttempts,
    resolveReviewedRequest(captured:Capture){
      const bound=owned.get(captured.request);
      if(!bound||bound.requestId!==captured.requestId||bound.requestDigest!==captured.requestDigest
        ||bound.configurationDigest!==captured.configurationDigest)throw Error('Native evaluation ceiling unavailable.');
      return bound;
    }});
  const dispatch:typeof withReviewedAiSpendDispatch=async(envelope,configuration,request,consume)=>
    nativeDispatch(envelope,configuration,request,async()=>{
      if(configuration.provider!=='openrouter'||configuration.model!=='openai/gpt-6-luna'||request.operation!=='conversation'
        ||!request.inputDigest||envelope.requestDigest!==request.inputDigest||!/^\d{1,19}$/.test(envelope.reservedNanos))
        throw Error('Native evaluation request unavailable.');
      const token=Object.freeze({}),bound=Object.freeze({requestId:`native_${++sequence}`,requestDigest:request.inputDigest,
        configurationDigest:aiSpendConfigurationDigest(configuration),ceilingNanos:BigInt(envelope.reservedNanos)});
      owned.set(token,bound);
      try{return await allocation.dispatch({requestId:bound.requestId,requestDigest:bound.requestDigest,
        configurationDigest:bound.configurationDigest,request:token},async()=>{evidence.push(bound);return consume();});}
      finally{owned.delete(token);}
    });
  return Object.freeze({dispatch,snapshot:allocation.snapshot,attemptEvidence:()=>Object.freeze(evidence.slice())});
}
