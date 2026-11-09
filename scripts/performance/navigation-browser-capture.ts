/** Actual browser producer. This captures development observations, never release authority.
 * The existing system runner owns native fixture provisioning/session creation and traffic.
 * Call once per role in each phase, with its already authenticated Playwright Page. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Page,Request,Response} from 'playwright';
import {fixtureNavigationActor,navigationExpectedText,NAVIGATION_CAPTURE_MEMBER,NAVIGATION_CAPTURE_VERSION,validateNavigationCapture,
 NATIVE_HIDDEN_SHELL_CASES,NATIVE_SHELL_BASELINE_VERSION,NATIVE_SHELL_LEGACY_SCENARIO_SHA256,nativeHiddenShellCasesSha256,validateNativeShellBaseline,
 type NavigationCapture,type NavigationCaptureBundle,type NavigationObservation,type NavigationScenario,type NavigationFixtureTextBindings,
 type NativeHiddenShellCase,type NativeHiddenShellObservation,type NativeShellIdentity,type NativeShellBaseline} from './navigation-protocol';
import {navigationCleanHead,navigationSourceIdentity} from './navigation-source';
import {readNavigationFixtureBindings} from './navigation-fixture-bindings';
import {navigationScenarioEntry} from './navigation-entry';
import {assertNativeShellDestinationHidden,clickNativeShellDestination} from './navigation-shell-browser';
import {DEVELOPMENT_RENDERED_CAPTURE_MAX_BYTES} from './driver-shutdown.mjs';
import {nativePreflightRoutePlan,requireNativeRenderedUnion} from './system-route-manifest.mjs';
const BASE='https://localhost:3443';
const failuresSelector={busy:'main[data-personnel-busy],main[data-page-busy],main [data-personnel-busy],main [data-page-busy]',
 unavailable:'main [data-read-unavailable],main [data-today-unavailable]',alerts:'main [role="alert"]'} as const;
type LoadState={active:number;inSteadyWindow:boolean};
const legacyFailures=new WeakMap<Error,Readonly<{scenarioId:string;checkId:string|null}>>();
export function legacyNavigationFailureFacts(error:unknown){
 return error instanceof Error?legacyFailures.get(error)??null:null;
}
const instrumented=new WeakSet<Page>();
async function installFailureObserver(page:Page){
 if(instrumented.has(page))return;instrumented.add(page);
 await page.addInitScript((selectors)=>{
  const counts={busy:0,unavailable:0,alerts:0};
  Object.defineProperty(window,'__aihrNavigationFailureCaptureV1',{value:counts});
  // Playwright serializes this callback. Method shorthand keeps tsx from
  // inserting a reference to its module-local function-name helper.
  const state={inspect(){for(const key of ['busy','unavailable','alerts']as const)counts[key]=Math.max(counts[key],document.querySelectorAll(selectors[key]).length);}};
  new MutationObserver(records=>{state.inspect();for(const record of records)for(const node of record.addedNodes)if(node instanceof Element){
   for(const key of ['busy','unavailable','alerts']as const)if(node.matches(selectors[key])||node.querySelector(selectors[key]))counts[key]++;
  }}).observe(document,{childList:true,subtree:true,attributes:true});state.inspect();
 },failuresSelector);
}
async function capturedFailures(page:Page){
 return page.evaluate(()=>{
  const counts=(window as unknown as {__aihrNavigationFailureCaptureV1?:{busy:number;unavailable:number;alerts:number}}).__aihrNavigationFailureCaptureV1;
  if(!counts)throw Error('Native failure-state observer missing');return {...counts};
 });
}

const nativePrimaryProperty='__aihrNativePrimaryFailureCaptureV1';
const nativePrimaryPages=new WeakSet<Page>();
const nativeHiddenShellPages=new WeakSet<Page>();
const nativeMarkerAttributes={'data-personnel-busy':'busy','data-page-busy':'busy',
 'data-read-unavailable':'unavailable','data-today-unavailable':'unavailable',role:'alerts'}as const;

/** Legacy denials may start a streamed document and redirect while it is still
 * being parsed. Seal its evidence synchronously on pagehide, then read once
 * from Home and compare against the independently observed document responses. */
