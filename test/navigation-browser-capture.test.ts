/** Collector behavior contracts with a mocked page/source, never executed app coverage. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {transformSync} from 'esbuild';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Page} from 'playwright';
const source=vi.hoisted(()=>({sha:'a'.repeat(40),controller:'b'.repeat(40),scenarioSha256:'d'.repeat(64),legacyDenied:false}));
vi.mock('../scripts/performance/navigation-source',()=>({
 navigationCleanHead:()=>source.sha,
 navigationSourceIdentity:()=>({harnessSha256:'c'.repeat(64),scenarioSha256:source.scenarioSha256,plan:{schemaVersion:1,fixture:'system-load-v1',engine:'chromium',scope:'Unit collector contract only',scenarios:[{
  id:'unit.employee',destinationId:'submenu.unit',role:'employee',href:'/unit',originHref:'/unit',outcome:source.legacyDenied?'denied':'usable',readiness:'controls',
  steps:source.legacyDenied?[]:[{kind:'open-details',selector:'main details:has(input[name="unit"])'}],
  checks:source.legacyDenied?[]:[{id:'input',kind:'enabled',tag:'input',selector:'main input[name="unit"]'}],
 }]}}),
}));
vi.mock('../scripts/performance/navigation-fixture-bindings',()=>({readNavigationFixtureBindings:()=>new Map([[4,{actorName:'PERF Person 0004',actorEmployeeCode:'PERF0004',firstCompanyPersonName:'PERF Person 0000',activeHeadcount:'50',historicalPayrollMonth:'2026-07',seedToday:'2026-11-07',seedMonth:'2026-11',rosterScope:{}}]])}));
import {createNavigationCaptureCollector,installNativePrimaryFailureObserver,createNativeBrowserFailureObservation,writeNavigationCaptureBundle,
 DEVELOPMENT_RENDERED_UNION_MEMBER,writeDevelopmentRenderedRouteUnion} from '../scripts/performance/navigation-browser-capture';
import {nativePreflightReadiness,nativePreflightRoutePlan} from '../scripts/performance/system-route-manifest.mjs';
import {NAVIGATION_CAPTURE_MEMBER,NATIVE_HIDDEN_SHELL_CASES,NATIVE_SHELL_BASELINE_VERSION,NATIVE_SHELL_LEGACY_SCENARIO_SHA256,nativeHiddenShellCasesSha256,
 validateNativeShellBaseline,type NativeShellBaseline} from '../scripts/performance/navigation-protocol';

function developmentPageCensusModel(){
 const source=readFileSync(new URL('../scripts/performance/system-load-owner.mjs',import.meta.url),'utf8');
 const start=source.indexOf('function createDevelopmentPageCensus(){');
 const end=source.indexOf('export async function runDevelopmentSystemLoad()',start);
 assert(start>=0&&end>start);
 const census=runInNewContext(source.slice(start,end)+'\ncreateDevelopmentPageCensus()',{
  assert,createNativeBrowserFailureObservation,
 });
 const live=new Set<EventEmitter>(),stages:string[]=[];
 const context=Object.assign(new EventEmitter(),{pages:()=>[...live]});
 census.attach(context);
 return {
  stages,pageCount:census.pageCount,pageFacts:census.pageFacts,
  open(notify=true){
   let closed=false;
   const page=Object.assign(new EventEmitter(),{context:()=>context,isClosed:()=>closed});
   live.add(page);
   if(notify)context.emit('page',page);
   return {page,close(notify=true){closed=true;live.delete(page);if(notify)context.emit('pageclose',page);}};
  },
  finish({strict=true,acquired=1,settled=1,disconnected=false}={}){
   return census.finish({browserClosed:true,browser:{unexpectedDisconnect:disconnected},
    contexts:{acquired,attempted:acquired,settled,failed:0}},strict,(stage:string)=>stages.push(stage));
  },
 };
}

it('records the owned development Page crash and distinguishes ordinary aborts through settlement',()=>{
 for(const [crashed,strict] of [[false,true],[true,true],[true,false]]){
  const model=developmentPageCensusModel(),first=model.open(),last=model.open();
  first.page.emit('requestfailed',{url:()=> 'https://localhost:3443/asset',failure:()=>({errorText:'net::ERR_ABORTED'})});
  expect(model.pageCount(first.page)).toBe(0);
  expect(model.pageFacts(first.page)).toMatchObject({aborted:1,transport:0});
  first.close();
  if(crashed)last.page.emit('crash');
  last.close();
  expect(model.finish({strict})).toMatchObject({censusComplete:true,observedPages:2,closedPages:2,aborted:1,crash:Number(crashed)});
  expect(model.stages).toEqual(crashed&&strict?['development-page-crash']:[]);
 }
});

it('keeps development transport, response and browser failures in the rendered route count',()=>{
 const model=developmentPageCensusModel(),{page}=model.open();
 const url=()=> 'https://localhost:3443/asset';
 page.emit('requestfailed',{url,failure:()=>({errorText:'net::ERR_ABORTED'})});
 page.emit('requestfailed',{url,failure:()=>({errorText:'net::ERR_CONNECTION_RESET'})});
 page.emit('response',{url,status:()=>500});
 page.emit('pageerror',new Error('fixture page error'));
 page.emit('console',{type:()=> 'error'});
 page.emit('crash');
 expect(model.pageCount(page)).toBe(5);
 expect(model.pageFacts(page)).toEqual({aborted:1,transport:1,http5xx:1,pageError:1,consoleError:1,crash:1});
});

it('refuses missing Page or context census even with zero observed crashes',()=>{
 for(const variant of ['empty','unobserved-page','missing-close','unwatched-context','context-unsettled','disconnected']){
  const model=developmentPageCensusModel();
  if(variant==='unobserved-page')model.open().close();
  if(variant!=='empty')model.open(variant!=='unobserved-page').close(variant!=='missing-close');
  expect(model.finish({acquired:variant==='unwatched-context'?2:1,settled:variant==='context-unsettled'?0:1,
   disconnected:variant==='disconnected'})).toMatchObject({censusComplete:false,crash:0});
  expect(model.stages).toEqual(['development-page-census']);
 }
});

const actorName='PERF Person 0004',otherActorName='PERF Person 0005';
function fictionalPage({accountName=actorName,accountCount=1,anchorCount=1,detailsCount=1}:{accountName?:string;accountCount?:number;anchorCount?:number;detailsCount?:number}={}){
 let now=0;const waited=new Set<string>(),waits:{selector:string;timeout:number}[]=[],operations:string[]=[];
 vi.spyOn(performance,'now').mockImplementation(()=>now);
 const locator=(selector:string,count=1,options:{tag?:string;text?:string;href?:string;requiresWait?:boolean}={}):any=>({
  first(){return this;},
  async waitFor({state,timeout}:{state:string;timeout:number}){
   expect(state).toBe('visible');expect(timeout).toBeGreaterThan(0);expect(timeout).toBeLessThanOrEqual(90000-now);
   waits.push({selector,timeout});now+=250;
   if(count===0)throw Error('Mocked visible locator deadline: '+selector);
   waited.add(selector);operations.push('visible:'+selector);
  },
  async count(){if(options.requiresWait)expect(waited.has(selector)).toBe(true);operations.push('count:'+selector);return count;},
  async isVisible(){return count>0;},async isEnabled(){return count>0;},async click(){operations.push('click:'+selector);},
  async getAttribute(name:string){return name==='href'?options.href:null;},
  async evaluate(fn:(element:any)=>unknown){return fn({tagName:options.tag??'INPUT'});},
  async innerText(){return options.text??'';},
  async all(){return [this];},
  locator(child:string){expect(selector).toBe('main details:has(input[name="unit"])');expect(child).toBe(':scope > summary');return locator(selector+' > summary',1,{tag:'SUMMARY',requiresWait:true});},
  getByText(expected:string,{exact}:{exact:boolean}){
   expect(selector).toBe('button[data-tour="account"]');expect(exact).toBe(true);
   return locator(selector+' exact identity',accountName===expected?1:0,{text:accountName,requiresWait:true});
  },
 });
 const body=locator('body',1,{text:actorName+' '+otherActorName+' workforce directory'});
 const page={
  on:vi.fn(),off:vi.fn(),addInitScript:vi.fn(),
  context:()=>({cookies:async()=>[{name:'__Host-aihr_internal',value:'fictional-private-cookie',secure:true,httpOnly:true,path:'/'}]}),
  async goto(){now+=1000;return {status:()=>200};},
  async waitForURL(predicate:(url:URL)=>boolean){expect(predicate(new URL('https://localhost:3443/unit'))).toBe(true);},
  async evaluate(){return {busy:0,unavailable:0,alerts:0};},
  locator(selector:string){
   if(selector==='body')return body;
   if(selector==='button[data-tour="account"]')return locator(selector,accountCount,{requiresWait:true});
   if(selector==='a[data-navigation-destination="submenu.unit"]')return locator(selector,anchorCount,{tag:'A',href:'/unit',requiresWait:true});
   if(selector==='main details:has(input[name="unit"])')return locator(selector,detailsCount,{tag:'DETAILS',requiresWait:true});
   if(selector==='main'||selector==='main input[name="unit"]')return locator(selector,1,{tag:'INPUT'});
   throw Error('Unreviewed mocked page selector: '+selector);
  },
 } as unknown as Page;
 return {page,body,waits,operations};
}
const ingress='https://localhost:3443';
const firstDocument='12345678-1234-4234-8234-123456789abc',secondDocument='12345678-1234-4234-9234-123456789abc';
function retirementPage(existing?:Page){
 let url=ingress+'/',read=():unknown=>({id:firstDocument,origin:ingress,busy:0,unavailable:0,alerts:0});
 const frame={url:()=>url},storage=new Map<string,string>();
 let onCommit=()=>{};
 const page=Object.assign(existing??{}, {
  mainFrame:()=>frame,url:()=>url,on:existing?.on??vi.fn(),off:existing?.off??vi.fn(),
  addInitScript:existing?.addInitScript??vi.fn(),
  waitForURL:vi.fn(async()=>{}),
  evaluate:vi.fn(async(_fn:unknown,input:{key?:string;expected?:string})=>{
   if(input.expected){expect(read()).toMatchObject({id:input.expected});url='about:blank';onCommit();return;}
   const receipt=storage.get(input.key!)??null;storage.delete(input.key!);
   return url==='about:blank'?receipt:{read:read(),receipt};
  }),
  goto:vi.fn(async(next:string)=>{url=next;onCommit();return {status:()=>200};}),
 })as unknown as Page;
 const key=()=> (vi.mocked(page.addInitScript).mock.calls.at(-1)?.[1]as {key:string}).key;
 return {page,storage,store:(payload:unknown)=>storage.set(key(),JSON.stringify(payload)),
  next:(fn:()=>void)=>{onCommit=fn;},read:(fn:()=>unknown)=>{read=fn;},
  receipt:(id=firstDocument)=>({id,mask:0,terminal:true,key:key()}),
 };
}
beforeEach(()=>{
 vi.stubEnv('GITHUB_ACTIONS','true');vi.stubEnv('RUNNER_ENVIRONMENT','github-hosted');vi.stubEnv('GITHUB_REPOSITORY','StradaverseHub/ai-hr');
 vi.stubEnv('AIHR_PERFORMANCE_ROLE_FIXTURE','true');vi.stubEnv('DATABASE_URL','postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
 vi.stubEnv('AIHR_CI_HEAD',source.sha);vi.stubEnv('AIHR_CI_CONTROL_HEAD',source.controller);vi.stubEnv('GITHUB_RUN_ID','123');vi.stubEnv('GITHUB_RUN_ATTEMPT','1');
});
afterEach(()=>{source.scenarioSha256='d'.repeat(64);source.legacyDenied=false;vi.restoreAllMocks();vi.unstubAllEnvs();});
it('binds the exact written UTF-8 rendered capture and refuses oversized or failed exclusive writes',async()=>{
 const collector=createNavigationCaptureCollector({phase:'baseline'});
 await collector.captureActor(fictionalPage().page,4);
 const baseline=collector.finish();
 const out=mkdtempSync(join(tmpdir(),'aihr-rendered-capture-model-'));
 try{
  const path=join(out,NAVIGATION_CAPTURE_MEMBER);
  const binding=writeNavigationCaptureBundle(out,baseline,undefined,'development-byte-binding');
  const bytes=readFileSync(path);
  expect(binding).toEqual({sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
  expect(Object.isFrozen(binding)).toBe(true);
  expect(()=>writeNavigationCaptureBundle(out,baseline,undefined,'development-byte-binding')).toThrow(/EEXIST/);
  expect(readFileSync(path)).toEqual(bytes);
  const old=join(out,'legacy');mkdirSync(old);
  const bundle=writeNavigationCaptureBundle(old,baseline);
  expect(bundle.baseline).toBe(baseline);
  expect(readFileSync(join(old,NAVIGATION_CAPTURE_MEMBER))).toEqual(bytes);
  const both=join(out,'both');mkdirSync(both);
  const loaded={...baseline,phase:'loaded' as const};
  expect(()=>writeNavigationCaptureBundle(both,baseline,{...loaded,runId:999},'development-byte-binding'))
   .toThrow(/different source\/run identities/);
  expect(existsSync(join(both,NAVIGATION_CAPTURE_MEMBER))).toBe(false);
  const combined=writeNavigationCaptureBundle(both,baseline,loaded,'development-byte-binding');
  const combinedBytes=readFileSync(join(both,NAVIGATION_CAPTURE_MEMBER));
  expect(combined).toEqual({sha256:createHash('sha256').update(combinedBytes).digest('hex'),bytes:combinedBytes.length});
  expect(JSON.parse(combinedBytes.toString('utf8'))).toMatchObject({baseline:{phase:'baseline'},loaded:{phase:'loaded'}});
  const tooLarge=join(out,'oversize');mkdirSync(tooLarge);
  const oversized={...baseline,observations:[{...baseline.observations[0],finalPath:'é'.repeat(2*1024**2)}]};
  expect(()=>writeNavigationCaptureBundle(tooLarge,oversized,undefined,'development-byte-binding')).toThrow(/capture byte bound refused/);
  expect(existsSync(join(tooLarge,NAVIGATION_CAPTURE_MEMBER))).toBe(false);
 }finally{rmSync(out,{recursive:true,force:true});}
});

describe('native identity and streamed navigation capture boundaries',()=>{
 it.each([
  ['clean',null],['missing-document',/lost a document observation/],['missing-retirement',/document census differs/],
  ['retired-busy',/rendered failure state/],['page-error',/browser\/server error/],
 ] as const)('seals streamed legacy denial before reading Home (%s)',async(mode,error)=>{
  source.legacyDenied=true;
  const {page}=fictionalPage(),events=new EventEmitter(),locate=page.locator.bind(page);
  const frame={},disposed=vi.fn();
  let url=ingress+'/unit';
  Object.assign(page,{
   mainFrame:()=>frame,url:()=>url,on:events.on.bind(events),off:events.off.bind(events),
   addInitScript:async()=>({dispose:disposed}),
   async goto(address:string){
    expect(address).toBe(url);
    for(const path of ['/unit','/'])events.emit('response',{
     request:()=>({isNavigationRequest:()=>true,resourceType:()=> 'document',method:()=> 'GET',frame:()=>frame}),
     status:()=>200,url:()=>ingress+path,fromServiceWorker:()=>false,
    });
    return {status:()=>200};
   },
   async waitForURL(predicate:(url:URL)=>boolean){
    url=ingress+'/';expect(predicate(new URL(url))).toBe(true);
    if(mode==='page-error')events.emit('pageerror',Error('fictional error'));
   },
   async evaluate(){
    expect(url).toBe(ingress+'/');
    return {href:url,documents:mode==='missing-document'?['/']:['/unit','/'],retired:mode==='missing-retirement'?0:1,
     busy:Number(mode==='retired-busy'),unavailable:0,alerts:0};
   },
   locator(selector:string){return selector==='main [data-navigation-destination="submenu.unit"]'?{count:async()=>0}:locate(selector);},
  });
  const collector=createNavigationCaptureCollector({phase:'baseline'}),capture=collector.captureActor(page,4);
  if(error)await expect(capture).rejects.toThrow(error);
  else {
   await capture;
   expect(collector.finish().observations).toMatchObject([{outcome:'denied',finalPath:'/',failures:{busy:0,pageErrors:0}}]);
  }
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(events.listenerCount('response')).toBe(0);
 });
 it('keeps legacy separate and refuses markers queued after a clean snapshot when the document retires',async()=>{
  const {page}=fictionalPage(),collector=createNavigationCaptureCollector({phase:'baseline'});
  await collector.captureActor(page,4);expect(collector.finish().observations).toHaveLength(1);
  const fixture=retirementPage(page),observer=await installNativePrimaryFailureObserver(page);
  await expect(installNativePrimaryFailureObserver(page)).rejects.toThrow(/already installed/);
  expect(page.addInitScript).toHaveBeenCalledTimes(2);
  const [legacy,native]=vi.mocked(page.addInitScript).mock.calls;
  expect(legacy[1]).toMatchObject({alerts:'main [role="alert"]'});
  expect(native[1]).toMatchObject({selectors:{alerts:'main [role="alert"],main[role="alert"]'}});
  type AttributeRecord={type:'attributes';target:FixtureElement;attributeName:string;oldValue:string|null;addedNodes:[]};
  class FixtureElement{constructor(readonly inMain=true){}closest(){return this.inMain?this:null;}}
  const observers:{options?:MutationObserverInit;pending:AttributeRecord[];disconnected:boolean}[]=[];
  class FixtureObserver{
   entry:(typeof observers)[number]={pending:[],disconnected:false};
   constructor(){observers.push(this.entry);}
   observe(_document:unknown,options:MutationObserverInit){this.entry.options=options;}
   takeRecords(){return this.entry.pending.splice(0);}
   disconnect(){this.entry.disconnected=true;}
  }
  let pagehide:(event:{isTrusted:boolean;persisted:boolean})=>void;
  const windowState:Record<string,unknown>={
   addEventListener(name:string,listener:typeof pagehide){expect(name).toBe('pagehide');pagehide=listener;}};
  windowState.top=windowState;
  const browser={window:windowState,document:{querySelectorAll:()=>[]},location:{origin:ingress},
   crypto:{randomUUID:()=>firstDocument},Element:FixtureElement,MutationObserver:FixtureObserver,
   sessionStorage:{getItem:(key:string)=>fixture.storage.get(key)??null,setItem:(key:string,value:string)=>fixture.storage.set(key,value)}};
  observer.beforeNavigation();
  for(const [script,input]of [legacy,native]){
   expect(typeof script).toBe('function');
   // Model tsx's keepNames transform and Playwright's transfer of only the
   // resulting function text to a document with no Node module bindings.
   const compiled=transformSync('const callback=('+String(script)+');',{keepNames:true}).code;
   const serialized=runInNewContext(compiled+'\ncallback.toString()',{})as string;
   runInNewContext('('+serialized+')(input)',{...browser,input});
  }
  expect(observers[0].options?.attributeOldValue).toBeUndefined();
  expect(observers[1].options?.attributeOldValue).toBe(true);
  fixture.read(windowState.__aihrNativePrimaryFailureCaptureV1 as ()=>unknown);
  expect(await observer.snapshot(()=>1000)).toEqual({busy:0,unavailable:0,alerts:0});
  const inMain=new FixtureElement(),outside=new FixtureElement(false);
  const change=(target:FixtureElement,attributeName:string,oldValue:string|null):AttributeRecord=>({type:'attributes',target,attributeName,oldValue,addedNodes:[]});
  observers[1].pending.push(change(inMain,'data-page-busy',null),change(inMain,'data-page-busy',''),
   change(inMain,'data-read-unavailable','true'),change(inMain,'role','alert'),change(inMain,'role','status'),change(outside,'data-page-busy',''));
  fixture.next(()=>{expect(page.url()).toBe('about:blank');pagehide({isTrusted:true,persisted:false});});
  await observer.finish(()=>1000);
  expect(observers[1].disconnected).toBe(true);
  expect(windowState.__aihrNavigationFailureCaptureV1).toEqual({busy:0,unavailable:0,alerts:0});
  expect(observer.facts()).toEqual({admitted:1,retired:1,refusals:0,finalBlank:true,markerDocuments:{busy:1,unavailable:1,alerts:1}});
  expect(()=>observer.requireSettled(1)).toThrow(/failure observed through document retirement/);
 });
 it('requires two distinct receipts and one exact inert navigation before native primary settlement',async()=>{
  const fixture=retirementPage(),{page}=fixture,observer=await installNativePrimaryFailureObserver(page);
  observer.beforeNavigation();await page.goto(ingress+'/first');await observer.snapshot(()=>1000);
  expect(()=>observer.requireSettled(1)).toThrow(/incomplete/);
  observer.beforeNavigation();fixture.next(()=>fixture.store(fixture.receipt()));
  await page.goto(ingress+'/second');
  fixture.read(()=>({id:secondDocument,origin:ingress,busy:0,unavailable:0,alerts:0}));await observer.snapshot(()=>1000);
  fixture.next(()=>fixture.store(fixture.receipt(secondDocument)));await observer.finish(()=>1000);
  expect(page.url()).toBe('about:blank');expect(page.goto).toHaveBeenCalledTimes(2);
  expect(page.waitForURL).toHaveBeenLastCalledWith('about:blank',{waitUntil:'domcontentloaded',timeout:1000});
  expect(()=>observer.requireSettled(2)).not.toThrow();expect(()=>observer.requireSettled(1)).toThrow(/incomplete/);
  expect(fixture.storage.size).toBe(0);
 });
 it.each(['wrong-key','wrong-document','extra-field','out-of-range','persisted','malformed']as const)(
  'refuses an inadmissible native retirement receipt (%s)',async kind=>{
   const fixture=retirementPage(),observer=await installNativePrimaryFailureObserver(fixture.page);
   observer.beforeNavigation();await observer.snapshot(()=>1000);
   const receipt=fixture.receipt();
   let payload:unknown=receipt;
   if(kind==='wrong-key')receipt.key='unowned';
   if(kind==='wrong-document')receipt.id=secondDocument;
   if(kind==='extra-field')payload={...receipt,unexpected:0};
   if(kind==='out-of-range')receipt.mask=8;
   if(kind==='persisted')receipt.terminal=false;
   if(kind==='malformed')payload=[];
   fixture.next(()=>fixture.store(payload));
   await expect(observer.finish(()=>1000)).rejects.toThrow(/retirement refused/);
   expect(observer.facts()).toMatchObject({admitted:1,retired:0,refusals:1,finalBlank:false});
  });
 it('refuses a missing receipt within the remaining deadline after inert navigation',async()=>{
  const fixture=retirementPage(),observer=await installNativePrimaryFailureObserver(fixture.page);
  observer.beforeNavigation();await observer.snapshot(()=>1000);
  await expect(observer.finish(()=>1)).rejects.toThrow(/receipt missing/);
  expect(observer.facts()).toMatchObject({admitted:1,retired:0,refusals:1,finalBlank:false});
 });
 it('refuses a stale receipt before the first document and a missing same-tab successor receipt',async()=>{
  const stale=retirementPage(),staleObserver=await installNativePrimaryFailureObserver(stale.page);
  stale.store(stale.receipt());staleObserver.beforeNavigation();
  await expect(staleObserver.snapshot(()=>1000)).rejects.toThrow(/retirement refused/);
  const missing=retirementPage(),observer=await installNativePrimaryFailureObserver(missing.page);
  observer.beforeNavigation();await observer.snapshot(()=>1000);observer.beforeNavigation();
  missing.read(()=>({id:secondDocument,origin:ingress,busy:0,unavailable:0,alerts:0}));
  await expect(observer.snapshot(()=>1000)).rejects.toThrow(/receipt missing/);
  expect(observer.facts()).toMatchObject({admitted:1,retired:0,refusals:1,finalBlank:false});
 });
 it('counts actual bound Page event classes and refuses a failure delivered after a clean route snapshot',()=>{
  const first=new EventEmitter(),second=new EventEmitter(),one=first as unknown as Page,two=second as unknown as Page;
  const observation=createNativeBrowserFailureObservation();
  expect(()=>observation.pageCount(one)).toThrow(/Unobserved/);
  observation.observe(one);observation.observe(two);
  expect(()=>observation.observe(one)).toThrow(/already observed/);
  const cleanVisit=observation.pageCount(one);expect(cleanVisit).toBe(0);expect(()=>observation.requireClean()).not.toThrow();
  const failedRequest=(origin:string,errorText:string)=>({url:()=>origin+'/asset',failure:()=>({errorText})});
  const response=(origin:string,status:number)=>({url:()=>origin+'/asset',status:()=>status});
  first.emit('requestfailed',failedRequest('https://other.invalid','net::ERR_CONNECTION_RESET'));
  first.emit('response',response('https://localhost:3443',404));first.emit('console',{type:()=> 'warning'});
  expect(observation.pageCount(one)).toBe(cleanVisit);
  first.emit('requestfailed',failedRequest('https://localhost:3443','net::ERR_ABORTED'));
  expect(observation.pageCount(one)-cleanVisit).toBe(1);expect(()=>observation.requireClean()).toThrow(/settlement/);
  second.emit('requestfailed',failedRequest('https://localhost:3443','net::ERR_CONNECTION_RESET'));
  second.emit('response',response('https://localhost:3443',503));second.emit('pageerror',Error('private message'));
  second.emit('console',{type:()=> 'error'});second.emit('crash');
  expect(observation.pageCount(two)).toBe(5);
  expect(observation.facts()).toEqual({aborted:1,transport:1,http5xx:1,pageError:1,consoleError:1,crash:1});
 });
 it('binds exact identity to the unique account button and waits for streamed anchors/disclosures inside one budget',async()=>{
  const {page,waits,operations}=fictionalPage(),collector=createNavigationCaptureCollector({phase:'baseline'});
  await collector.captureActor(page,4);expect(collector.finish().observations).toHaveLength(1);
  for(const selector of ['a[data-navigation-destination="submenu.unit"]','button[data-tour="account"]','main details:has(input[name="unit"])','main details:has(input[name="unit"]) > summary']){
   expect(operations.indexOf('visible:'+selector)).toBeLessThan(operations.indexOf('count:'+selector));
  }
  expect(waits.map(row=>row.timeout)).toEqual(waits.map(row=>row.timeout).sort((a,b)=>b-a));
  expect(waits[0].timeout).toBe(89000);expect(waits.at(-1)!.timeout).toBeLessThan(89000);
 });
 it.each([otherActorName,actorName+' extra'])('rejects authenticated account %s even when workforce content contains the expected actor',async accountName=>{
  const {page,body}=fictionalPage({accountName}),collector=createNavigationCaptureCollector({phase:'baseline'});
  expect(await body.innerText()).toContain(actorName);
  await expect(collector.captureActor(page,4)).rejects.toThrow('Mocked visible locator deadline: button[data-tour="account"] exact identity');
  expect(()=>collector.finish()).toThrow('Navigation capture identity or completeness differs');
 });
 it.each([{accountCount:2},{anchorCount:2},{detailsCount:2}])('refuses ambiguous native account/navigation/disclosure controls after waiting (%j)',async options=>{
  const {page}=fictionalPage(options),collector=createNavigationCaptureCollector({phase:'baseline'});
  await expect(collector.captureActor(page,4)).rejects.toThrow(/ambiguous/);
 });
});

const nativeShellIdentity={candidateSha:source.sha,controllerSha:source.controller,runId:123,harnessSha256:'c'.repeat(64),
 scenarioSha256:NATIVE_SHELL_LEGACY_SCENARIO_SHA256};
function modeledShellBaseline():NativeShellBaseline{
 return {schemaVersion:1,protocol:NATIVE_SHELL_BASELINE_VERSION,releaseAuthorized:false,...nativeShellIdentity,runAttempt:1,
  legacyCases:48,nativeCases:52,retiredDocuments:8,extensionSha256:nativeHiddenShellCasesSha256(),complete:true,
  observations:NATIVE_HIDDEN_SHELL_CASES.map(({id,destinationId,role,actorIndex,entry,shellVisibility,originHref,href,outcome})=>({
   id,destinationId,role,actorIndex,entry,shellVisibility,originHref,href,outcome,originStatus:200,redirectStatus:307,finalStatus:200,finalHref:'/',
   internalSessionObserved:true,fixtureIdentityObserved:true,privateDestinationAbsent:true,elapsedMs:1200,
  }))};
}
type HiddenShellFixtureMode='exact'|'streamed'|'extra-hop'|'location'|'other-home'|'private-content'|'retired-marker';
function hiddenShellPage(mode:HiddenShellFixtureMode='exact'){
 const {page,operations}=fictionalPage(),legacyGoto=page.goto.bind(page),legacyLocator=page.locator.bind(page),legacyWait=page.waitForURL.bind(page);
 const navigations:string[]=[],disposals:string[]=[];
 let url=ingress+'/unit',id:string|undefined,serial=0,privateContent=false;
 const frame={url:()=>url};
 let key:string|undefined,receipt:string|null=null;
 const retire=(mask=0)=>{if(id)receipt=JSON.stringify({id,key,mask,terminal:true});};
 const origin=ingress+'/';
 const empty={count:async()=>0};
 const accountSelector='button[data-tour="account"]';
 type ModeledRequest={url:()=>string;method:()=>string;resourceType:()=>string;isNavigationRequest:()=>boolean;frame:()=>typeof frame;
  redirectedFrom:()=>ModeledRequest|null;redirectedTo:()=>ModeledRequest|null;response:()=>Promise<unknown>};
 const request=(address:string)=>{
  const linked:{from?:ModeledRequest;to?:ModeledRequest;response?:unknown}={};
  const value:ModeledRequest={url:()=>address,method:()=> 'GET',resourceType:()=> 'document',isNavigationRequest:()=>true,frame:()=>frame,
   redirectedFrom:()=>linked.from??null,redirectedTo:()=>linked.to??null,response:async()=>linked.response??null};
  return {value,linked};
 };
 const document=(address:string,status:number,location?:string)=>{
  const {value,linked}=request(address);
  const response={url:()=>address,status:()=>status,request:()=>value,headers:()=>({location}),fromServiceWorker:()=>false};
  linked.response=response;
  return {response,value,linked};
 };
 Object.assign(page,{
  url:()=>url,mainFrame:()=>frame,
  addInitScript:async(_script:unknown,input:{key?:string})=>{
   if(input.key)key=input.key;
   return {dispose:async()=>{expect(url).toBe('about:blank');key=undefined;disposals.push('script');}};
  },
  async waitForURL(target:Parameters<Page['waitForURL']>[0],options:Parameters<Page['waitForURL']>[1]){
   if(target==='about:blank'){expect(options?.waitUntil).toBe('domcontentloaded');return;}
   return legacyWait(target,options);
  },
  evaluate:async(_fn:unknown,input?:{property:string;key?:string;expected?:string})=>{
   const counts={busy:0,unavailable:0,alerts:0};
   if(!input)return counts;
   expect(input.property).toBe('__aihrNativeHiddenShellFailureCaptureV1');
   if(input.expected){
    expect(input.expected).toBe(id);retire(mode==='retired-marker'?1:0);
    url='about:blank';navigations.push(url);id=undefined;return;
   }
   expect(input.key).toBe(key);
   const consumed=receipt;receipt=null;
   if(url==='about:blank')return consumed;
   expect(id).toBeDefined();return {read:{...counts,id,origin:ingress},receipt:consumed};
  },
  locator(selector:string){
   if(!key||selector===accountSelector||selector==='main')return legacyLocator(selector);
   if(selector==='aside[data-app-sidebar]')return {waitFor:async()=>{},locator:()=>empty};
   if(selector.startsWith('main [data-navigation-destination='))return {count:async()=>Number(privateContent)};
   return empty;
  },
  async goto(address:string,options:Parameters<Page['goto']>[1]){
   navigations.push(address);const legacy=await legacyGoto(address,options);
   if(!key){url=address;return legacy;}
   retire();
   id='12345678-1234-4234-8234-'+String(++serial).padStart(12,'0');
   if(address===origin){url=origin;privateContent=false;return document(origin,200).response;}
   expect([ingress+'/payroll',ingress+'/analytics']).toContain(address);
   url=mode==='other-home'?origin+'?foreign=1':origin;privateContent=mode==='private-content';
   const final=document(url,200);
   if(mode!=='streamed'){
    const prior=document(address,307,mode==='location'?'/other':'/');
    prior.linked.to=final.value;final.linked.from=prior.value;
    if(mode==='extra-hop')prior.linked.from=document(ingress+'/foreign',307,address).value;
   }
   return final.response;
  },
 });
 return {page,navigations,operations,disposals};
}

describe('separate fixed native shell baseline data and driver controls',()=>{
 it('binds only the four reviewed actor and route pairs to the distinct native shell scope',()=>{
  expect(NATIVE_HIDDEN_SHELL_CASES.map(row=>[row.id,row.actorIndex,row.href])).toEqual([
   ['shell.payrollProcess.employee.hidden-denied',4,'/payroll'],['shell.payrollProcess.manager.hidden-denied',2,'/payroll'],
   ['shell.analytics.employee.hidden-denied',4,'/analytics'],['shell.analytics.manager.hidden-denied',2,'/analytics'],
  ]);
  const record=modeledShellBaseline();expect(validateNativeShellBaseline(record,nativeShellIdentity)).toBe(record);
  const malformed:Array<[string,(r:NativeShellBaseline)=>void]>=[
   ['omitted',r=>{r.observations.pop();}],['duplicate',r=>{r.observations[3]=r.observations[0];}],
   ['actor',r=>{Reflect.set(r.observations[0],'actorIndex',5);}],['role',r=>{Reflect.set(r.observations[0],'role','groupHR');}],
   ['destination',r=>{Reflect.set(r.observations[0],'destinationId','shell.rosterManager');}],
   ['route',r=>{Reflect.set(r.observations[0],'href','/roster');}],['origin',r=>{Reflect.set(r.observations[0],'originHref','/login');}],
   ['denial',r=>{Reflect.set(r.observations[0],'outcome','usable');}],['shell visibility',r=>{Reflect.set(r.observations[0],'shellVisibility','visible');}],
   ['target',r=>{Reflect.set(r.observations[0],'finalHref','/?other=1');}],
   ['streamed',r=>{Reflect.set(r.observations[0],'redirectStatus',200);}],['entry',r=>{Reflect.set(r.observations[0],'entry','canonical-link');}],
   ['private destination',r=>{Reflect.set(r.observations[0],'privateDestinationAbsent',false);}],
   ['extension hash',r=>{r.extensionSha256='0'.repeat(64);}],['legacy hash',r=>{r.scenarioSha256='0'.repeat(64);}],
   ['harness hash',r=>{r.harnessSha256='0'.repeat(64);}],['retirement count',r=>{Reflect.set(r,'retiredDocuments',7);}],['extra key',r=>{Reflect.set(r.observations[0],'extra',true);}],
  ];
  for(const [name,change]of malformed){
   const wrong=structuredClone(record);change(wrong);
   expect(()=>validateNativeShellBaseline(wrong,nativeShellIdentity),name).toThrow(/Native (?:hidden shell observation|shell baseline identity or completeness) differs/);
  }
 });
 it('keeps the original v2 collector separate and requires the same Page, clean retirement and whole legacy census',async()=>{
  const ordinary=hiddenShellPage(),development=createNavigationCaptureCollector({phase:'baseline'});
  expect(()=>development.nativeHiddenShell(performance.now()+90000)).toThrow(/Exact legacy navigation/);
  await development.captureActor(ordinary.page,4);
  const old=development.finish();
  expect(ordinary.navigations).toEqual([ingress+'/unit']);expect(ordinary.disposals).toEqual([]);
  expect(old).toMatchObject({protocol:'aihr-navigation-development/v2',scenarioSha256:'d'.repeat(64),phase:'baseline'});
  expect(old.observations).toHaveLength(1);

  source.scenarioSha256=NATIVE_SHELL_LEGACY_SCENARIO_SHA256;
  const current=hiddenShellPage(),collector=createNavigationCaptureCollector({phase:'baseline'});
  const native=collector.nativeHiddenShell(performance.now()+90000);
  await expect(native.captureActor(current.page,4)).rejects.toThrow(/same completed legacy actor Page/);
  await collector.captureActor(current.page,4);
  await expect(native.captureActor(ordinary.page,4)).rejects.toThrow(/same completed legacy actor Page/);
  await native.captureActor(current.page,4);
  expect(current.navigations).toEqual([ingress+'/unit',ingress+'/',ingress+'/payroll',ingress+'/',ingress+'/analytics','about:blank']);
  expect(current.disposals).toEqual(['script']);
  expect(current.operations.filter(operation=>operation.startsWith('click:'))).toEqual(
   ordinary.operations.filter(operation=>operation.startsWith('click:')));
  await expect(native.captureActor(current.page,4)).rejects.toThrow(/same completed legacy actor Page/);
  const baseline=collector.finish();
  expect(baseline.observations).toEqual(old.observations);
  expect(baseline).not.toHaveProperty('extensionSha256');
  expect(()=>native.finish()).toThrow(/Exact complete legacy baseline/);
 });
 it.each([
  ['streamed','direct denial redirect chain'],
  ['extra-hop','direct denial redirect chain'],
  ['location','HTTP 307 to Home'],
  ['other-home','did not finish at Home'],
  ['private-content','private destination rendered'],
  ['retired-marker','failure observed through document retirement'],
 ]as const)('refuses %s even with an ordinary signed-in baseline',async(mode,reason)=>{
  source.scenarioSha256=NATIVE_SHELL_LEGACY_SCENARIO_SHA256;
  const model=hiddenShellPage(mode),collector=createNavigationCaptureCollector({phase:'baseline'});
  const native=collector.nativeHiddenShell(performance.now()+90000);
  await collector.captureActor(model.page,4);
  await expect(native.captureActor(model.page,4)).rejects.toThrow(reason);
  expect(model.disposals).toEqual([]);
 });
});


it('retains all 74 group primary documents and refuses a 75th or an unlisted actor',async()=>{
 const id=(index:number)=>'12345678-1234-4234-8234-'+String(index).padStart(12,'0');
 async function observe(count:number){
  const fixture=retirementPage();
  const observer=await installNativePrimaryFailureObserver(fixture.page,0);
  for(let index=1;index<=count;index++){
   observer.beforeNavigation();
   fixture.next(()=>{if(index>1)fixture.store(fixture.receipt(id(index-1)));});
   await fixture.page.goto(ingress+'/');
   fixture.read(()=>({id:id(index),origin:ingress,busy:0,unavailable:0,alerts:0}));
   await observer.snapshot(()=>1000);
  }
  fixture.next(()=>fixture.store(fixture.receipt(id(count))));
  await observer.finish(()=>1000);
  observer.requireSettled(count);
  return observer.facts();
 }
 expect(await observe(74)).toMatchObject({admitted:74,retired:74,finalBlank:true});
 await expect(observe(75)).rejects.toThrow(/snapshot identity differs/);
 await expect(installNativePrimaryFailureObserver(retirementPage().page,3)).rejects.toThrow(/Unknown primary route retirement actor/);
});

it('seals the separate development route union only with exact route, hidden and settled role facts',async()=>{
 const collector=createNavigationCaptureCollector({phase:'baseline'});
 await collector.captureActor(fictionalPage().page,4);
 const old=collector.finish();
 // The legacy producer owns actual complete observations. This writer model uses
 // their type and count; it supplies no application or native coverage claim.
 const hidden={...modeledShellBaseline(),controllerSha:source.sha};
 const baseline={...old,complete:true,controllerSha:source.sha,scenarioSha256:hidden.scenarioSha256,
  observations:Array.from({length:48},()=>old.observations[0])};
 const rows=nativePreflightRoutePlan().map(row=>({...row,status:200,accountObserved:true,elapsedMs:10,failureCount:0,
  readiness:nativePreflightReadiness(row.witness)}));
 const primary=[{actorIndex:0,documents:74},{actorIndex:1,documents:71},{actorIndex:2,documents:16},{actorIndex:4,documents:30}]
  .map(({actorIndex,documents})=>({actorIndex,admitted:documents,retired:documents,refusals:0,finalBlank:true,pageFailures:0,
   markerDocuments:{busy:0,unavailable:0,alerts:0}}));
 const tiles=[{phase:'baseline',role:'groupHR',open:2,pending:1},{phase:'baseline',role:'companyHR',open:1,pending:1}];
 const output=mkdtempSync(join(tmpdir(),'aihr-development-union-'));
 const member=join(output,DEVELOPMENT_RENDERED_UNION_MEMBER);
 try{
  expect(()=>writeDevelopmentRenderedRouteUnion(output,baseline,rows.slice(1),hidden,primary,tiles)).toThrow(/route union incomplete/);
  expect(()=>writeDevelopmentRenderedRouteUnion(output,baseline,[...rows.slice(1),rows[1]],hidden,primary,tiles)).toThrow(/Duplicate/);
  expect(()=>writeDevelopmentRenderedRouteUnion(output,baseline,rows,{...hidden,observations:hidden.observations.slice(1)},primary,tiles)).toThrow(/shell baseline identity/);
  expect(()=>writeDevelopmentRenderedRouteUnion(output,baseline,rows,hidden,[{...primary[0],pageFailures:1},...primary.slice(1)],tiles))
   .toThrow(/retirement or Page settlement differs/);
  expect(()=>writeDevelopmentRenderedRouteUnion(output,baseline,rows,hidden,primary,[{...tiles[0],open:1},tiles[1]])).toThrow(/Lifecycle scope/);
  expect(()=>writeDevelopmentRenderedRouteUnion(output,{...baseline,controllerSha:source.controller},rows,hidden,primary,tiles)).toThrow(/self-source/);
  expect(existsSync(member)).toBe(false);
  const seal=writeDevelopmentRenderedRouteUnion(output,baseline,[...rows].reverse(),hidden,primary,tiles);
  const bytes=readFileSync(member);
  expect(seal).toEqual({sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
  const actual=JSON.parse(bytes.toString('utf8'));
  expect(actual).toMatchObject({kind:'DEVELOPMENT_RENDERED_ROUTE_UNION_V1',complete:true,releaseEligible:false,protectedNative:false,
   dynamicNavigationComplete:false,counts:{total:191,urls:93,usable:16,scopedDenials:1,renderedOnly:174},hiddenShell:{count:4,retiredDocuments:8},
   candidateSha:source.sha,controllerSha:source.sha,runId:123,runAttempt:1});
  expect(actual.observations).toEqual(rows);expect(actual.primaryRetirement).toEqual(primary);
  expect(()=>writeDevelopmentRenderedRouteUnion(output,baseline,rows,hidden,primary,tiles)).toThrow(/EEXIST/);
 }finally{rmSync(output,{recursive:true,force:true});}
});
