/** Collector behavior contracts with a mocked page/source, never executed app coverage. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Page} from 'playwright';
const source=vi.hoisted(()=>({sha:'a'.repeat(40),controller:'b'.repeat(40)}));
vi.mock('../scripts/performance/navigation-source',()=>({
 navigationCleanHead:()=>source.sha,
 navigationSourceIdentity:()=>({harnessSha256:'c'.repeat(64),scenarioSha256:'d'.repeat(64),plan:{schemaVersion:1,fixture:'system-load-v1',engine:'chromium',scope:'Unit collector contract only',scenarios:[{
  id:'unit.employee',destinationId:'submenu.unit',role:'employee',href:'/unit',originHref:'/unit',outcome:'usable',readiness:'controls',
  steps:[{kind:'open-details',selector:'main details:has(input[name="unit"])'}],checks:[{id:'input',kind:'enabled',tag:'input',selector:'main input[name="unit"]'}],
 }]}}),
}));
vi.mock('../scripts/performance/navigation-fixture-bindings',()=>({readNavigationFixtureBindings:()=>new Map([[4,{actorName:'PERF Person 0004',actorEmployeeCode:'PERF0004',firstCompanyPersonName:'PERF Person 0000',activeHeadcount:'50',historicalPayrollMonth:'2026-07',seedToday:'2026-11-07',seedMonth:'2026-11',rosterScope:{}}]])}));
import {createNavigationCaptureCollector,installFailureObserver} from '../scripts/performance/navigation-browser-capture';
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
beforeEach(()=>{
 vi.stubEnv('GITHUB_ACTIONS','true');vi.stubEnv('RUNNER_ENVIRONMENT','github-hosted');vi.stubEnv('GITHUB_REPOSITORY','StradaverseHub/ai-hr');
 vi.stubEnv('AIHR_PERFORMANCE_ROLE_FIXTURE','true');vi.stubEnv('DATABASE_URL','postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
 vi.stubEnv('AIHR_CI_HEAD',source.sha);vi.stubEnv('AIHR_CI_CONTROL_HEAD',source.controller);vi.stubEnv('GITHUB_RUN_ID','123');vi.stubEnv('GITHUB_RUN_ATTEMPT','1');
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('native identity and streamed navigation capture boundaries',()=>{
 it('installs root and nested failure selectors once on the native primary page only',async()=>{
  const {page:development}=fictionalPage();await installFailureObserver(development);
  const legacy=vi.mocked(development.addInitScript).mock.calls[0][1]as {unavailable:string;alerts:string};
  expect(legacy.unavailable).not.toContain(',main[data-read-unavailable]');
  expect(legacy.alerts).toBe('main [role="alert"]');
  const {page:native}=fictionalPage();await installFailureObserver(native,true);await installFailureObserver(native);
  expect(native.addInitScript).toHaveBeenCalledTimes(1);
  const strict=vi.mocked(native.addInitScript).mock.calls[0][1]as {unavailable:string;alerts:string};
  expect(strict.unavailable).toContain('main [data-read-unavailable]');expect(strict.unavailable).toContain(',main[data-read-unavailable]');
  expect(strict.alerts).toBe('main [role="alert"],main[role="alert"]');
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
