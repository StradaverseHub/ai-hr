/** Pure boundary fixtures only; these are NOT browser/native/provider capability evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {INACTIVE_PROVIDER_SELECTION,assertInactiveProviderFacts} from './assistant-provider-config-experience.mjs';
const userId='00000000-0000-4000-8000-000000000001';
const baseline=()=>({currentActorUserId:userId,candidate:null,activeConfigurationCount:0,liveConfigurationCount:0,modelRunCount:0});
const saved=()=>({...baseline(),candidate:{candidateId:'00000000-0000-4000-8000-000000000002',candidateVersion:'00000000-0000-4000-8000-000000000003',...INACTIVE_PROVIDER_SELECTION}});
test('closed nonsecret facts require empty live/admission state and exact candidate version/routing',()=>{
 assert.equal(assertInactiveProviderFacts(baseline(),userId,false),null);assert.deepEqual(assertInactiveProviderFacts(saved(),userId,true),saved().candidate);
 for(const patch of [{currentActorUserId:'other'},{activeConfigurationCount:1},{liveConfigurationCount:1},{modelRunCount:1},{apiKey:'private'},{candidate:saved().candidate}])assert.throws(()=>assertInactiveProviderFacts({...baseline(),...patch},userId,false));
 for(const patch of [{candidateId:'not-id'},{candidateVersion:null},{model:'other/model'},{providerOptions:{version:1,routing:{allowedProviders:['other'],allowFallbacks:false,sort:'latency'}}},{ciphertext:'private'},{keyLast4:'abcd'}])assert.throws(()=>assertInactiveProviderFacts({...saved(),candidate:{...saved().candidate,...patch}},userId,true));
});
test('selection and source remain inactive-only with no transport/mock/probe/effect executor',()=>{
 assert(Object.isFrozen(INACTIVE_PROVIDER_SELECTION)&&Object.isFrozen(INACTIVE_PROVIDER_SELECTION.providerOptions.routing.allowedProviders));
 const source=readFileSync(new URL('./assistant-provider-config-experience.mjs',import.meta.url),'utf8');
 for(const prohibited of ['page.route(','context.route(','page.request.','addCookies(','evaluateProviderCandidateAction(','testConnectionAction(','setActiveProviderAction(','fetch('])assert(!source.includes(prohibited));
 assert(source.includes("getByRole('button',{name:'Save',exact:true}).click()"));
 assert(source.includes("capability:'UNVERIFIED_NO_PROVIDER_CALLS'"));assert(source.includes("liveActivation:'UNVERIFIED_NOT_ATTEMPTED'"));
});
