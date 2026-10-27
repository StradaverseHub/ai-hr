/** IMPORT-SAFE SOURCE ONLY, UNRUN. Caller owns exact fictional target/browser lifetime and has
 * selected fixture.actors.operator through the REAL login/header UI. No route/session/request
 * injection, provider probe, evaluation or activation. A synthetic credential is never a real key.
 * Required private verifyNative({phase}) uses fresh native current-user reads; never echo inputs.
 * Returned checks contain no credential, ciphertext, candidate IDs, versions, user IDs or HR text. */
export const INACTIVE_PROVIDER_SELECTION=Object.freeze({model:'fictional/assistant-browser-inactive',providerOptions:Object.freeze({version:1,routing:Object.freeze({allowedProviders:Object.freeze(['openai']),allowFallbacks:false,sort:'latency'})})});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const fail=()=>{throw Error('assistant_provider_inactive_experience:unavailable');};
const requireFact=value=>{if(!value)fail();};
export function assertInactiveProviderFacts(facts,userId,candidate){
 requireFact(facts&&facts.currentActorUserId===userId&&facts.activeConfigurationCount===0&&facts.liveConfigurationCount===0&&facts.modelRunCount===0);
 requireFact(same(Object.keys(facts).sort(),['activeConfigurationCount','candidate','currentActorUserId','liveConfigurationCount','modelRunCount']));
 if(!candidate){requireFact(facts.candidate===null);return null;}
 const c=facts.candidate;requireFact(c&&uuid(c.candidateId)&&uuid(c.candidateVersion)&&c.model===INACTIVE_PROVIDER_SELECTION.model&&same(c.providerOptions,INACTIVE_PROVIDER_SELECTION.providerOptions));
 requireFact(same(Object.keys(c).sort(),['candidateId','candidateVersion','model','providerOptions']));return c;
}
export async function runAssistantProviderInactiveConfigEnglishExperience({page,fixture,verifyNative}){
 requireFact(page&&typeof page.goto==='function'&&typeof verifyNative==='function'&&fixture?.state==='native_prerequisites_prepared_not_experienced'&&uuid(fixture.actors?.operator?.userId));
 const url=new URL(page.url());requireFact(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.port);
 let posts=0,unexpected=false;const observe=request=>{if(request.method()==='POST'){posts++;try{const u=new URL(request.url());if(u.origin!==url.origin||u.pathname!=='/admin/ai'||posts>1)unexpected=true;}catch{unexpected=true;}}};
 const checks=[];page.on('request',observe);
 const card=()=>page.getByRole('heading',{name:'OpenRouter',exact:true}).locator('xpath=ancestor::*[@data-ui-card][1]');
 try{
  assertInactiveProviderFacts(await verifyNative({phase:'baseline'}),fixture.actors.operator.userId,false);
  await page.goto(url.origin+'/admin/ai');requireFact(new URL(page.url()).pathname==='/admin/ai');await card().waitFor();
  requireFact(await card().locator('input[name="makeActive"]').count()===0);
  await card().getByText('Save a candidate first. Your live provider stays unchanged until you evaluate and activate it.',{exact:true}).waitFor();
  await card().getByText('Requests require no data collection and zero data retention. Review the providers’ policies before enabling.',{exact:true}).waitFor();
  await card().locator('input[name="model"]').fill(INACTIVE_PROVIDER_SELECTION.model);
  // Save owner only validates/encrypts this fictional ASCII value; this journey NEVER tests it.
  const synthetic='NOT-A-REAL-CREDENTIAL-FICTIONAL-BROWSER-CANDIDATE-ONLY';
  await card().locator('input[name="apiKey"]').fill(synthetic);
  const routes=()=>card().getByLabel('Approved provider IDs, in order',{exact:true});
  for(const invalid of ['openai\nopenai','https://invalid.example/provider']){
   await routes().fill(invalid);await routes().blur();await card().getByRole('alert').filter({hasText:'Enter unique provider IDs using lowercase letters, numbers, hyphens or slashes.'}).waitFor();
   requireFact(await card().getByRole('button',{name:'Save',exact:true}).isDisabled());requireFact(posts===0&&!unexpected);
  }
  assertInactiveProviderFacts(await verifyNative({phase:'invalid_routes'}),fixture.actors.operator.userId,false);
  checks.push({id:'invalid_route_ui_refuses_before_save',passed:true});checks.push({id:'privacy_policy_displayed_no_activation_control',passed:true});
  await routes().fill('openai');await routes().blur();
  const fallback=card().getByLabel('Allow fallback within this approved list',{exact:true});if(await fallback.isChecked())await fallback.uncheck();
  await card().getByLabel('Routing preference',{exact:true}).selectOption('latency');
  requireFact(await card().getByRole('button',{name:'Save',exact:true}).isEnabled());
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).origin===url.origin&&new URL(r.url()).pathname==='/admin/ai',{timeout:30000});
  try{await card().getByRole('button',{name:'Save',exact:true}).click();const saved=await response;requireFact(saved.ok()||saved.status()===303);await saved.finished();}catch{void response.catch(()=>{});fail();}
  await page.waitForURL(u=>u.pathname==='/admin/ai'&&u.searchParams.has('toast'));
  const saved=assertInactiveProviderFacts(await verifyNative({phase:'saved'}),fixture.actors.operator.userId,true);
  requireFact(posts===1&&!unexpected);await card().getByRole('heading',{name:'Evaluate this saved candidate',exact:true}).waitFor();
  requireFact(await card().getByRole('button',{name:'Use evaluated candidate',exact:true}).isDisabled());requireFact(await card().getByRole('button',{name:'Run protocol evaluation',exact:true}).isDisabled());
  requireFact(await card().locator('input[name="apiKey"]').inputValue()==='');checks.push({id:'synthetic_candidate_saved_inactive_without_probe',passed:true});
  await page.reload();const reopened=assertInactiveProviderFacts(await verifyNative({phase:'reloaded'}),fixture.actors.operator.userId,true);requireFact(same(saved,reopened)&&posts===1&&!unexpected);
  await card().getByRole('heading',{name:'Evaluate this saved candidate',exact:true}).waitFor();requireFact(await card().locator('input[name="model"]').inputValue()===INACTIVE_PROVIDER_SELECTION.model);requireFact(await routes().inputValue()==='openai');
  requireFact(await card().getByRole('button',{name:'Use evaluated candidate',exact:true}).isDisabled());requireFact(await card().locator('input[name="apiKey"]').inputValue()==='');
  const body=await page.locator('body').innerText();requireFact(!body.includes(synthetic)&&!/SQLSTATE|PostgresError|AI_CONFIG_SECRET|Unhandled Runtime Error|postgres:\/\//i.test(body));checks.push({id:'same_nonsecret_candidate_version_and_routing_after_reload',passed:true});
  return {journey:'english_inactive_synthetic_provider_candidate',checks,syntheticCredentialOnly:true,capability:'UNVERIFIED_NO_PROVIDER_CALLS',security:'UNVERIFIED_BOUNDED_POSITIVE_AND_CLIENT_ROUTE_REFUSAL_ONLY',liveActivation:'UNVERIFIED_NOT_ATTEMPTED',notCovered:['server privacy override attacks','metadata/protocol/generation/provider capability','real credentials/account policy','cross-scope/revocation/concurrency','other locales/mobile/accessibility','production authentication','release gate']};
 }catch{fail();}finally{page.off('request',observe);}
}
