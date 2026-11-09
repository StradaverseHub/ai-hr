/** Actual browser producer. This captures development observations, never release authority.
 * The existing system runner owns native fixture provisioning/session creation and traffic.
 * Call once per role in each phase, with its already authenticated Playwright Page. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Page,Response} from 'playwright';
import {fixtureNavigationActor,navigationExpectedText,NAVIGATION_CAPTURE_MEMBER,NAVIGATION_CAPTURE_VERSION,validateNavigationCapture,
 NATIVE_HIDDEN_SHELL_CASES,NATIVE_SHELL_BASELINE_VERSION,NATIVE_SHELL_LEGACY_SCENARIO_SHA256,nativeHiddenShellCasesSha256,validateNativeShellBaseline,
 type NavigationCapture,type NavigationCaptureBundle,type NavigationObservation,type NavigationScenario,type NavigationFixtureTextBindings,
 type NativeHiddenShellCase,type NativeHiddenShellObservation,type NativeShellIdentity} from './navigation-protocol';
import {navigationCleanHead,navigationSourceIdentity} from './navigation-source';
import {readNavigationFixtureBindings} from './navigation-fixture-bindings';
import {navigationScenarioEntry} from './navigation-entry';
import {assertNativeShellDestinationHidden,clickNativeShellDestination} from './navigation-shell-browser';
const BASE='https://localhost:3443';
const failuresSelector={busy:'main[data-personnel-busy],main[data-page-busy],main [data-personnel-busy],main [data-page-busy]',
 unavailable:'main [data-read-unavailable],main [data-today-unavailable]',alerts:'main [role="alert"]'} as const;
type LoadState={active:number;inSteadyWindow:boolean};
const instrumented=new WeakSet<Page>();
async function installFailureObserver(page:Page){
 if(instrumented.has(page))return;instrumented.add(page);
 await page.addInitScript((selectors)=>{
  const counts={busy:0,unavailable:0,alerts:0};
  Object.defineProperty(window,'__aihrNavigationFailureCaptureV1',{value:counts});
  const inspect=()=>{for(const key of ['busy','unavailable','alerts']as const)counts[key]=Math.max(counts[key],document.querySelectorAll(selectors[key]).length);};
  new MutationObserver(records=>{inspect();for(const record of records)for(const node of record.addedNodes)if(node instanceof Element){
   for(const key of ['busy','unavailable','alerts']as const)if(node.matches(selectors[key])||node.querySelector(selectors[key]))counts[key]++;
  }}).observe(document,{childList:true,subtree:true,attributes:true});inspect();
 },failuresSelector);
}
async function capturedFailures(page:Page){
 return page.evaluate(()=>{
  const counts=(window as unknown as {__aihrNavigationFailureCaptureV1?:{busy:number;unavailable:number;alerts:number}}).__aihrNavigationFailureCaptureV1;
  if(!counts)throw Error('Native failure-state observer missing');return {...counts};
 });
}

const nativePrimaryProperty='__aihrNativePrimaryFailureCaptureV1';
const nativePrimaryBinding='__aihrNativePrimaryRetirementV1';
const nativePrimaryPages=new WeakSet<Page>();
const nativeHiddenShellPages=new WeakSet<Page>();
const nativeMarkerAttributes={'data-personnel-busy':'busy','data-page-busy':'busy',
 'data-read-unavailable':'unavailable','data-today-unavailable':'unavailable',role:'alerts'}as const;
const nativeDocumentId=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Retirement={id:string;received:boolean;wake?:()=>void};
type NativeDocumentSnapshot={id:string;origin:string;busy:number;unavailable:number;alerts:number};

/** One already-owned primary Page. The bridge can only record failures and
 * acknowledge retirement of a document the driver has independently observed. */
export async function installNativePrimaryFailureObserver(page:Page){
 return (await installNativeDocumentFailureObserver(page,'primary')).retirement;
}