async function installLegacyDenialObserver(page:Page,deniedPath:string){
 const key='__aihrLegacyDenial:'+randomUUID(),frame=page.mainFrame(),documents:string[]=[];
 let invalidResponse=false;
 const observeResponse=(response:Response)=>{
  const request=response.request();
  if(!request.isNavigationRequest()||request.resourceType()!=='document')return;
  try{
   if(request.frame()!==frame)return;
   const url=new URL(response.url()),path=url.pathname+url.search,status=response.status();
   if(url.origin!==BASE||request.method()!=='GET'||response.fromServiceWorker()){invalidResponse=true;return;}
   if(status>=300&&status<400)return;
   if(status!==200||documents.length===2||(path!==deniedPath&&path!=='/')){invalidResponse=true;return;}
   documents.push(path);
  }catch{invalidResponse=true;}
 };
 const script=await page.addInitScript(({ingress,key,selectors,markers,attributes})=>{
  if(window.top!==window||location.origin!==ingress)return;
  const prior=sessionStorage.getItem(key);
  const ledger=prior===null?{documents:[] as string[],retired:0,busy:0,unavailable:0,alerts:0}:
   JSON.parse(prior) as {documents:string[];retired:number;busy:number;unavailable:number;alerts:number};
  if(ledger.retired!==ledger.documents.length||ledger.documents.length>=2)return;
  ledger.documents.push(location.pathname+location.search);
  sessionStorage.setItem(key,JSON.stringify(ledger));
  const counts={busy:0,unavailable:0,alerts:0},kinds=['busy','unavailable','alerts'] as const;
  const state={
   observe(records:MutationRecord[]){
    for(const kind of kinds)if(document.querySelector(selectors[kind]))counts[kind]=1;
    for(const record of records){
     if(record.type==='attributes'&&record.target instanceof Element&&record.target.closest('main')){
      const name=record.attributeName as keyof typeof attributes;
      if(Object.hasOwn(attributes,name)&&(name==='role'?record.oldValue==='alert':record.oldValue!==null))counts[attributes[name]]=1;
     }
     const insideMain=record.target instanceof Element&&record.target.closest('main');
     for(const nodes of [record.addedNodes,record.removedNodes])for(const node of nodes)if(node instanceof Element){
      for(const kind of kinds){
       const selector=insideMain?markers[kind]:selectors[kind];
       if(node.matches(selector)||node.querySelector(selector))counts[kind]=1;
      }
     }
    }
   },
   snapshot(){
    state.observe(observer.takeRecords());
    return {...ledger,href:location.href,busy:ledger.busy+counts.busy,unavailable:ledger.unavailable+counts.unavailable,alerts:ledger.alerts+counts.alerts};
   },
  };
  const observer=new MutationObserver(state.observe);
  observer.observe(document,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:Object.keys(attributes)});
  Object.defineProperty(window,key,{value:state.snapshot});
  window.addEventListener('pagehide',event=>{
   if(!event.isTrusted||event.persisted)return;
   const {href:_,...sealed}=state.snapshot();
   sealed.retired++;sessionStorage.setItem(key,JSON.stringify(sealed));observer.disconnect();
  },{once:true});
 },{ingress:BASE,key,selectors:{...failuresSelector,unavailable:failuresSelector.unavailable+',main[data-read-unavailable],main[data-today-unavailable]',
  alerts:failuresSelector.alerts+',main[role="alert"]'},markers:{busy:'[data-personnel-busy],[data-page-busy]',
  unavailable:'[data-read-unavailable],[data-today-unavailable]',alerts:'[role="alert"]'},attributes:nativeMarkerAttributes});
 page.on('response',observeResponse);
 return {
  async snapshot(){
   const read=await page.evaluate(key=>{
    const snapshot=(window as unknown as Record<string,(()=>{documents:string[];retired:number;href:string;busy:number;unavailable:number;alerts:number})|undefined>)[key];
    if(!snapshot)throw Error('Native legacy denial observer missing');return snapshot();
   },key);
   assert(!invalidResponse&&frame===page.mainFrame()&&page.url()===BASE+'/'&&read.href===BASE+'/'
    &&documents.length>0&&documents.length<=2&&read.retired===documents.length-1,
    'Native legacy denial document census differs');
   assert.deepEqual(read.documents,documents,'Native legacy denial lost a document observation');
   if(documents.length===2)assert(documents[0]===deniedPath&&documents[1]==='/','Native legacy denial redirect document order differs');
   for(const value of [read.busy,read.unavailable,read.alerts])assert(Number.isSafeInteger(value)&&value>=0&&value<=documents.length,'Native legacy denial marker census differs');
   return {busy:read.busy,unavailable:read.unavailable,alerts:read.alerts};
  },
  async dispose(){page.off('response',observeResponse);await script.dispose();},
 };
}

