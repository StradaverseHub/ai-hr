// @vitest-environment jsdom
/** Synthetic DOM/codec adapter controls only; no native page/session/load proof. */
import {readFileSync} from 'node:fs';
import {afterEach,expect,it} from 'vitest';
import type {Page} from 'playwright';
import {observeNavigationUIContent,observePublicNavigationUIContent} from '../scripts/performance/navigation-browser-ui';
import {projectNavigationFixtureBindings} from '../scripts/performance/navigation-fixture-bindings';
import {projectNavigationExpectedInputs,navigationExpectedInputBytes,parseNavigationExpectedInputBytes,type NavigationExpectedInputs} from '../scripts/performance/navigation-expected-inputs';
import {validateNavigationScenarioPlan,type NavigationScenario,type NavigationCheck} from '../scripts/performance/navigation-protocol';
import {fictionalNavigationFixture,navigationFixtureUuid as uuid} from './helpers/navigation-fixture';
const plan=validateNavigationScenarioPlan(JSON.parse(readFileSync(new URL('../scripts/performance/navigation-scenarios.json',import.meta.url),'utf8')));
const identity={candidateSha:'a'.repeat(40),controllerSha:'b'.repeat(40),runId:123,attempt:1 as const,buildId:'fictional-ui-control'};
type Actor=NavigationExpectedInputs['actorInputs'][number];
function inputs(fixture=fictionalNavigationFixture()){
 const bindings=projectNavigationFixtureBindings(fixture),projected=projectNavigationExpectedInputs(bindings,plan,identity);
 return {bindings,decoded:parseNavigationExpectedInputBytes(navigationExpectedInputBytes(projected,plan),plan,projected.source)};
}
function scenario(actor:Actor,checks:NavigationCheck[],steps:NavigationScenario['steps']=[]):NavigationScenario{
 const target=actor.routeTargets[0],source=plan.scenarios.find(row=>row.role===actor.roleLabel&&row.destinationId===target.destinationId)!;
 return {...source,steps,checks};
}
function domPage(){
 let clock=0;const timeouts:number[]=[],clicks:string[]=[];
 const tick=(timeout?:number)=>{if(timeout!==undefined){expect(timeout).toBe(90000-clock);expect(timeout).toBeGreaterThan(0);timeouts.push(timeout);}clock+=10;};
 class Locator {
  constructor(private readonly nodes:()=>Element[]){}
  first(){return new Locator(()=>this.nodes().slice(0,1));}
  async waitFor({state,timeout}:{state:string;timeout:number}){expect(state).toBe('visible');tick(timeout);if(!this.nodes().length||!await this.isVisible())throw Error('Synthetic visible locator missing');}
  async count(){tick();return this.nodes().length;}
  async isVisible(){tick();for(let node:Element|null=this.single();node;node=node.parentElement){if(node.hasAttribute('hidden'))return false;if(node.tagName==='DETAILS'&&!node.hasAttribute('open')&&this.single()!==node&&!this.single().closest('summary'))return false;}return true;}
  async isEnabled(options?:{timeout:number}){tick(options?.timeout);return !this.single().hasAttribute('disabled');}
  async getAttribute(name:string,options?:{timeout:number}){tick(options?.timeout);return this.single().getAttribute(name);}
  async evaluate(fn:(element:Element)=>unknown){tick();return fn(this.single());}
  async innerText(options?:{timeout:number}){tick(options?.timeout);return this.single().textContent??'';}
  async inputValue(options?:{timeout:number}){tick(options?.timeout);return (this.single()as HTMLInputElement).value;}
  async all(){tick();return this.nodes().map(node=>new Locator(()=>[node]));}
  locator(selector:string){return new Locator(()=>Array.from(this.single().querySelectorAll(selector)));}
  async click({timeout}:{timeout:number}){tick(timeout);const node=this.single();expect(await this.isVisible()).toBe(true);expect(await this.isEnabled()).toBe(true);clicks.push(node.id);(node as HTMLElement).click();}
  private single(){const nodes=this.nodes();expect(nodes).toHaveLength(1);return nodes[0];}
 }
 const page={locator:(selector:string)=>new Locator(()=>Array.from(document.querySelectorAll(selector)))}as unknown as Page;
 return {page,timeouts,clicks,remaining:()=>{if(clock>=90000)throw Error('same original scenario deadline');return 90000-clock;},expire:()=>{clock=90000;}};
}
function fixtureDOM(){
 document.body.innerHTML='<main><details id="native-detail"><summary id="read-summary">Read details</summary><input id="code" value="PERF0004"><button id="control">Read control</button></details><div id="text"></div><div id="exact"></div><a id="attribute" href="/expected">Selected record</a><div class="count"></div><div class="count"></div><div class="count" hidden></div><section id="roster"></section><button id="effect">Save business record</button></main>';
 document.querySelector('summary')!.addEventListener('click',event=>{event.preventDefault();document.querySelector('details')!.setAttribute('open','');});
 document.querySelector('#effect')!.addEventListener('click',()=>{throw Error('Effect control must never be clicked');});
 return domPage();
}
afterEach(()=>document.body.replaceChildren());
it('adapts all four decoded public rows through the SAME UI implementation and retains exact text/date/history/value expectations',async()=>{
 const {bindings,decoded}=inputs();
 for(const actor of decoded.actorInputs){
  const originalRow=JSON.stringify(actor);
  const expected=[['actorName',actor.actorName],['actorEmployeeCode',actor.actorEmployeeCode],['firstCompanyPersonName',actor.firstCompanyPersonName],['activeHeadcount',actor.activeHeadcount],['historicalPayrollMonth',actor.historicalPayrollMonth],['seedToday',actor.seedToday],['seedMonth',actor.seedMonth],...(actor.history.kind==='saved'?[['firstSavedHistoryTitle',actor.history.firstSavedHistoryTitle]]:[])];
  const checks:NavigationCheck[]=expected.map(([key],i)=>({id:'expected'+i,kind:'text-exact',selector:'#expected'+i,expected:'$fixture.'+key}));
  const html='<main>'+expected.map(([,value],i)=>`<div id="expected${i}">${value}</div>`).join('')+'</main>';
  document.body.innerHTML=html;const publicUI=domPage(),publicResult=await observePublicNavigationUIContent(publicUI.page,scenario(actor,checks),actor,publicUI.remaining);
  document.body.innerHTML=html;const legacyUI=domPage(),legacyResult=await observeNavigationUIContent(legacyUI.page,scenario(actor,checks),actor.actorIndex,bindings.get(actor.actorIndex)!,legacyUI.remaining);
  expect(JSON.stringify(actor)).toBe(originalRow);expect(publicResult).toEqual(legacyResult);expect(publicResult).toEqual(checks.map(check=>({id:check.id,passed:true,observedCount:1})));
 }
});
it('opens only the native read disclosure and checks enabled, text, exact, value, attribute and visible-count DOM content',async()=>{
 const actor=inputs().decoded.actorInputs.find(row=>row.actorIndex===4)!;const ui=fixtureDOM();
 document.querySelector('#text')!.textContent='Employee '+actor.actorName+' selected';document.querySelector('#exact')!.textContent='  '+actor.activeHeadcount+'  ';
 const checks:NavigationCheck[]=[{id:'enabled',kind:'enabled',selector:'#control',tag:'button'},{id:'text',kind:'text',selector:'#text',expected:'$fixture.actorName'},
  {id:'exact',kind:'text-exact',selector:'#exact',expected:'$fixture.activeHeadcount'},{id:'value',kind:'value',selector:'#code',expected:'$fixture.actorEmployeeCode'},
  {id:'attribute',kind:'attribute',selector:'#attribute',name:'href',expected:'/expected'},{id:'count',kind:'count',selector:'.count',minimum:2,maximum:2}];
 const result=await observePublicNavigationUIContent(ui.page,scenario(actor,checks,[{kind:'open-details',selector:'#native-detail'}]),actor,ui.remaining);
 expect(result).toHaveLength(6);expect(result.at(-1)).toEqual({id:'count',passed:true,observedCount:2});expect(ui.clicks).toEqual(['read-summary']);
 expect(ui.timeouts.length).toBeGreaterThan(3);expect(ui.timeouts).toEqual([...ui.timeouts].sort((a,b)=>b-a));expect(ui.timeouts.at(-1)).toBeLessThan(ui.timeouts[0]);
 expect(result).not.toHaveProperty('internalSessionObserved');expect(result).not.toHaveProperty('fixtureIdentityObserved');expect(result).not.toHaveProperty('startedWith');
});
it('preserves every native roster membership/name oracle and the optional group-only null-name reward record',async()=>{
 const f=fictionalNavigationFixture();f.tenants[0].rewardDraft={companyId:f.tenants[0].companies[2].companyId,employmentId:uuid(999999)};
 const actor=inputs(f).decoded.actorInputs[0];document.body.innerHTML='<main id="roster"></main>';
 for(const row of actor.rosterScope){const element=document.createElement('div');element.className='roster';element.setAttribute('data-roster-employment-id',row.employmentId);element.textContent=row.expectedName??'Native reward draft';document.querySelector('main')!.append(element);}
 const ui=domPage(),checks:NavigationCheck[]=[{id:'roster',kind:'fixture-roster-rows',selector:'.roster',minimum:251,maximum:251}];
 expect(await observePublicNavigationUIContent(ui.page,scenario(actor,checks),actor,ui.remaining)).toEqual([{id:'roster',passed:true,observedCount:251}]);
});
it('refuses unknown, duplicate, foreign and wrongly named roster rows instead of accepting row count',async()=>{
 const actor=inputs().decoded.actorInputs[1],own=actor.rosterScope[0],second=actor.rosterScope[1],checks:NavigationCheck[]=[{id:'roster',kind:'fixture-roster-rows',selector:'.roster',minimum:2,maximum:2}];
 for(const rows of [[[own.employmentId,own.expectedName],[uuid(900000),'Foreign']],[[own.employmentId,own.expectedName],[own.employmentId,own.expectedName]],[[own.employmentId,own.expectedName],[second.employmentId,'Wrong seeded name']]]){
  document.body.innerHTML='<main>'+rows.map(([id,name])=>`<div class="roster" data-roster-employment-id="${id}">${name}</div>`).join('')+'</main>';
  const ui=domPage();await expect(observePublicNavigationUIContent(ui.page,scenario(actor,checks),actor,ui.remaining)).rejects.toThrow(/Roster/);
 }
});
it('refuses disabled/wrong-tag controls, wrong data/value/attribute and out-of-range visible counts',async()=>{
 const actor=inputs().decoded.actorInputs.find(row=>row.actorIndex===4)!;
 const invalid:NavigationCheck[]=[{id:'disabled',kind:'enabled',selector:'#effect',tag:'button'},{id:'wrong-tag',kind:'enabled',selector:'#attribute',tag:'input'},
  {id:'wrong-text',kind:'text',selector:'#text',expected:'Missing fixture content'},{id:'partial-exact',kind:'text-exact',selector:'#text',expected:'PERF Person'},
  {id:'wrong-value',kind:'value',selector:'#code',expected:'Other employee'},{id:'wrong-attribute',kind:'attribute',selector:'#attribute',name:'href',expected:'/foreign'},
  {id:'too-few',kind:'count',selector:'.count',minimum:3},{id:'too-many',kind:'count',selector:'.count',minimum:1,maximum:1}];
 for(const check of invalid){const ui=fixtureDOM();document.querySelector('#effect')!.setAttribute('disabled','');document.querySelector('#text')!.textContent=actor.actorName;document.querySelector('details')!.setAttribute('open','');
  await expect(observePublicNavigationUIContent(ui.page,scenario(actor,[check]),actor,ui.remaining)).rejects.toThrow();expect(ui.clicks).toEqual([]);
 }
});
it('refuses ambiguous/wrong disclosure elements and disabled summaries without clicking business effects',async()=>{
 const actor=inputs().decoded.actorInputs[0];
 for(const html of ['<details class="disclosure"><summary>A</summary></details><details class="disclosure"><summary>B</summary></details>','<div class="disclosure">Wrong element</div>','<details class="disclosure"><summary disabled>Disabled</summary></details>']){
  document.body.innerHTML='<main>'+html+'</main>';const ui=domPage();
  await expect(observePublicNavigationUIContent(ui.page,scenario(actor,[],[{kind:'open-details',selector:'.disclosure'}]),actor,ui.remaining)).rejects.toThrow(/disclosure/);expect(ui.clicks).toEqual([]);
 }
});
it('preserves an already-open disclosure and propagates the exact caller deadline without a second clock',async()=>{
 const actor=inputs().decoded.actorInputs[0],ui=fixtureDOM();document.querySelector('details')!.setAttribute('open','');
 const row=scenario(actor,[],[{kind:'open-details',selector:'#native-detail'}]);await observePublicNavigationUIContent(ui.page,row,actor,ui.remaining);expect(ui.clicks).toEqual([]);
 ui.expire();await expect(observePublicNavigationUIContent(ui.page,row,actor,ui.remaining)).rejects.toThrow('same original scenario deadline');expect(ui.clicks).toEqual([]);
});
it('refuses wrong actor/role or source destination-address pair expectations before any DOM action',async()=>{
 const actor=inputs().decoded.actorInputs[0],row=scenario(actor,[]),ui=fixtureDOM();
 for(const changed of [{...actor,actorIndex:250},{...actor,roleLabel:'employee'},{...actor,actorName:'PERF Person 0004'},
  {...actor,routeTargets:[]},{...actor,routeTargets:actor.routeTargets.map(target=>({...target,href:'/wrong'}))}]){
  await expect(observePublicNavigationUIContent(ui.page,row,changed,ui.remaining)).rejects.toThrow(/actor|expectations/);expect(ui.timeouts).toEqual([]);expect(ui.clicks).toEqual([]);
 }
 await expect(observePublicNavigationUIContent(ui.page,{...row,role:'employee'},actor,ui.remaining)).rejects.toThrow('expectations');expect(ui.timeouts).toEqual([]);
});
it('does not invent saved history for a decoded none-history actor or accept an unknown expected fixture field',async()=>{
 const actor=inputs().decoded.actorInputs[0];expect(actor.history).toEqual({kind:'none'});
 for(const expected of ['$fixture.firstSavedHistoryTitle','$fixture.unknown']){document.body.innerHTML='<main><div id="text">Any heading</div></main>';const ui=domPage();
  await expect(observePublicNavigationUIContent(ui.page,scenario(actor,[{id:'history',kind:'text',selector:'#text',expected}]),actor,ui.remaining)).rejects.toThrow(/unseeded|Unknown/);
 }
});
it('keeps the common UI owner free of private readers, native admission, session/context creation and load-state evidence',()=>{
 const source=readFileSync(new URL('../scripts/performance/navigation-browser-ui.ts',import.meta.url),'utf8');
 expect(source).not.toMatch(/node:(?:fs|path|child_process)|process\.|WeakMap|WeakSet|readFile|openSync|fixture\.json|\.context\(|newPage|cookies\(|performance\.now|loadState|active:500|internalSessionObserved|fixtureIdentityObserved|releaseAuthorized/);
 const collector=readFileSync(new URL('../scripts/performance/navigation-browser-capture.ts',import.meta.url),'utf8');
 expect(collector).toContain('const checks=await observeNavigationUIContent(page,scenario,actorIndex,bindings,remaining);');
 expect(collector).toContain("const cookies=await page.context().cookies(BASE);");expect(collector).toContain("page.off('response',response);page.off('pageerror',pageError);page.off('console',consoleError);");
 expect(plan.scenarios).toHaveLength(52);expect(new Set(plan.scenarios.map(row=>row.destinationId)).size).toBe(14);
});