async function installNativeDocumentFailureObserver(page:Page,scope:'primary'|'hidden-shell'){
 const primary=scope==='primary',pages=primary?nativePrimaryPages:nativeHiddenShellPages;
 assert(!pages.has(page),'Native document retirement observer already installed');pages.add(page);
 const binding=primary?nativePrimaryBinding:'__aihrNativeHiddenShellRetirementV1';
 const property=primary?nativePrimaryProperty:'__aihrNativeHiddenShellFailureCaptureV1';
 const frame=page.mainFrame(),context=page.context(),key=randomUUID(),seen=new Set<string>();
 const markerDocuments={busy:0,unavailable:0,alerts:0};
 let active:string|undefined,retiring:Retirement|undefined,awaitingSnapshot=false,finalBlank=false,retired=0,refusals=0;
 const refuse=()=>{refusals++;retiring?.wake?.();return false;};
 const bridge=await page.exposeBinding(binding,(source,...args:unknown[])=>{
  const payload=args[0]as {key?:unknown;id?:unknown;mask?:unknown;terminal?:unknown}|null|undefined;
  if(source.page!==page||source.frame!==frame||source.context!==context||args.length!==1||!payload||typeof payload!=='object'
   ||Object.keys(payload).sort().join(',')!=='id,key,mask,terminal'||payload.key!==key
   ||!retiring||retiring.received||payload.id!==retiring.id||payload.terminal!==true
   ||typeof payload.mask!=='number'||!Number.isSafeInteger(payload.mask)||payload.mask<0||payload.mask>7)return refuse();
  // Frame URL is mutable by the time a queued pagehide reaches this callback.
  // The exact retiring document was already admitted at the same-origin snapshot.
  if(payload.mask&1)markerDocuments.busy++;
  if(payload.mask&2)markerDocuments.unavailable++;
  if(payload.mask&4)markerDocuments.alerts++;
  retiring.received=true;retired++;retiring.wake?.();return true;
 });
 const selectors={...failuresSelector,unavailable:failuresSelector.unavailable+',main[data-read-unavailable],main[data-today-unavailable]',
  alerts:failuresSelector.alerts+',main[role="alert"]'};
 const script=await page.addInitScript(({selectors,property,attributes,ingress,binding,key})=>{
  if(window.top!==window||location.origin!==ingress)return;
  const send=(window as unknown as Record<string,unknown>)[binding];
  if(typeof send!=='function')throw Error('Native primary retirement binding missing');
  const id=crypto.randomUUID(),counts={busy:0,unavailable:0,alerts:0};
  const kinds=['busy','unavailable','alerts']as const;
  const inspect=()=>{for(const kind of kinds)counts[kind]=Math.max(counts[kind],document.querySelectorAll(selectors[kind]).length);};
  const observe=(records:MutationRecord[])=>{
   inspect();
   for(const record of records){
    if(record.type==='attributes'&&record.target instanceof Element&&record.target.closest('main')){
     const name=record.attributeName as keyof typeof attributes;
     if(Object.hasOwn(attributes,name)&&(name==='role'?record.oldValue==='alert':record.oldValue!==null))counts[attributes[name]]++;
    }
    for(const node of record.addedNodes)if(node instanceof Element){
     for(const kind of kinds)if(node.matches(selectors[kind])||node.querySelector(selectors[kind]))counts[kind]++;
    }
   }
  };
  const observer=new MutationObserver(observe);
  observer.observe(document,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:Object.keys(attributes)});
  const snapshot=()=>{observe(observer.takeRecords());return{id,origin:location.origin,...counts};};
  Object.defineProperty(window,property,{value:snapshot});
  window.addEventListener('pagehide',event=>{
   const final=snapshot();observer.disconnect();
   const mask=Number(final.busy>0)+2*Number(final.unavailable>0)+4*Number(final.alerts>0);
   // A retired document may be disposed before the RPC returns. Only receipt
   // in the driver counts. Transport failure leaves its retirement missing.
   void Promise.resolve(send({id,key,mask,terminal:event.isTrusted&&!event.persisted})).catch(()=>{});
  },{once:true});
  inspect();
 },{selectors,property,attributes:nativeMarkerAttributes,ingress:BASE,binding,key});

 const beginRetirement=()=>{
  assert(!retiring&&!awaitingSnapshot&&!finalBlank,'Native document transition already open');
  if(active){retiring={id:active,received:false};active=undefined;}
 };
 async function waitForRetirement(remaining:()=>number){
  const pending=retiring;
  if(pending&&!pending.received&&refusals===0)await new Promise<void>((resolve,reject)=>{
   const ms=remaining();assert(Number.isSafeInteger(ms)&&ms>0&&ms<=90000,'Native retirement wait outside deadline');
   const timer=setTimeout(()=>{pending.wake=undefined;refusals++;reject(Error('Native document retirement receipt missing'));},ms);
   pending.wake=()=>{clearTimeout(timer);pending.wake=undefined;resolve();};
  });
  assert(refusals===0&&(!pending||pending.received),'Native document retirement refused');
  retiring=undefined;
 }
 const retirement={
  beforeNavigation(){beginRetirement();awaitingSnapshot=true;},
  async snapshot(remaining:()=>number){
   assert(awaitingSnapshot,'Native document snapshot without owned navigation');
   await waitForRetirement(remaining);
   const read=await page.evaluate(property=>{
    const snapshot=(window as unknown as Record<string,(()=>NativeDocumentSnapshot)|undefined>)[property];
    if(!snapshot)throw Error('Native primary failure-state observer missing');return snapshot();
   },property);
   remaining();
   assert(read&&Object.keys(read).sort().join(',')==='alerts,busy,id,origin,unavailable'
    &&frame===page.mainFrame()&&new URL(frame.url()).origin===BASE&&read.origin===BASE
    &&typeof read.id==='string'&&nativeDocumentId.test(read.id)&&!seen.has(read.id)&&seen.size<72,'Native document snapshot identity differs');
   for(const count of [read.busy,read.unavailable,read.alerts])assert(Number.isSafeInteger(count)&&count>=0,'Native DOM failure count invalid');
   seen.add(read.id);active=read.id;awaitingSnapshot=false;
   return{busy:read.busy,unavailable:read.unavailable,alerts:read.alerts};
  },
  async finish(remaining:()=>number){
   assert(active,'Missing last native primary document');
   beginRetirement();
   const response=await page.goto('about:blank',{waitUntil:'commit',timeout:remaining()});
   assert(response===null&&page.url()==='about:blank','Native primary inert retirement navigation differs');
   await waitForRetirement(remaining);remaining();finalBlank=true;
  },
  facts(){return{admitted:seen.size,retired,refusals,finalBlank,markerDocuments:{...markerDocuments}};},
  requireSettled(expected:number){
   assert(finalBlank&&!active&&!retiring&&!awaitingSnapshot&&seen.size===expected&&retired===expected&&refusals===0,
    'Native primary document retirement census incomplete');
   assert(Object.values(markerDocuments).every(count=>count===0),'Native DOM failure observed through document retirement');
  },
 };
 return {retirement,async disposeHiddenShell(){
  assert(!primary,'Native primary observer remains bound to its Page lifetime');
  retirement.requireSettled(4);
  // The last tracked document is already retired at about:blank. Remove this
  // scope before the same Page begins the independent 187-route observer.
  await script.dispose();await bridge.dispose();
 }};
}

