/** Session mechanics ONLY: fake native dispatcher and fake global HTTP, never a provider call.
 * This fake seam proves no native authority/certificate/price. The separate native-budget suite
 * exercises real proof custody/SQL. Frozen tracked plans/source bindings are read normally.
 */
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {withReviewedAiSpendDispatch} from '../core/ai-spend-capability';
import type {AiAdmission} from '../lib/ai/governance';
import type {ResolvedAiConfig} from '../lib/ai/types';
import {bindNativeEvalDispatch,createModelEvalSession,type EvalGrade} from './helpers/ai-eval-session';

type Session=NonNullable<ReturnType<typeof createModelEvalSession>>;
type Case={id:string;requiresModel:boolean;dependsOn:string|null;quality:{criteria:string[]}};
const carrier='test/assistant-model-ceiling.eval.test.ts';
const configuration:ResolvedAiConfig={provider:'openrouter',model:'openai/gpt-6-luna',apiKey:'fictional-never-network',
  providerOptions:{version:1,routing:{allowedProviders:['fictional'],allowFallbacks:false,sort:'latency'}}};
const request:Readonly<AiAdmission>=Object.freeze({operation:'conversation',reservedTokens:1,inputDigest:'a'.repeat(64)});
const envelope=Object.freeze({capabilityDigest:'b'.repeat(64),requestDigest:'a'.repeat(64),reservedNanos:'1'});
// Intentionally fake proof owner. Never reuse this as native authorization or real carrier evidence.
const fakeNative:typeof withReviewedAiSpendDispatch=async(_envelope,_configuration,_request,consume)=>consume();
let dispatch:typeof withReviewedAiSpendDispatch,directory:string;
const sessions:Session[]=[];
const grade=(row:Case):EvalGrade=>({findings:[],criteria:Object.fromEntries(row.quality.criteria.map(id=>[id,'met' as const]))});
const cases=(session:Session)=>session.plan.cases as Case[];
function session(){
  const value=createModelEvalSession(carrier);if(!value)throw Error('Expected requested fictional session');
  sessions.push(value);return value;
}
const post=()=>fetch('https://openrouter.ai/api/v1/chat/completions',{
  method:'POST',body:JSON.stringify({model:'openai/gpt-6-luna',messages:[{role:'user',content:'Fictional mechanics only'}]}),
});
const model=()=>dispatch(envelope,configuration,request,post);

beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'aihr-eval-session-'));
  for(const [key,value]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',
    GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123456',AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'b'.repeat(40),
    AIHR_EVAL_REQUESTED:'true',AIHR_EVAL_MODEL:'openai/gpt-6-luna',AIHR_EVAL_PROVIDER:'openrouter',
    AIHR_EVAL_OPENROUTER_KEY:'fictional-session-key-not-live',AIHR_EVAL_BUDGET_USD:'15',AIHR_EVAL_PATH:'production',
    AIHR_EVAL_ALLOWED_PROVIDERS:'fictional',AIHR_EVAL_REPEATS:'3',AIHR_EVAL_PROFILE:'assistant-model-ceiling-full-v1',
    AIHR_EVAL_PLAN_HASH:'',AIHR_EVAL_CORPUS_REVIEW_DIGEST:'',AIHR_FOCUSED_EVIDENCE_DIR:directory}))vi.stubEnv(key,value);
  // Installed BEFORE a session captures fetch; every underlying call is fictional and local.
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('fictional HTTP result')));
  dispatch=bindNativeEvalDispatch(fakeNative);
});
afterEach(()=>{
  // Finish even failed assertions; an already finalized receipt is idempotent.
  for(const value of sessions.splice(0)){
    try{value.finish();}catch{/* Expected persistence-failure cases still release their runtime in finally. */}
  }
  vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();rmSync(directory,{recursive:true,force:true});
});

