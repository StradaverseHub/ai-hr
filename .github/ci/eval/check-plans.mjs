/** Static plan/hash verification only. Imports no application/provider client and performs no network. */
import {execFileSync} from 'node:child_process';
import {captureRequestedEval,EVAL_CARRIERS,loadEvalPlan} from './contract.mjs';
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
for(const carrier of Object.keys(EVAL_CARRIERS)){
 const profile=carrier.includes('/review/')?'teras-review-model-full-v1':'assistant-model-ceiling-full-v1';
 const request=captureRequestedEval({AIHR_EVAL_REQUESTED:'true',AIHR_EVAL_MODEL:'openai/gpt-6-luna',
  AIHR_EVAL_OPENROUTER_KEY:'fictional-static-parser-only',AIHR_EVAL_BUDGET_USD:'15',AIHR_EVAL_ALLOWED_PROVIDERS:'fictional',
  AIHR_EVAL_PATH:'production',AIHR_EVAL_PROFILE:profile},[carrier],{
   sourceSha:sha,controllerSha:sha,runId:process.env.GITHUB_RUN_ID??'1',attempt:'1',
   runtime:{node:process.versions.node,platform:process.platform,arch:process.arch}});
 const plan=loadEvalPlan(request,process.cwd());
 console.log(JSON.stringify({kind:'STATIC_EVAL_PLAN_NOT_MODEL_RESULT',carrier,cases:plan.cases.length,planHash:plan.planHash,corpusReviewDigest:plan.corpusReviewDigest}));
}