const browserFailureCounts=()=>({aborted:0,transport:0,http5xx:0,pageError:0,consoleError:0,crash:0});
/** Browser events on already-owned Pages. Observations confer no admission. */
export function createNativeBrowserFailureObservation(){
 const pages=new WeakMap<Page,ReturnType<typeof browserFailureCounts>>(),total=browserFailureCounts();
 return {
  observe(page:Page){
   assert(!pages.has(page),'Native browser Page already observed');const counts=browserFailureCounts();pages.set(page,counts);
   const add=(kind:keyof typeof counts)=>{counts[kind]++;total[kind]++;};
   page.on('requestfailed',request=>{if(new URL(request.url()).origin===BASE)add(request.failure()?.errorText==='net::ERR_ABORTED'?'aborted':'transport');});
   page.on('response',response=>{if(new URL(response.url()).origin===BASE&&response.status()>=500)add('http5xx');});
   page.on('pageerror',()=>add('pageError'));
   page.on('console',message=>{if(message.type()==='error')add('consoleError');});
   page.on('crash',()=>add('crash'));
  },
  pageCount(page:Page){const counts=pages.get(page);assert(counts,'Unobserved native browser Page');return Object.values(counts).reduce((sum,count)=>sum+count,0);},
  facts(){return {...total};},
  requireClean(){assert(Object.values(total).every(count=>count===0),'Native browser failures observed through settlement');},
 };
}
export type NavigationCaptureCollector=ReturnType<typeof createNavigationCaptureCollector>;
function fixtureRealm(){
 assert(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr','Hosted fictional navigation runner required');
 assert(process.env.AIHR_PERFORMANCE_ROLE_FIXTURE==='true','Fictional native-role fixture required');
 const database=new URL(process.env.DATABASE_URL??'');
 assert(database.hostname==='127.0.0.1'&&database.pathname==='/ai_hr_dev','Isolated fictional navigation database required');
}
export function createNavigationCaptureCollector({phase,sourceRoot=process.cwd()}:{phase:'baseline'|'loaded';sourceRoot?:string}){
 fixtureRealm();assert(phase==='baseline'||phase==='loaded','Unknown navigation phase');
 const candidateSha=navigationCleanHead(sourceRoot),controllerSha=process.env.AIHR_CI_CONTROL_HEAD??'';
 assert(candidateSha===process.env.AIHR_CI_HEAD&&/^[a-f0-9]{40}$/.test(controllerSha),'Exact navigation candidate/controller required');
 const runId=Number(process.env.GITHUB_RUN_ID);assert(Number.isSafeInteger(runId)&&runId>0&&process.env.GITHUB_RUN_ATTEMPT==='1','First hosted navigation attempt required');
 const identity=navigationSourceIdentity(sourceRoot,candidateSha),fixtureBindings=readNavigationFixtureBindings(),observations:NavigationObservation[]=[],seen=new Set<string>();
 let sealed=false,legacyCapture:NavigationCapture|undefined;
 let nativeShell:ReturnType<typeof createNativeHiddenShellCollector>|undefined;
 return {
  phase,
  nativeHiddenShell(deadline:number){
   assert(phase==='baseline'&&!sealed&&!nativeShell&&!seen.size,'Native shell requires one fresh baseline collector');
   const source={candidateSha,controllerSha,runId,harnessSha256:identity.harnessSha256,scenarioSha256:identity.scenarioSha256};
   nativeShell=createNativeHiddenShellCollector(source,deadline,()=>legacyCapture);
   return {captureActor:nativeShell.captureActor,finish:nativeShell.finish};
  },
  async captureActor(page:Page,actorIndex:number,loadState?:()=>LoadState){
   assert(!sealed,'Navigation capture already sealed');fixtureRealm();
   const actor=fixtureNavigationActor(actorIndex),scenarios=identity.plan.scenarios.filter(row=>row.role===actor.role);
   assert(scenarios.length>0&&!scenarios.some(row=>seen.has(row.id)),'Navigation role missing or captured twice');
   assert(phase==='baseline'||typeof loadState==='function','Loaded navigation needs actual traffic state');
   for(const scenario of scenarios){
    const bindings=fixtureBindings.get(actorIndex);assert(bindings&&bindings.actorName===actor.name,'Native fictional actor binding missing');
    const observation=await captureScenario(page,actorIndex,scenario,phase,bindings,loadState);
    observations.push(observation);seen.add(scenario.id);
   }
   nativeShell?.bindLegacyRole(page,actorIndex);
  },
  finish():NavigationCapture{
   assert(!sealed,'Navigation capture already sealed');sealed=true;
   assert(navigationCleanHead(sourceRoot)===candidateSha,'Navigation source changed while executing');
   legacyCapture=validateNavigationCapture({schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,fixture:identity.plan.fixture,engine:identity.plan.engine,
    candidateSha,controllerSha,runId,runAttempt:1,harnessSha256:identity.harnessSha256,scenarioSha256:identity.scenarioSha256,phase,complete:true,observations},identity.plan,
    {candidateSha,controllerSha,runId,harnessSha256:identity.harnessSha256,scenarioSha256:identity.scenarioSha256,phase});
   return legacyCapture;
  },
 };
}
async function captureScenario(page:Page,actorIndex:number,scenario:NavigationScenario,phase:'baseline'|'loaded',bindings:Readonly<NavigationFixtureTextBindings>,loadState?:()=>LoadState):Promise<NavigationObservation>{
 const actor=fixtureNavigationActor(actorIndex),entry=navigationScenarioEntry(scenario),started=performance.now(),deadline=started+90000;
 const remaining=()=>{const ms=Math.floor(deadline-performance.now());assert(ms>0,'Navigation scenario deadline exceeded');return ms;};
 const sample=()=>{const state=loadState?.();if(phase==='loaded')assert(state?.active===500&&state.inSteadyWindow===true,'Navigation must start and finish within steady 500-user load');return state?{active:state.active,inSteadyWindow:state.inSteadyWindow}:undefined;};
 const startedWith=sample(),failures={busy:0,unavailable:0,alerts:0,http500:0,pageErrors:0};
 const response=(r:Response)=>{if(new URL(r.url()).origin===BASE&&r.status()>=500)failures.http500++;};
 const pageError=()=>{failures.pageErrors++;};
 const consoleError=(message:{type():string})=>{if(message.type()==='error')failures.pageErrors++;};
 page.on('response',response);page.on('pageerror',pageError);page.on('console',consoleError);
 try{
  await installFailureObserver(page);
  const cookies=await page.context().cookies(BASE);
  assert(cookies.some(cookie=>cookie.name==='__Host-aihr_internal'&&cookie.value&&cookie.secure&&cookie.httpOnly&&cookie.path==='/'),'Native authenticated fixture session missing');
  const origin=await page.goto(BASE+(scenario.outcome==='denied'?scenario.href:scenario.originHref),{waitUntil:'domcontentloaded',timeout:remaining()});
  assert(origin?.status()===200,'Navigation origin did not finish successfully');
  const originFailures=await capturedFailures(page);for(const key of ['busy','unavailable','alerts']as const)failures[key]+=originFailures[key];
  if(scenario.outcome==='usable'&&entry.kind==='shell-menu')await clickNativeShellDestination(page,scenario.href,remaining);
  if(scenario.outcome==='usable'&&entry.selector){
   const anchor=page.locator(entry.selector);
   await anchor.first().waitFor({state:'visible',timeout:remaining()});
   assert(await anchor.count()===1,'Canonical native destination link missing or ambiguous');
   assert(await anchor.getAttribute('href')===scenario.href,'Native destination address differs from reviewed scenario');
   assert(await anchor.isVisible()&&await anchor.isEnabled(),'Native destination is not actionable');
   await anchor.click({timeout:remaining()});
  }
  const target=new URL(scenario.outcome==='denied'?'/':scenario.href,BASE);
  await page.waitForURL(url=>url.origin===BASE&&url.pathname===target.pathname&&url.search===target.search,{timeout:remaining()});
  await page.locator('main').waitFor({state:'visible',timeout:remaining()});
  // Workforce content can contain many actors' names. Only the unique native
  // signed-in account trigger can bind the session to this exact fixture actor.
  const account=page.locator('button[data-tour="account"]');
  await account.first().waitFor({state:'visible',timeout:remaining()});
  assert(await account.count()===1&&await account.isEnabled({timeout:remaining()}),'Native signed-in account control missing or ambiguous');
  const signedInName=account.getByText(actor.name,{exact:true});
  await signedInName.first().waitFor({state:'visible',timeout:remaining()});
  assert(await signedInName.count()===1&&await signedInName.innerText({timeout:remaining()})===actor.name,'Native signed-in fixture identity differs');
  if(scenario.outcome==='denied')assert(await page.locator('main [data-navigation-destination="'+scenario.destinationId+'"]').count()===0,'Denied private destination remained rendered');
  for(const step of scenario.steps){
   const details=page.locator(step.selector);
   await details.first().waitFor({state:'visible',timeout:remaining()});
   assert(await details.count()===1,'Native disclosure missing or ambiguous');
   assert(await details.evaluate(element=>element.tagName==='DETAILS'),'Only native read disclosure steps are permitted');
   if(await details.getAttribute('open',{timeout:remaining()})===null){
    const summary=details.locator(':scope > summary');
    await summary.first().waitFor({state:'visible',timeout:remaining()});
    assert(await summary.count()===1&&await summary.isEnabled({timeout:remaining()}),'Native disclosure trigger missing, ambiguous or unavailable');
    await summary.click({timeout:remaining()});
   }
  }
  const checks:NavigationObservation['checks']=[];
  for(const check of scenario.checks){
   const matches=page.locator(check.selector);await matches.first().waitFor({state:'visible',timeout:remaining()});
   const visible=[];for(const match of await matches.all())if(await match.isVisible())visible.push(match);
   assert(visible.length>0,'Reviewed usable-content selector has no visible result');
   if(check.kind==='count'||check.kind==='fixture-roster-rows')assert(visible.length>=check.minimum&&(check.maximum===undefined||visible.length<=check.maximum),'Usable-content count differs');
   if(check.kind==='fixture-roster-rows'){
    const ids=new Set<string>();
    for(const row of visible){
     const id=await row.getAttribute('data-roster-employment-id',{timeout:remaining()});
     assert(id&&!ids.has(id)&&Object.hasOwn(bindings.rosterScope,id),'Roster rendered an unknown, duplicate or out-of-scope native fixture employment');ids.add(id);
     const expected=bindings.rosterScope[id];if(expected!==null)assert((await row.innerText({timeout:remaining()})).includes(expected),'Roster omitted the independently seeded employee identity');
    }
   }else if(check.kind==='enabled'){
    assert(await visible[0].evaluate(element=>element.tagName.toLowerCase())===check.tag&&await visible[0].isEnabled(),'Reviewed native control is unavailable');
   }else if(check.kind==='text-exact')assert((await visible[0].innerText({timeout:remaining()})).trim()===navigationExpectedText(check.expected,actorIndex,bindings),'Expected exact native fixture content differs');
   else if(check.kind==='text')assert((await visible[0].innerText({timeout:remaining()})).includes(navigationExpectedText(check.expected,actorIndex,bindings)),'Expected independent fixture content missing');
   else if(check.kind==='value')assert(await visible[0].inputValue({timeout:remaining()})===navigationExpectedText(check.expected,actorIndex,bindings),'Expected native control value differs');
   else if(check.kind==='attribute')assert(await visible[0].getAttribute(check.name)===check.expected,'Reviewed native control attribute differs');
   checks.push({id:check.id,passed:true,observedCount:visible.length});
  }
  const observed=await capturedFailures(page);for(const key of ['busy','unavailable','alerts']as const)failures[key]+=observed[key];
  assert(Object.values(failures).every(count=>count===0),'Navigation rendered failure state or browser/server error');
  const usableWith=sample();remaining();
  return {entry:entry.kind,scenarioId:scenario.id,destinationId:scenario.destinationId,role:actor.role,actorIndex,href:scenario.href,outcome:scenario.outcome,readiness:scenario.readiness,
   status:200,finalPath:target.pathname,internalSessionObserved:true,fixtureIdentityObserved:true,elapsedMs:performance.now()-started,checks,failures,
   ...(startedWith?{startedWith}:{}),...(usableWith?{usableWith}:{})};
 }finally{page.off('response',response);page.off('pageerror',pageError);page.off('console',consoleError);}
}
/** The runner retains both phases in the same fixed artifact member. No credentials/content. */
export function writeNavigationCaptureBundle(outputDirectory:string,baseline:NavigationCapture,loaded?:NavigationCapture){
 assert(baseline.phase==='baseline'&&baseline.complete&&(!loaded||loaded.phase==='loaded'&&loaded.complete),'Complete navigation phases required');
 if(loaded)for(const field of ['candidateSha','controllerSha','runId','runAttempt','harnessSha256','scenarioSha256']as const)assert(loaded[field]===baseline[field],'Navigation phases have different source/run identities');
 const bundle:NavigationCaptureBundle={schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,baseline,...(loaded?{loaded}:{})};
 writeFileSync(join(outputDirectory,NAVIGATION_CAPTURE_MEMBER),JSON.stringify(bundle,null,2)+'\n',{mode:0o600,flag:'wx'});
 return bundle;
}

const exactHome=BASE+'/';
const nativePrivateContent={
 'shell.payrollProcess':'main [data-tour="payroll-batches"],main [data-tour="payroll-create"]',
 'shell.analytics':'main [data-analytics-metric],main [data-analytics-value]',
} as const;

function createNativeHiddenShellCollector(source:NativeShellIdentity,deadline:number,legacy:()=>NavigationCapture|undefined){
 assert(Number.isFinite(deadline)&&deadline>performance.now(),'Owned native shell deadline required');
 assert(source.scenarioSha256===NATIVE_SHELL_LEGACY_SCENARIO_SHA256,'Exact legacy navigation scenario source required');
 const legacyPages=new Map<number,Page>(),started=new Set<number>();
 const retired=new Map<number,Awaited<ReturnType<typeof installNativePrimaryFailureObserver>>>();
 const observations=new Map<string,NativeHiddenShellObservation>();
 let sealed=false;
 return {
  bindLegacyRole(page:Page,actorIndex:number){
   if(NATIVE_HIDDEN_SHELL_CASES.some(row=>row.actorIndex===actorIndex)){
    assert(!legacyPages.has(actorIndex),'Native shell actor already bound');
    legacyPages.set(actorIndex,page);
   }
  },
  async captureActor(page:Page,actorIndex:number){
   assert(!sealed&&!started.has(actorIndex)&&legacyPages.get(actorIndex)===page,'Native shell requires the same completed legacy actor Page');
   const rows=NATIVE_HIDDEN_SHELL_CASES.filter(row=>row.actorIndex===actorIndex);
   assert(rows.length===2,'Native shell actor differs');
   assert(performance.now()<deadline,'Owned native shell deadline closed before observation');started.add(actorIndex);
   const observer=await installNativeDocumentFailureObserver(page,'hidden-shell');
   const {retirement}=observer;
   for(const [index,row]of rows.entries()){
    const began=performance.now(),limit=Math.min(deadline,began+90000);
    const remaining=()=>{const ms=Math.floor(limit-performance.now());assert(ms>0,'Native hidden shell deadline exceeded');return ms;};
    observations.set(row.id,await captureNativeHiddenShellScenario(page,row,retirement,remaining,began));
    if(index===rows.length-1){
     await retirement.finish(remaining);
     await observer.disposeHiddenShell();remaining();
     retired.set(actorIndex,retirement);
    }
   }
  },
  finish(){
   assert(!sealed,'Native shell baseline already sealed');sealed=true;
   const baseline=legacy();
   assert(baseline?.complete&&baseline.phase==='baseline'&&baseline.observations.length===48,'Exact complete legacy baseline required for native shell');
   assert(retired.size===2&&observations.size===4,'Native hidden shell document or observation census differs');
   let retiredDocuments=0;
   for(const retirement of retired.values()){
    retirement.requireSettled(4);retiredDocuments+=retirement.facts().retired;
   }
   assert(retiredDocuments===8&&performance.now()<deadline,'Native shell retirement census or terminal deadline differs');
   return validateNativeShellBaseline({schemaVersion:1,protocol:NATIVE_SHELL_BASELINE_VERSION,releaseAuthorized:false,
    ...source,runAttempt:1,legacyCases:48,nativeCases:52,retiredDocuments,extensionSha256:nativeHiddenShellCasesSha256(),complete:true,
    observations:NATIVE_HIDDEN_SHELL_CASES.map(row=>observations.get(row.id))},source);
  },
 };
}

async function captureNativeHiddenShellScenario(page:Page,row:NativeHiddenShellCase,retirement:Awaited<ReturnType<typeof installNativePrimaryFailureObserver>>,remaining:()=>number,began:number):Promise<NativeHiddenShellObservation>{
 const actor=fixtureNavigationActor(row.actorIndex),frame=page.mainFrame();
 assert(actor.role===row.role,'Native hidden shell actor differs');
 const cookies=await page.context().cookies(BASE);
 assert(cookies.some(cookie=>cookie.name==='__Host-aihr_internal'&&cookie.value&&cookie.secure&&cookie.httpOnly&&cookie.path==='/'),
  'Native hidden shell authenticated session missing');
 const nativeDocument=(response:Response,url:string,status:number)=>{
  const request=response.request();
  return response.status()===status&&response.url()===url&&!response.fromServiceWorker()&&request.url()===url&&
   request.method()==='GET'&&request.isNavigationRequest()&&request.resourceType()==='document'&&request.frame()===frame;
 };
 const verifyHome=async()=>{
  assert(page.url()===exactHome,'Native hidden shell Home address differs');
  await page.locator('main').waitFor({state:'visible',timeout:remaining()});
  const account=page.locator('button[data-tour="account"]');
  await account.first().waitFor({state:'visible',timeout:remaining()});
  assert(await account.count()===1&&await account.isEnabled({timeout:remaining()}),'Native hidden shell account control differs');
  const name=account.getByText(actor.name,{exact:true});
  await name.first().waitFor({state:'visible',timeout:remaining()});
  assert(await name.count()===1&&await name.innerText({timeout:remaining()})===actor.name,'Native hidden shell fixture identity differs');
  const destination='main [data-navigation-destination="'+row.destinationId+'"],main[data-navigation-destination="'+row.destinationId+'"]';
  assert(await page.locator(destination+','+nativePrivateContent[row.destinationId]).count()===0,'Native hidden shell private destination rendered');
  assert(page.url()===exactHome,'Native hidden shell Home changed during observation');
 };
 const requireCleanDocument=async()=>{
  const facts=await retirement.snapshot(remaining);
  assert(Object.values(facts).every(count=>count===0),'Native hidden shell rendered a DOM failure');
 };
 retirement.beforeNavigation();
 const origin=await page.goto(BASE+row.originHref,{waitUntil:'domcontentloaded',timeout:remaining()});
 assert(origin&&nativeDocument(origin,exactHome,200)&&!origin.request().redirectedFrom(),'Native hidden shell origin document differs');
 await verifyHome();await requireCleanDocument();
 await assertNativeShellDestinationHidden(page,row.href,remaining);
 assert(page.url()===exactHome,'Native hidden shell changed origin while traversing');
 retirement.beforeNavigation();
 const final=await page.goto(BASE+row.href,{waitUntil:'domcontentloaded',timeout:remaining()});
 assert(final&&nativeDocument(final,exactHome,200),'Native hidden shell direct denial did not finish at Home');
 const finalRequest=final.request(),prior=finalRequest.redirectedFrom();
 assert(prior&&!prior.redirectedFrom()&&prior.redirectedTo()===finalRequest&&prior.url()===BASE+row.href,'Native hidden shell direct denial redirect chain differs');
 const redirect=await prior.response(),location=redirect?.headers().location;
 assert(redirect&&redirect.request()===prior&&nativeDocument(redirect,BASE+row.href,307)&&(location==='/'||location===exactHome),'Native hidden shell HTTP 307 to Home required');
 await verifyHome();await requireCleanDocument();
 assert(page.url()===exactHome,'Native hidden shell Home changed before observation completed');remaining();
 return {id:row.id,destinationId:row.destinationId,role:row.role,actorIndex:row.actorIndex,entry:row.entry,shellVisibility:row.shellVisibility,
  originHref:row.originHref,href:row.href,outcome:row.outcome,originStatus:200,redirectStatus:307,finalStatus:200,finalHref:'/',
  internalSessionObserved:true,fixtureIdentityObserved:true,privateDestinationAbsent:true,elapsedMs:performance.now()-began};
}