const nativeDocumentId=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type NativeDocumentSnapshot={id:string;origin:string;busy:number;unavailable:number;alerts:number};
type NativeRetirementReceipt={id:string;key:string;mask:number;terminal:boolean};

/** One already-owned primary Page. Retirement receipts belong to documents
 * that the driver has independently observed on that Page. */
export async function installNativePrimaryFailureObserver(page:Page,actorIndex?:number){
 const capacity=actorIndex===undefined?72:nativePreflightRoutePlan().filter(row=>row.actorIndex===actorIndex).length;
 assert(capacity>0,'Unknown primary route retirement actor');
 return (await installNativeDocumentFailureObserver(page,'primary',capacity)).retirement;
}

async function installNativeDocumentFailureObserver(page:Page,scope:'primary'|'hidden-shell',capacity:number){
 const primary=scope==='primary',pages=primary?nativePrimaryPages:nativeHiddenShellPages;
 assert(!pages.has(page),'Native document retirement observer already installed');pages.add(page);
 const property=primary?nativePrimaryProperty:'__aihrNativeHiddenShellFailureCaptureV1';
 const frame=page.mainFrame(),key='__aihrNativeRetirement:'+randomUUID(),seen=new Set<string>();
 const markerDocuments={busy:0,unavailable:0,alerts:0};
 let active:string|undefined,retiring:string|undefined,awaitingSnapshot=false,finalBlank=false,retired=0,refusals=0;
 function consumeRetirement(raw:unknown){
  if(!retiring&&raw===null)return;
  let payload:Partial<NativeRetirementReceipt>|null=null;
  if(typeof raw==='string'&&raw.length<=256){
   try{
    const value:unknown=JSON.parse(raw);
    if(value&&typeof value==='object'&&!Array.isArray(value))payload=value as Partial<NativeRetirementReceipt>;
   }catch{}
  }
  if(!retiring||!payload||Object.keys(payload).sort().join(',')!=='id,key,mask,terminal'||payload.key!==key
   ||payload.id!==retiring||payload.terminal!==true
   ||typeof payload.mask!=='number'||!Number.isSafeInteger(payload.mask)||payload.mask<0||payload.mask>7){
   refusals++;throw Error(raw===null?'Native document retirement receipt missing':'Native document retirement refused');
  }
  if(payload.mask&1)markerDocuments.busy++;
  if(payload.mask&2)markerDocuments.unavailable++;
  if(payload.mask&4)markerDocuments.alerts++;
  retiring=undefined;retired++;
 }
 const selectors={...failuresSelector,unavailable:failuresSelector.unavailable+',main[data-read-unavailable],main[data-today-unavailable]',
  alerts:failuresSelector.alerts+',main[role="alert"]'};
 const script=await page.addInitScript(({selectors,property,attributes,ingress,key})=>{
  if(window.top!==window||location.origin!==ingress)return;
  const id=crypto.randomUUID(),counts={busy:0,unavailable:0,alerts:0};
  const kinds=['busy','unavailable','alerts']as const;
  // Keep this serialized browser callback independent of tsx's Node scope.
  const state={
   inspect(){for(const kind of kinds)counts[kind]=Math.max(counts[kind],document.querySelectorAll(selectors[kind]).length);},
   observe(records:MutationRecord[]){
    state.inspect();
    for(const record of records){
     if(record.type==='attributes'&&record.target instanceof Element&&record.target.closest('main')){
      const name=record.attributeName as keyof typeof attributes;
      if(Object.hasOwn(attributes,name)&&(name==='role'?record.oldValue==='alert':record.oldValue!==null))counts[attributes[name]]++;
     }
     for(const node of record.addedNodes)if(node instanceof Element){
      for(const kind of kinds)if(node.matches(selectors[kind])||node.querySelector(selectors[kind]))counts[kind]++;
     }
    }
   },
   snapshot(){state.observe(observer.takeRecords());return{id,origin:location.origin,...counts};},
  };
  const observer=new MutationObserver(state.observe);
  observer.observe(document,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:Object.keys(attributes)});
  Object.defineProperty(window,property,{value:state.snapshot});
  window.addEventListener('pagehide',event=>{
   const final=state.snapshot();observer.disconnect();
   const mask=Number(final.busy>0)+2*Number(final.unavailable>0)+4*Number(final.alerts>0);
   // A browser binding can lose the old context as it retires. Seal inside the
   // tab before unloading, and refuse an unconsumed seal instead of replacing it.
   const receipt={id,key,mask,terminal:event.isTrusted&&!event.persisted};
   sessionStorage.setItem(key,sessionStorage.getItem(key)===null?JSON.stringify(receipt):'');
  },{once:true});
  state.inspect();
 },{selectors,property,attributes:nativeMarkerAttributes,ingress:BASE,key});

 const beginRetirement=()=>{
  assert(!retiring&&!awaitingSnapshot&&!finalBlank,'Native document transition already open');
  retiring=active;active=undefined;
 };
 const retirement={
  beforeNavigation(){beginRetirement();awaitingSnapshot=true;},
  async snapshot(remaining:()=>number){
   assert(awaitingSnapshot,'Native document snapshot without owned navigation');
   const {read,receipt}=await page.evaluate(({property,key})=>{
    const snapshot=(window as unknown as Record<string,(()=>NativeDocumentSnapshot)|undefined>)[property];
    if(!snapshot)throw Error('Native primary failure-state observer missing');
    const read=snapshot(),receipt=sessionStorage.getItem(key);
    if(receipt!==null)sessionStorage.removeItem(key);
    return {read,receipt};
   },{property,key});
   remaining();
   assert(read&&Object.keys(read).sort().join(',')==='alerts,busy,id,origin,unavailable'
    &&frame===page.mainFrame()&&new URL(frame.url()).origin===BASE&&read.origin===BASE
    &&typeof read.id==='string'&&nativeDocumentId.test(read.id)&&!seen.has(read.id)&&seen.size<capacity,'Native document snapshot identity differs');
   for(const count of [read.busy,read.unavailable,read.alerts])assert(Number.isSafeInteger(count)&&count>=0,'Native DOM failure count invalid');
   consumeRetirement(receipt);
   seen.add(read.id);active=read.id;awaitingSnapshot=false;
   return{busy:read.busy,unavailable:read.unavailable,alerts:read.alerts};
  },
  async finish(remaining:()=>number){
   const expected=active;
   assert(expected,'Missing last native primary document');
   beginRetirement();
   let requestedDocument=false;
   const request=(value:Request)=>{
    if(value.isNavigationRequest()&&value.resourceType()==='document'){
     try{requestedDocument ||= value.frame()===frame;}catch{requestedDocument=true;}
    }
   };
   page.on('request',request);
   try{
    await Promise.all([page.waitForURL('about:blank',{waitUntil:'domcontentloaded',timeout:remaining()}),page.evaluate(({property,expected,ingress})=>{
     const snapshot=(window as unknown as Record<string,(()=>NativeDocumentSnapshot)|undefined>)[property];
     if(location.origin!==ingress||snapshot?.().id!==expected)throw Error('Native terminal retirement document differs');
     // The retiring document initiates blank, which inherits its effective origin
     // and can read the same tab's seal without an application or network request.
     setTimeout(()=>location.replace('about:blank'),0);
    },{property,expected,ingress:BASE})]);
    const receipt=await page.evaluate(({property,key,ingress})=>{
     if(location.href!=='about:blank'||window.origin!==ingress||window.top!==window
      ||Object.hasOwn(window,property)||document.body?.childNodes.length!==0)throw Error('Native terminal retirement blank differs');
     const receipt=sessionStorage.getItem(key);
     if(receipt!==null)sessionStorage.removeItem(key);
     return receipt;
    },{property,key,ingress:BASE});
    remaining();
    assert(!requestedDocument&&frame===page.mainFrame()&&page.url()==='about:blank','Native primary inert retirement navigation differs');
    consumeRetirement(receipt);finalBlank=true;
   }finally{page.off('request',request);}
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
  // scope before the same Page begins the independent primary route observer.
  await script.dispose();
 }};
}

