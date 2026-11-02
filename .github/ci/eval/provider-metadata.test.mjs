import test from 'node:test';
import assert from 'node:assert/strict';
import {APPROVED_MODEL,inspectProviderMetadata,keyBudgetMetadata,modelMetadata} from './provider-metadata.mjs';
const key=overrides=>({data:{limit:100,limit_remaining:75,limit_reset:'weekly',include_byok_in_limit:false,is_management_key:false,...overrides}});
const model=()=>({data:{id:APPROVED_MODEL,endpoints:[{tag:'openai',status:0,context_length:1000,max_completion_tokens:100,supported_parameters:['tools'],pricing:{prompt:'0.000001',completion:'0.000002'}}]}});
test('public key summary excludes all larger balances, usage, labels and credentials',()=>{
 const summary=keyBudgetMetadata(key({usage:25,label:'private-key-label',secret:'never-publish'}));
 assert.deepEqual(summary,{finiteLimit:true,remainingClass:'above-approved-allocation',remainingUsd:null,limitReset:'weekly',includeByokInLimit:false,isManagementKey:false});
 assert(!JSON.stringify(summary).includes('private-key'));assert(!JSON.stringify(summary).includes('never-publish'));
});
test('bounded and unlimited metadata remain distinct; unknown data is never guessed',()=>{
 assert.equal(keyBudgetMetadata(key({limit:15,limit_remaining:7,limit_reset:null,include_byok_in_limit:true})).remainingUsd,7);
 assert.equal(keyBudgetMetadata(key({limit:null,limit_remaining:null})).remainingClass,'unlimited');
 for(const input of [undefined,{},key({limit_remaining:NaN}),key({limit:-1}),key({limit_reset:'tomorrow'}),key({limit_remaining:undefined})])assert.throws(()=>keyBudgetMetadata(input));
});
test('model snapshot requires the exact approved model and an actual endpoint population',()=>{
 assert.equal(modelMetadata(model()).id,APPROVED_MODEL);
 assert.throws(()=>modelMetadata({data:{id:'different/model',endpoints:[{}]}}));
 assert.throws(()=>modelMetadata({data:{id:APPROVED_MODEL,endpoints:[]}}));
});
test('metadata inspection makes fixed non-billable GETs with no redirect and no secret output',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(url.endsWith('/key')?key({}):model()),{status:200});});
 const result=await inspectProviderMetadata('fictional-not-a-real-key');
 assert.equal(result.modelCalls,0);assert.equal(result.spentUsd,0);assert.equal(calls.length,2);
 assert.equal(calls[0].url,'https://openrouter.ai/api/v1/key');assert.equal(calls[0].init.redirect,'error');
 assert.equal(calls[1].url,'https://openrouter.ai/api/v1/models/'+APPROVED_MODEL+'/endpoints');
 assert(!JSON.stringify(result).includes('fictional-not-a-real-key'));
});
test('missing credential and provider failures refuse without echoing remote body or key',async t=>{
 await assert.rejects(inspectProviderMetadata(''),/missing/);
 t.mock.method(globalThis,'fetch',async()=>new Response('private-response-body',{status:401}));
 await assert.rejects(inspectProviderMetadata('fictional-secret'),error=>error.message==='Provider metadata refused: HTTP 401');
});