describe('fictional evaluation session mechanics without native authority or network',()=>{
  it('one reserved attempt permits only one POST even when the underlying fetch throws',async()=>{
    const http=vi.mocked(fetch);http.mockRejectedValueOnce(Error('Fictional network failure'));
    const value=session(),row=cases(value).find(item=>item.requiresModel&&item.dependsOn===null)!;
    expect(row).toBeDefined();
    await value.run(row.id,()=>dispatch(envelope,configuration,request,async()=>{
      await expect(post()).rejects.toThrow('Fictional network failure');
      await expect(post()).rejects.toThrow('Unreserved evaluation inference refused');
      return null;
    }),()=>grade(row));
    expect(http).toHaveBeenCalledOnce();
    const receipt=value.finish();
    expect((receipt.outcomes as {id:string;providerCalls:number}[]).find(item=>item.id===row.id)?.providerCalls).toBe(1);
    expect(receipt.budget).toMatchObject({snapshot:{attempts:1,reservedNanos:'1'}});
  });

  it('evidence write failure restores fetch and releases the active session; persistence can retry',()=>{
    const http=fetch,value=session(),file=join(directory,'not-a-directory');writeFileSync(file,'fictional');
    vi.stubEnv('AIHR_FOCUSED_EVIDENCE_DIR',file);
    expect(()=>value.finish()).toThrow();
    expect(fetch).toBe(http);
    // A new runtime is allowed after failed persistence. No call reaches HTTP.
    vi.stubEnv('AIHR_FOCUSED_EVIDENCE_DIR',join(directory,'second'));
    const next=session();expect(next.finish()).toMatchObject({path:'production'});expect(fetch).toBe(http);
    vi.stubEnv('AIHR_FOCUSED_EVIDENCE_DIR',join(directory,'retry'));
    const retried=value.finish();expect(retried).toMatchObject({path:'production'});
    expect(value.finish()).toBe(retried);expect(fetch).toBe(http);
    expect(vi.mocked(http)).not.toHaveBeenCalled();
  });

  it('failed predecessor blocks its continuation callback and finalizes every other planned case explicitly unrun',async()=>{
    const http=vi.mocked(fetch),value=session(),rows=cases(value),next=rows.find(item=>item.dependsOn!==null
      &&rows.find(previous=>previous.id===item.dependsOn)?.dependsOn===null)!;
    expect(next).toBeDefined();const previous=rows.find(item=>item.id===next.dependsOn)!;
    await expect(value.run(previous.id,async()=>{throw Error('Fictional predecessor failure');},()=>grade(previous)))
      .rejects.toThrow('Fictional predecessor failure');
    const callback=vi.fn(async()=>null);
    await expect(value.run(next.id,callback,()=>grade(next))).rejects.toThrow('evaluation_dependency_unavailable');
    expect(callback).not.toHaveBeenCalled();expect(http).not.toHaveBeenCalled();
    const receipt=value.finish(),outcomes=receipt.outcomes as {id:string;status:string}[];
    expect(outcomes).toHaveLength(rows.length);
    expect(outcomes.find(item=>item.id===previous.id)?.status).toBe('error');
    expect(outcomes.find(item=>item.id===next.id)?.status).toBe('dependency_unavailable');
    expect(outcomes.filter(item=>item.status==='unrun')).toHaveLength(rows.length-2);
    expect(new Set(outcomes.map(item=>item.id)).size).toBe(rows.length);
    expect(()=>value.assertExecution()).toThrow('Evaluation is incomplete or unsafe');
  });

  it('a completed model-required case with zero POST fails even when all other cases complete and many model calls succeed',async()=>{
    const http=vi.mocked(fetch),value=session(),rows=cases(value),missing=rows.find(item=>item.requiresModel)!;
    expect(missing).toBeDefined();
    for(const row of rows)await value.run(row.id,async()=>{
      if(row.requiresModel&&row.id!==missing.id)await model();
      return null;
    },()=>grade(row));
    expect(http.mock.calls.length).toBeGreaterThan(0);
    expect(()=>value.assertExecution()).toThrow('Evaluation is incomplete or unsafe');
    const outcomes=value.finish().outcomes as {id:string;status:string;providerCalls:number}[];
    expect(outcomes.every(item=>item.status==='completed')).toBe(true);
    expect(outcomes.find(item=>item.id===missing.id)?.providerCalls).toBe(0);
  });
});
