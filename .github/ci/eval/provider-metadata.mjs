/** Non-billable metadata only. Never returns a credential, key label or account identity. */
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const APPROVED_MODEL='openai/gpt-6-luna';
const nullableNumber=value=>value===null?null:Number.isFinite(value)&&value>=0?value:undefined;
export function keyBudgetMetadata(value){
 const data=value?.data;if(!data||typeof data!=='object')throw Error('Invalid key metadata');
 const limit=nullableNumber(data.limit),remaining=nullableNumber(data.limit_remaining);
 if(limit===undefined||remaining===undefined)throw Error('Missing or invalid key budget metadata');
 if(data.limit_reset!==null&&!['daily','weekly','monthly'].includes(data.limit_reset))throw Error('Invalid key reset metadata');
 // Publish only the decision needed for the approved allocation, never account balances/usage above it.
 const output={finiteLimit:limit!==null,remainingClass:remaining===null?'unlimited':remaining>15?'above-approved-allocation':'within-approved-allocation',
  remainingUsd:remaining!==null&&remaining<=15?remaining:null,limitReset:data.limit_reset,
  includeByokInLimit:data.include_byok_in_limit===true,isManagementKey:data.is_management_key===true};
 return output;
}
export function modelMetadata(value){
 const data=value?.data;
 if(data?.id!==APPROVED_MODEL||!Array.isArray(data.endpoints)||!data.endpoints.length)throw Error('Approved model metadata unavailable');
 return {id:data.id,endpoints:data.endpoints.map(endpoint=>({tag:endpoint.tag,status:endpoint.status,context_length:endpoint.context_length,
  max_prompt_tokens:endpoint.max_prompt_tokens,max_completion_tokens:endpoint.max_completion_tokens,
  supported_parameters:endpoint.supported_parameters,pricing:endpoint.pricing}))};
}
async function metadata(url,key){
 let response;
 try{response=await fetch(url,{headers:key?{authorization:'Bearer '+key}:{},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw Error('Provider metadata request unavailable');}
 if(!response.ok)throw Error('Provider metadata refused: HTTP '+response.status);
 const body=await response.text();if(body.length>1024*1024)throw Error('Provider metadata too large');
 try{return JSON.parse(body);}catch{throw Error('Malformed provider metadata');}
}
export async function inspectProviderMetadata(key){
 if(typeof key!=='string'||!key.trim())throw Error('Protected evaluation key missing');
 const budget=keyBudgetMetadata(await metadata('https://openrouter.ai/api/v1/key',key));
 const model=modelMetadata(await metadata('https://openrouter.ai/api/v1/models/'+APPROVED_MODEL+'/endpoints'));
 return {kind:'NON_BILLABLE_EVAL_PROVIDER_METADATA_NOT_MODEL_RESULT',modelCalls:0,spentUsd:0,source:process.env.GITHUB_SHA??null,
  runId:process.env.GITHUB_RUN_ID??null,observedAt:new Date().toISOString(),budget,model};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const output=process.argv[2];if(!output)throw Error('Fresh metadata output path required');
 inspectProviderMetadata(process.env.AIHR_EVAL_OPENROUTER_KEY).then(value=>{
  writeFileSync(output,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});console.log('Non-billable metadata recorded; no model calls.');
 }).catch(error=>{console.error(error.message);process.exitCode=1;});
}