const browserFailureCounts=()=>({aborted:0,transport:0,http5xx:0,pageError:0,consoleError:0,crash:0});
/** Browser events on already-owned Pages. Observations confer no admission. */
export function createNativeBrowserFailureObservation(){
 const pages=new WeakMap<Page,ReturnType<typeof browserFailureCounts>>(),total=browserFailureCounts();
 const pageFacts=(page:Page)=>{const counts=pages.get(page);assert(counts,'Unobserved native browser Page');return {...counts};};
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
  pageFacts,
  pageCount(page:Page,{includeAborted=true}={}){
   const counts=pageFacts(page);
   return Object.values(counts).reduce((sum,count)=>sum+count,0)-(includeAborted?0:counts.aborted);
  },
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

async function openNativePersonnelFilter(page:Page,remaining:()=>number){
 const trigger=page.locator('main button[data-tour="people-search"]');
 await trigger.first().waitFor({state:'visible',timeout:remaining()});
 assert(await trigger.count()===1&&await trigger.isEnabled({timeout:remaining()})
  &&await trigger.getAttribute('aria-expanded',{timeout:remaining()})==='false','Native Personnel filter trigger differs');
 const controls=await trigger.getAttribute('aria-controls',{timeout:remaining()});
 assert(controls&&/^[A-Za-z0-9_:-]{1,128}$/.test(controls),'Native Personnel filter has no reviewed dialog identity');
 await trigger.click({timeout:remaining()});
 const dialog=page.locator('[role="dialog"][id='+JSON.stringify(controls)+']');
 await dialog.first().waitFor({state:'visible',timeout:remaining()});
 assert(await dialog.count()===1&&await trigger.getAttribute('aria-expanded',{timeout:remaining()})==='true',
  'Native Personnel filter did not open its owned dialog');
 return dialog;
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
 let denial:Awaited<ReturnType<typeof installLegacyDenialObserver>>|undefined;
 let checkId:string|null=null;
 try{
  if(scenario.outcome==='denied')denial=await installLegacyDenialObserver(page,scenario.href);
  else await installFailureObserver(page);
  const cookies=await page.context().cookies(BASE);
  assert(cookies.some(cookie=>cookie.name==='__Host-aihr_internal'&&cookie.value&&cookie.secure&&cookie.httpOnly&&cookie.path==='/'),'Native authenticated fixture session missing');
  const origin=await page.goto(BASE+(scenario.outcome==='denied'?scenario.href:scenario.originHref),{waitUntil:'domcontentloaded',timeout:remaining()});
  assert(origin?.status()===200,'Navigation origin did not finish successfully');
  if(!denial){
   const originFailures=await capturedFailures(page);
   for(const key of ['busy','unavailable','alerts']as const)failures[key]+=originFailures[key];
  }
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
   checkId=check.id;
   // Personnel's editable term is in the actual portaled filter, not the hidden
   // retained term under the table form. The preceding table witness is read first.
   const scope=check.kind==='personnel-private-search'?await openNativePersonnelFilter(page,remaining):page;
   const matches=scope.locator(check.selector),visibleMatches=matches.filter({visible:true});
   await visibleMatches.first().waitFor({state:'visible',timeout:remaining()});
   const visible=await visibleMatches.all();
   assert(visible.length>0,'Reviewed usable-content selector has no visible result');
   if(check.kind==='personnel-private-search')assert(await matches.count()===1&&visible.length===1
    &&await visible[0].isEditable({timeout:remaining()}),'Native Personnel private search is ambiguous or read-only');
   if(check.kind==='roster-month')assert(await matches.count()===1&&visible.length===1
    &&await visible[0].isEditable({timeout:remaining()}),'Native Roster month control is ambiguous or read-only');
   if(check.kind==='count'||check.kind==='fixture-roster-rows')assert(visible.length>=check.minimum&&(check.maximum===undefined||visible.length<=check.maximum),'Usable-content count differs');
   if(check.kind==='fixture-roster-rows'){
    const ids=new Set<string>();
    for(const row of visible){
     const id=await row.getAttribute('data-roster-employment-id',{timeout:remaining()});
     assert(id&&!ids.has(id)&&Object.hasOwn(bindings.rosterScope,id),'Roster rendered an unknown, duplicate or out-of-scope native fixture employment');ids.add(id);
     const expected=bindings.rosterScope[id];if(expected!==null)assert((await row.innerText({timeout:remaining()})).includes(expected),'Roster omitted the independently seeded employee identity');
    }
   }else if(check.kind==='enabled'||check.kind==='personnel-private-search'){
    assert(await visible[0].evaluate(element=>element.tagName.toLowerCase())===check.tag&&await visible[0].isEnabled(),'Reviewed native control is unavailable');
   }else if(check.kind==='text-exact')assert((await visible[0].innerText({timeout:remaining()})).trim()===navigationExpectedText(check.expected,actorIndex,bindings),'Expected exact native fixture content differs');
   else if(check.kind==='text')assert((await visible[0].innerText({timeout:remaining()})).includes(navigationExpectedText(check.expected,actorIndex,bindings)),'Expected independent fixture content missing');
   else if(check.kind==='value'||check.kind==='roster-month')assert(await visible[0].inputValue({timeout:remaining()})===navigationExpectedText(check.expected,actorIndex,bindings),'Expected native control value differs');
   else if(check.kind==='attribute')assert(await visible[0].getAttribute(check.name)===check.expected,'Reviewed native control attribute differs');
   checks.push({id:check.id,passed:true,observedCount:visible.length});
  }
  checkId=null;
  const observed=denial?await denial.snapshot():await capturedFailures(page);
  for(const key of ['busy','unavailable','alerts']as const)failures[key]+=observed[key];
  assert(Object.values(failures).every(count=>count===0),'Navigation rendered failure state or browser/server error');
  const usableWith=sample();remaining();
  return {entry:entry.kind,scenarioId:scenario.id,destinationId:scenario.destinationId,role:actor.role,actorIndex,href:scenario.href,outcome:scenario.outcome,readiness:scenario.readiness,
   status:200,finalPath:target.pathname,internalSessionObserved:true,fixtureIdentityObserved:true,elapsedMs:performance.now()-started,checks,failures,
   ...(startedWith?{startedWith}:{}),...(usableWith?{usableWith}:{})};
 }catch(error){
  if(error instanceof Error)legacyFailures.set(error,Object.freeze({scenarioId:scenario.id,checkId}));
  throw error;
 }finally{
  page.off('response',response);page.off('pageerror',pageError);page.off('console',consoleError);
  await denial?.dispose();
 }
}
/** The runner retains both phases in the same fixed artifact member. No credentials/content. */
export function writeNavigationCaptureBundle(outputDirectory:string,baseline:NavigationCapture,loaded?:NavigationCapture):NavigationCaptureBundle;
export function writeNavigationCaptureBundle(outputDirectory:string,baseline:NavigationCapture,loaded:NavigationCapture|undefined,
 bind:'development-byte-binding'):Readonly<{sha256:string;bytes:number}>;
