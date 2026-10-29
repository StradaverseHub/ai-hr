/** IMPORT-SAFE SOURCE ONLY, UNRUN. Actual English operator forms + independent native readback.
 * Caller owns the isolated fictional target and selects operator through real login/header UI.
 * No session/route/request injection, provider invocation, key, reviewed record or activation.
 * Pure fake-page tests establish this protocol only, never browser/database experience. */
export const AI_CONTROLS_PHASES=Object.freeze(['baseline','invalid_spend','invalid_concurrency','spend_saved','spend_reloaded','limits_saved','limits_reloaded','zero_paused','zero_reloaded','unlimited_saved','unlimited_reloaded']);
export const AI_CONTROLS_CHECKS=Object.freeze(['invalid_usd_server_refuses_without_write','invalid_concurrency_browser_refuses_without_write','exact_monthly_and_task_usd_allocation_persists','default_request_token_and_concurrency_limits_persist','zero_concurrency_is_not_blank_and_persists','blank_limits_restore_native_null_without_clearing_usd_budget','controls_change_only_expected_native_events_without_provider_activity']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const fail=()=>{throw Error('assistant_ai_controls_experience:unavailable');};
const requireFact=value=>{if(!value)fail();};
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),[...keys].sort());
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const nanos=v=>typeof v==='string'&&/^(0|[1-9]\d{0,18})$/.test(v)&&BigInt(v)<=BigInt('9223372036854775807');
/** Closed private facts, not report output. A row count never implies provider readiness. */
export function assertAiControlsFacts(facts,userId){
 requireFact(uuid(userId)&&closed(facts,['currentActorUserId','spend','defaultAllowance','spendEventCount','allowanceEventCount','otherControlEventCount','modelRunCount','providerConfigCount','providerCandidateCount','reviewedCarrierRecordCount'])&&facts.currentActorUserId===userId);
 requireFact(['spendEventCount','allowanceEventCount','otherControlEventCount','modelRunCount','providerConfigCount','providerCandidateCount','reviewedCarrierRecordCount'].every(key=>integer(facts[key],1000000)));
 requireFact(['modelRunCount','providerConfigCount','providerCandidateCount','reviewedCarrierRecordCount'].every(key=>facts[key]===0));
 requireFact(facts.spend===null||closed(facts.spend,['monthlyNanos','rootNanos'])&&nanos(facts.spend.monthlyNanos)&&nanos(facts.spend.rootNanos));
 const a=facts.defaultAllowance;requireFact(a===null||closed(a,['enabled','dailyRequests','monthlyTokens','maxConcurrent'])&&typeof a.enabled==='boolean'&&(a.dailyRequests===null||integer(a.dailyRequests,1000000))&&(a.maxConcurrent===null||integer(a.maxConcurrent,1000000))&&(a.monthlyTokens===null||typeof a.monthlyTokens==='string'&&/^(0|[1-9]\d{0,12})$/.test(a.monthlyTokens)&&BigInt(a.monthlyTokens)<=BigInt('1000000000000')));
 return structuredClone(facts);
}
export async function runAssistantAiControlsEnglishExperience({page,fixture,verifyNative}){
 requireFact(page&&typeof page.goto==='function'&&typeof verifyNative==='function'&&fixture?.state==='native_prerequisites_prepared_not_experienced'&&uuid(fixture.actors?.operator?.userId));
 let url;try{url=new URL(page.url());}catch{fail();}requireFact(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.port);
 const origin=url.origin,userId=fixture.actors.operator.userId;let posts=0,unexpected=false;
 const observe=request=>{if(request.method()==='POST'){posts++;try{const target=new URL(request.url());if(target.origin!==origin||target.pathname!=='/control-tower/agents'||posts>5)unexpected=true;}catch{unexpected=true;}}};
 const spend=()=>page.getByRole('heading',{name:'AI inference allocation (USD)',exact:true}).locator('xpath=ancestor::*[@data-ui-card][1]');
 const allowance=()=>page.locator('section[aria-labelledby="ai-user-default"]');
 const spendForm=()=>spend().locator('form'),allowanceForm=()=>allowance().locator('form');
 const input=name=>allowanceForm().locator(`input[name="${name}"]`);
 const monthly=()=>spend().getByLabel('Tenant monthly allocation (USD)',{exact:true}),root=()=>spend().getByLabel('Per-task lifetime allocation (USD)',{exact:true});
 async function native(phase){return assertAiControlsFacts(await verifyNative({phase}),userId);}
 async function submit(form,mode){
  const waiting=page.waitForResponse(response=>{const target=new URL(response.url());return response.request().method()==='POST'&&target.origin===origin&&target.pathname==='/control-tower/agents';},{timeout:30000});
  try{await form().getByRole('button',{name:'Save',exact:true}).click();const response=await waiting;requireFact(response.ok()||response.status()===303);await response.finished();}catch{void waiting.catch(()=>{});fail();}
  await page.waitForURL(target=>target.pathname==='/control-tower/agents'&&target.searchParams.has(mode));requireFact(!unexpected);
 }
 async function cleanPage(){const body=await page.locator('body').innerText();requireFact(!/SQLSTATE|PostgresError|AI_CONFIG_SECRET|Unhandled Runtime Error|postgres:\/\//i.test(body));}
 async function reload(){await page.reload();await spend().waitFor();await allowance().waitFor();}
 async function allowanceValues(daily,tokens,concurrent){requireFact(await input('dailyRequests').inputValue()===daily&&await input('monthlyTokens').inputValue()===tokens&&await input('maxConcurrent').inputValue()===concurrent&&await allowanceForm().locator('select[name="enabled"]').inputValue()==='true');}
 page.on('request',observe);
 try{
  const baseline=await native('baseline');await page.goto(origin+'/control-tower/agents');requireFact(new URL(page.url()).pathname==='/control-tower/agents');await spend().waitFor();await allowance().waitFor();requireFact(await spendForm().count()===1&&await allowanceForm().count()===1);
  await spend().getByText('Record counts do not verify live access, endpoint availability, current account controls or model capability. Those checks remain separate.',{exact:true}).waitFor();
  await monthly().fill('not-a-number');await root().fill('0');await submit(spendForm,'error');await page.getByRole('alert').waitFor();await cleanPage();requireFact(same(await native('invalid_spend'),baseline)&&posts===1);
  await input('maxConcurrent').fill('1.5');requireFact(await input('maxConcurrent').getAttribute('step')==='1'&&await input('maxConcurrent').getAttribute('max')==='1000000');
  // Read native HTML validity only; no DOM mutation or custom submit bypass.
  requireFact(await input('maxConcurrent').evaluate(element=>element.validity.valid)===false);await allowanceForm().getByRole('button',{name:'Save',exact:true}).click();requireFact(same(await native('invalid_concurrency'),baseline)&&posts===1&&!unexpected);
  await monthly().fill('12.345678901');await root().fill('0.5');await submit(spendForm,'toast');
  const budget={monthlyNanos:'12345678901',rootNanos:'500000000'},saved=await native('spend_saved');requireFact(same(saved,{...baseline,spend:budget,spendEventCount:baseline.spendEventCount+1})&&posts===2);
  await reload();requireFact(same(await native('spend_reloaded'),saved)&&await monthly().inputValue()==='12.345678901'&&await root().inputValue()==='0.5');
  await input('dailyRequests').fill('12');await input('monthlyTokens').fill('4000');await input('maxConcurrent').fill('2');await allowanceForm().locator('select[name="enabled"]').selectOption('true');await submit(allowanceForm,'toast');
  const limits={enabled:true,dailyRequests:12,monthlyTokens:'4000',maxConcurrent:2},limited=await native('limits_saved');requireFact(same(limited,{...saved,defaultAllowance:limits,allowanceEventCount:baseline.allowanceEventCount+1})&&posts===3);
  await reload();requireFact(same(await native('limits_reloaded'),limited));await allowanceValues('12','4000','2');
  await input('maxConcurrent').fill('0');await submit(allowanceForm,'toast');const paused=await native('zero_paused');requireFact(same(paused,{...limited,defaultAllowance:{...limits,maxConcurrent:0},allowanceEventCount:baseline.allowanceEventCount+2})&&posts===4);
  await reload();requireFact(same(await native('zero_reloaded'),paused));await allowanceValues('12','4000','0');
  await input('dailyRequests').fill('');await input('monthlyTokens').fill('');await input('maxConcurrent').fill('');await submit(allowanceForm,'toast');
  const unlimited=await native('unlimited_saved');requireFact(same(unlimited,{...saved,defaultAllowance:{enabled:true,dailyRequests:null,monthlyTokens:null,maxConcurrent:null},allowanceEventCount:baseline.allowanceEventCount+3})&&posts===5);
  await reload();requireFact(same(await native('unlimited_reloaded'),unlimited)&&posts===5&&!unexpected);await allowanceValues('','','');requireFact(await monthly().inputValue()==='12.345678901'&&await root().inputValue()==='0.5');
  await cleanPage();
  return{journey:'english_ai_controls',checks:AI_CONTROLS_CHECKS.map(id=>({id,passed:true})),capability:'UNVERIFIED_NO_PROVIDER_JOURNEY',coverage:'fictional_english_operator_control_values_events_and_reload_only',notCovered:['actual provider admission under zero concurrency','real provider capability or billing','cross-scope/revocation/concurrency attacks','other locales/mobile/accessibility','production authentication','release gate']};
 }catch{fail();}finally{page.off('request',observe);}
}
