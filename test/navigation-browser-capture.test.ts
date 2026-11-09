/** Collector behavior contracts with a mocked page/source, never executed app coverage. */
import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Page} from 'playwright';
const source=vi.hoisted(()=>({sha:'a'.repeat(40),controller:'b'.repeat(40),scenarioSha256:'d'.repeat(64)}));
vi.mock('../scripts/performance/navigation-source',()=>({
 navigationCleanHead:()=>source.sha,
 navigationSourceIdentity:()=>({harnessSha256:'c'.repeat(64),scenarioSha256:source.scenarioSha256,plan:{schemaVersion:1,fixture:'system-load-v1',engine:'chromium',scope:'Unit collector contract only',scenarios:[{
  id:'unit.employee',destinationId:'submenu.unit',role:'employee',href:'/unit',originHref:'/unit',outcome:'usable',readiness:'controls',
  steps:[{kind:'open-details',selector:'main details:has(input[name="unit"])'}],checks:[{id:'input',kind:'enabled',tag:'input',selector:'main input[name="unit"]'}],
 }]}}),
}));
vi.mock('../scripts/performance/navigation-fixture-bindings',()=>({readNavigationFixtureBindings:()=>new Map([[4,{actorName:'PERF Person 0004',actorEmployeeCode:'PERF0004',firstCompanyPersonName:'PERF Person 0000',activeHeadcount:'50',historicalPayrollMonth:'2026-07',seedToday:'2026-11-07',seedMonth:'2026-11',rosterScope:{}}]])}));
import {createNavigationCaptureCollector,installNativePrimaryFailureObserver,createNativeBrowserFailureObservation} from '../scripts/performance/navigation-browser-capture';
import {NATIVE_HIDDEN_SHELL_CASES,NATIVE_SHELL_BASELINE_VERSION,NATIVE_SHELL_LEGACY_SCENARIO_SHA256,nativeHiddenShellCasesSha256,
 validateNativeShellBaseline,type NativeShellBaseline} from '../scripts/performance/navigation-protocol';
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
 const frame={url:()=>url},context={};
 type Sender={page:unknown;frame:unknown;context:unknown};
 let receive:(sender:Sender,...args:unknown[])=>unknown;
 let onCommit=()=>{};
 const page=Object.assign(existing??{}, {
  mainFrame:()=>frame,context:()=>context,url:()=>url,
  addInitScript:existing?.addInitScript??vi.fn(),
  exposeBinding:vi.fn(async(_name:string,callback:typeof receive)=>{receive=callback;}),
  evaluate:vi.fn(async()=>read()),
  goto:vi.fn(async(next:string)=>{url=next;onCommit();return next==='about:blank'?null:{status:()=>200};}),
 })as unknown as Page;
 const sender={page,frame,context};
 return {page,sender,receive:(payload:unknown,source=sender)=>receive(source,payload),
  next:(fn:()=>void)=>{onCommit=fn;},read:(fn:()=>unknown)=>{read=fn;},
  receipt:(id=firstDocument)=>{
   const input=vi.mocked(page.addInitScript).mock.calls.at(-1)?.[1]as {key:string};
   return{id,mask:0,terminal:true,key:input.key};
  },
 };
}
beforeEach(()=>{
 vi.stubEnv('GITHUB_ACTIONS','true');vi.stubEnv('RUNNER_ENVIRONMENT','github-hosted');vi.stubEnv('GITHUB_REPOSITORY','StradaverseHub/ai-hr');
 vi.stubEnv('AIHR_PERFORMANCE_ROLE_FIXTURE','true');vi.stubEnv('DATABASE_URL','postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
 vi.stubEnv('AIHR_CI_HEAD',source.sha);vi.stubEnv('AIHR_CI_CONTROL_HEAD',source.controller);vi.stubEnv('GITHUB_RUN_ID','123');vi.stubEnv('GITHUB_RUN_ATTEMPT','1');
});
afterEach(()=>{source.scenarioSha256='d'.repeat(64);vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('native identity and streamed navigation capture boundaries',()=>{
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
  const windowState:Record<string,unknown>={__aihrNativePrimaryRetirementV1:fixture.receive,
   addEventListener(name:string,listener:typeof pagehide){expect(name).toBe('pagehide');pagehide=listener;}};
  windowState.top=windowState;
  vi.stubGlobal('window',windowState);vi.stubGlobal('document',{querySelectorAll:()=>[]});
  vi.stubGlobal('location',{origin:ingress});vi.stubGlobal('crypto',{randomUUID:()=>firstDocument});
  vi.stubGlobal('Element',FixtureElement);vi.stubGlobal('MutationObserver',FixtureObserver);
  try{
   observer.beforeNavigation();
   for(const [script,input]of [legacy,native]){expect(typeof script).toBe('function');(script as (input:unknown)=>void)(input);}
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
  }finally{vi.unstubAllGlobals();}
 });
 it('requires two distinct receipts and one exact inert navigation before native primary settlement',async()=>{
  const fixture=retirementPage(),{page}=fixture,observer=await installNativePrimaryFailureObserver(page);
  observer.beforeNavigation();await page.goto(ingress+'/first');await observer.snapshot(()=>1000);
  expect(()=>observer.requireSettled(1)).toThrow(/incomplete/);
  observer.beforeNavigation();fixture.next(()=>{expect(fixture.receive(fixture.receipt())).toBe(true);});
  await page.goto(ingress+'/second');
  fixture.read(()=>({id:secondDocument,origin:ingress,busy:0,unavailable:0,alerts:0}));await observer.snapshot(()=>1000);
  fixture.next(()=>{});const finishing=observer.finish(()=>1000);
  await Promise.resolve();expect(page.url()).toBe('about:blank');
  expect(fixture.receive(fixture.receipt(secondDocument))).toBe(true);await finishing;
  expect(page.goto).toHaveBeenCalledTimes(3);
  expect(page.goto).toHaveBeenLastCalledWith('about:blank',{waitUntil:'commit',timeout:1000});
  expect(()=>observer.requireSettled(2)).not.toThrow();expect(()=>observer.requireSettled(1)).toThrow(/incomplete/);
  expect(fixture.receive(fixture.receipt(secondDocument))).toBe(false);
  expect(()=>observer.requireSettled(2)).toThrow(/incomplete/);
 });
 it.each(['foreign-page','subframe','foreign-context','wrong-key','wrong-document','extra-field','out-of-range','persisted']as const)(
  'refuses an inadmissible native retirement receipt (%s)',async kind=>{
   const fixture=retirementPage(),observer=await installNativePrimaryFailureObserver(fixture.page);
   observer.beforeNavigation();await observer.snapshot(()=>1000);
   const receipt=fixture.receipt(),sender={...fixture.sender};
   let payload:object=receipt;
   if(kind==='foreign-page')sender.page=retirementPage().page;
   if(kind==='subframe')sender.frame={url:()=>ingress};
   if(kind==='foreign-context')sender.context={};
   if(kind==='wrong-key')receipt.key='unowned';
   if(kind==='wrong-document')receipt.id=secondDocument;
   if(kind==='extra-field')payload={...receipt,unexpected:0};
   if(kind==='out-of-range')receipt.mask=8;
   if(kind==='persisted')receipt.terminal=false;
   fixture.next(()=>{expect(fixture.receive(payload,sender)).toBe(false);});
   await expect(observer.finish(()=>1000)).rejects.toThrow(/retirement refused/);
   expect(observer.facts()).toMatchObject({admitted:1,retired:0,refusals:1,finalBlank:false});
  });
 it('refuses a missing receipt within the remaining deadline after inert navigation',async()=>{
  const fixture=retirementPage(),observer=await installNativePrimaryFailureObserver(fixture.page);
  observer.beforeNavigation();await observer.snapshot(()=>1000);
  await expect(observer.finish(()=>1)).rejects.toThrow(/receipt missing/);
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
 const {page,operations}=fictionalPage(),legacyGoto=page.goto.bind(page),legacyLocator=page.locator.bind(page);
 const navigations:string[]=[],disposals:string[]=[];
 let url=ingress+'/unit',id:string|undefined,serial=0,privateContent=false;
 const frame={url:()=>url},context=page.context();
 type Sender={page:Page;frame:typeof frame;context:typeof context};
 let binding:((source:Sender,payload:{id:string;key:string;mask:number;terminal:true})=>unknown)|undefined;
 let key:string|undefined;
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
  url:()=>url,mainFrame:()=>frame,context:()=>context,
  exposeBinding:async(name:string,receiver:typeof binding)=>{
   expect(name).toBe('__aihrNativeHiddenShellRetirementV1');binding=receiver;
   return {dispose:async()=>{expect(url).toBe('about:blank');expect(disposals).toEqual(['script']);binding=undefined;disposals.push('binding');}};
  },
  addInitScript:async(_script:unknown,input:{key?:string})=>{
   if(input.key)key=input.key;
   return {dispose:async()=>{expect(url).toBe('about:blank');key=undefined;disposals.push('script');}};
  },
  evaluate:async(_fn:unknown,property?:string)=>{
   if(property!==undefined){expect(property).toBe('__aihrNativeHiddenShellFailureCaptureV1');expect(id).toBeDefined();}
   return {busy:0,unavailable:0,alerts:0,...(property?{id,origin:ingress}:{})};
  },
  locator(selector:string){
   if(!binding||selector===accountSelector||selector==='main')return legacyLocator(selector);
   if(selector==='aside[data-app-sidebar]')return {waitFor:async()=>{},locator:()=>empty};
   if(selector.startsWith('main [data-navigation-destination='))return {count:async()=>Number(privateContent)};
   return empty;
  },
  async goto(address:string,options:Parameters<Page['goto']>[1]){
   navigations.push(address);const legacy=await legacyGoto(address,options);
   if(!binding){url=address;return legacy;}
   if(id){expect(binding({page,frame,context},{id,key:key!,mask:mode==='retired-marker'&&address==='about:blank'?1:0,terminal:true})).toBe(true);}
   if(address==='about:blank'){url=address;id=undefined;return null;}
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
  expect(current.disposals).toEqual(['script','binding']);
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