export function writeNavigationCaptureBundle(outputDirectory:string,baseline:NavigationCapture,loaded?:NavigationCapture,bind?:'development-byte-binding'){
 assert(baseline.phase==='baseline'&&baseline.complete&&(!loaded||loaded.phase==='loaded'&&loaded.complete),'Complete navigation phases required');
 if(loaded)for(const field of ['candidateSha','controllerSha','runId','runAttempt','harnessSha256','scenarioSha256']as const)assert(loaded[field]===baseline[field],'Navigation phases have different source/run identities');
 const bundle:NavigationCaptureBundle={schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,baseline,...(loaded?{loaded}:{})};
 const serialized=JSON.stringify(bundle,null,2)+'\n';
 const path=join(outputDirectory,NAVIGATION_CAPTURE_MEMBER);
 if(bind==='development-byte-binding'){
  const bytes=Buffer.byteLength(serialized,'utf8');
  assert(bytes>0&&bytes<=DEVELOPMENT_RENDERED_CAPTURE_MAX_BYTES,'Development rendered capture byte bound refused');
  const raw=Buffer.from(serialized,'utf8');
  const sha256=createHash('sha256').update(raw).digest('hex');
  writeFileSync(path,raw,{mode:0o600,flag:'wx'});
  return Object.freeze({sha256,bytes});
 }
 writeFileSync(path,serialized,{mode:0o600,flag:'wx'});
 return bundle;
}

