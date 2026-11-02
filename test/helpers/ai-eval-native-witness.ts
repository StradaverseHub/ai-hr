/** Evaluation-only native correlation. Inject the ACTUAL existing lifecycle/proof owners.
 * An admitted hook is provisional; publication occurs only inside the original proof callback
 * after its admission transaction committed. This grants no model, data, spend or effect authority.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {withAiAdmissionLifecycle} from '../../core/ai-governance';
import type {withReviewedAiSpendDispatch} from '../../core/ai-spend-capability';
import type {AiAdmission} from '../../lib/ai/governance';
import {aiSpendConfigurationDigest} from '../../lib/ai/spend-receipt';

const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export type NativeEvalAttempt=Readonly<{evaluationId:string;caseId:string;runId:string;capabilityDigest:string;
  requestDigest:string;configurationDigest:string;ceilingNanos:string}>;
export function createNativeEvalWitness(input:Readonly<{evaluationId:string;
  withLifecycle:typeof withAiAdmissionLifecycle;nativeDispatch:typeof withReviewedAiSpendDispatch}>) {
  if(!id(input.evaluationId)||typeof input.withLifecycle!=='function'||typeof input.nativeDispatch!=='function')
    throw Error('Native evaluation witness unavailable.');
  const evaluationId=input.evaluationId,withLifecycle=input.withLifecycle,nativeDispatch=input.nativeDispatch;
  const scope=new AsyncLocalStorage<string>(),pending=new WeakMap<object,Readonly<{caseId:string;runId:string}>>();
  const committed=new WeakMap<object,NativeEvalAttempt>(),records:NativeEvalAttempt[]=[],runs=new Set<string>();
  const configuration=(cfg:Parameters<typeof withAiAdmissionLifecycle>[0],feature:Parameters<typeof withAiAdmissionLifecycle>[1])=>withLifecycle(cfg,feature,{
      async admitted(_tx,event){
        const caseId=scope.getStore();
        if(!caseId||!uuid(event.runId)||pending.has(event.request))throw Error('Native evaluation case unavailable.');
        pending.set(event.request,Object.freeze({caseId,runId:event.runId}));
      },
    });
  const dispatch:typeof withReviewedAiSpendDispatch=(envelope,cfg,request,consume)=>
    nativeDispatch(envelope,cfg,request,async()=>{
      const captured=pending.get(request),caseId=scope.getStore();
      if(!captured||captured.caseId!==caseId||runs.has(captured.runId)||!request.inputDigest
        ||envelope.requestDigest!==request.inputDigest)throw Error('Committed native evaluation attempt unavailable.');
      const record=Object.freeze({evaluationId,caseId:captured.caseId,runId:captured.runId,
        capabilityDigest:envelope.capabilityDigest,requestDigest:envelope.requestDigest,
        configurationDigest:aiSpendConfigurationDigest(cfg),ceilingNanos:envelope.reservedNanos});
      pending.delete(request);runs.add(captured.runId);committed.set(request,record);records.push(record);
      return consume();
    });
  return Object.freeze({configuration,dispatch,
    runCase<T>(caseId:string,work:()=>Promise<T>):Promise<T>{
      if(!id(caseId)||typeof work!=='function')throw Error('Native evaluation case unavailable.');
      return scope.run(caseId,work);
    },
    attemptFor(request:Readonly<AiAdmission>):NativeEvalAttempt|null{return committed.get(request)??null;},
    committedAttempts:()=>Object.freeze(records.slice()),
  });
}