type RenderedRouteObservation=ReturnType<typeof nativePreflightRoutePlan>[number]&{
 status:number;accountObserved:boolean;elapsedMs:number;failureCount:number;readiness:string;
};
type RetirementFacts=ReturnType<Awaited<ReturnType<typeof installNativePrimaryFailureObserver>>['facts']>;
type PrimaryRetirement=RetirementFacts&{actorIndex:number;pageFailures:number};
type LifecycleStaffTile={phase:string;role:string;open:number;pending:number};
export const DEVELOPMENT_RENDERED_UNION_MEMBER='development-rendered-route-union.json';

/** One separately sealed development-only projection after the owning browser settles. */
export function writeDevelopmentRenderedRouteUnion(outputDirectory:string,baseline:NavigationCapture,
 rows:readonly RenderedRouteObservation[],hidden:NativeShellBaseline,primary:readonly PrimaryRetirement[],
 lifecycle:readonly LifecycleStaffTile[]){
 assert(baseline.schemaVersion===1&&baseline.protocol===NAVIGATION_CAPTURE_VERSION&&baseline.releaseAuthorized===false
  &&baseline.runAttempt===1&&baseline.complete&&baseline.phase==='baseline'&&baseline.observations.length===48,
  'Complete legacy development baseline required');
 const {candidateSha,controllerSha,runId,runAttempt,harnessSha256,scenarioSha256}=baseline;
 assert(candidateSha===controllerSha,'Full development browser requires exact self-source');
 validateNativeShellBaseline(hidden,{candidateSha,controllerSha,runId,harnessSha256,scenarioSha256});
 const plan=nativePreflightRoutePlan(),counts=requireNativeRenderedUnion(rows);
 assert.deepEqual(counts,{total:191,usable:17,scopedDenials:1,renderedOnly:173});
 const urls=new Set(plan.map(row=>row.requested)).size;
 assert.equal(urls,93,'Full development requested address census differs');
 const ordered=plan.map(expected=>rows.find(row=>row.actorIndex===expected.actorIndex&&row.requested===expected.requested)!);
 assert(ordered.every(Boolean),'Full development role route evidence missing');

 const actors=[0,1,2,4];
 assert.deepEqual(primary.map(row=>row.actorIndex).sort((a,b)=>a-b),actors,'Full development primary retirement actors differ');
 const retirement=actors.map(actorIndex=>{
  const row=primary.find(value=>value.actorIndex===actorIndex)!;
  const expected=plan.filter(value=>value.actorIndex===actorIndex).length;
  assert(row.admitted===expected&&row.retired===expected&&row.refusals===0&&row.finalBlank===true&&row.pageFailures===0,
   'Full development primary retirement or Page settlement differs');
  assert.deepEqual(row.markerDocuments,{busy:0,unavailable:0,alerts:0},'Full development late document failure observed');
  return {actorIndex,admitted:row.admitted,retired:row.retired,pageFailures:0,refusals:0,finalBlank:true,
   markerDocuments:{busy:0,unavailable:0,alerts:0}};
 });
 const tiles=[...lifecycle].sort((a,b)=>a.role.localeCompare(b.role));
 assert.deepEqual(tiles,[{phase:'baseline',role:'companyHR',open:1,pending:1},{phase:'baseline',role:'groupHR',open:2,pending:1}],
  'Full development Lifecycle scope evidence differs');

 const raw=Buffer.from(JSON.stringify({
  kind:'DEVELOPMENT_RENDERED_ROUTE_UNION_V1',complete:true,releaseEligible:false,protectedNative:false,dynamicNavigationComplete:false,
  candidateSha,controllerSha,runId,runAttempt,harnessSha256,scenarioSha256,
  counts:{...counts,urls},observations:ordered,primaryRetirement:retirement,lifecycleStaffTiles:tiles,
  hiddenShell:{count:hidden.observations.length,retiredDocuments:hidden.retiredDocuments,
   extensionSha256:hidden.extensionSha256,observations:hidden.observations},
 },null,2)+'\n','utf8');
 assert(raw.length>0&&raw.length<=DEVELOPMENT_RENDERED_CAPTURE_MAX_BYTES,'Full development route capture bound refused');
 const sha256=createHash('sha256').update(raw).digest('hex');
 writeFileSync(join(outputDirectory,DEVELOPMENT_RENDERED_UNION_MEMBER),raw,{mode:0o600,flag:'wx'});
 return Object.freeze({sha256,bytes:raw.length});
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
   const observer=await installNativeDocumentFailureObserver(page,'hidden-shell',4);
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
