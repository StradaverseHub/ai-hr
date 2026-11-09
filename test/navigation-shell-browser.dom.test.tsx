// @vitest-environment jsdom
/** DOM adapter controls only. These do not qualify an actual application/browser. */
import {afterEach,expect,it} from 'vitest';
import type {Page} from 'playwright';
import {clickNativeShellDestination,assertNativeShellDestinationHidden} from '../scripts/performance/navigation-shell-browser';
class DomLocator {
 constructor(private readonly nodes:()=>Element[],private readonly afterCount?:(count:number)=>void){}
 async count(){const count=this.nodes().length;this.afterCount?.(count);return count;}
 nth(index:number){return new DomLocator(()=>this.nodes().slice(index,index+1));}
 async isVisible(){const node=this.single();for(let p:Element|null=node;p;p=p.parentElement)if(p.hasAttribute('hidden'))return false;return true;}
 async isEnabled(){return !this.single().hasAttribute('disabled');}
 async getAttribute(name:string){return this.single().getAttribute(name);}
 async click(){expect(await this.isVisible()).toBe(true);expect(await this.isEnabled()).toBe(true);(this.single()as HTMLElement).click();}
 async waitFor(){expect(this.nodes()).toHaveLength(1);expect(await this.isVisible()).toBe(true);}
 and(other:DomLocator){return new DomLocator(()=>this.nodes().filter(n=>other.nodes().includes(n)));}
 locator(selector:string){return new DomLocator(()=>Array.from(this.single().querySelectorAll(selector)));}
 private single(){expect(this.nodes()).toHaveLength(1);return this.nodes()[0];}
}
const page=(afterTargetCount?:(count:number)=>void)=>({locator:(selector:string)=>new DomLocator(()=>Array.from(document.querySelectorAll(selector)),selector.includes(' a[href=')?afterTargetCount:undefined)})as unknown as Page;
afterEach(()=>{document.body.replaceChildren();});
function fixture({duplicate=false,denied=false}={}){
 document.body.innerHTML=`<main><button aria-expanded="false" aria-controls="danger">Save employment</button></main>
 <aside data-app-sidebar><div role="group"><button aria-pressed="true">Ops</button><button aria-pressed="false">Strata</button></div>
 <nav data-tour="nav"><button aria-controls="nav-flyout-insights" aria-expanded="false" hidden>Insights</button></nav></aside>
 <div id="nav-flyout-insights" hidden><nav><button aria-controls="nested" aria-expanded="false">Reports</button>
 <div id="nested" hidden>${denied?'':'<a href="/analytics">Analytics</a>'}${duplicate?'<a href="/analytics">Duplicate</a>':''}</div></nav></div>`;
 const clicks:string[]=[];
 document.querySelector('main button')!.addEventListener('click',()=>{throw Error('Non-navigation effect control was clicked');});
 const workspace=document.querySelector('button[aria-pressed="false"]')!,old=document.querySelector('button[aria-pressed="true"]')!;
 workspace.addEventListener('click',()=>{clicks.push('workspace');workspace.setAttribute('aria-pressed','true');old.setAttribute('aria-pressed','false');document.querySelector('[aria-controls="nav-flyout-insights"]')!.removeAttribute('hidden');});
 for(const button of document.querySelectorAll('nav button[aria-controls]'))button.addEventListener('click',()=>{
  const id=button.getAttribute('aria-controls')!;clicks.push(id);button.setAttribute('aria-expanded','true');document.getElementById(id)!.removeAttribute('hidden');
 });
 for(const link of document.querySelectorAll('nav a'))link.addEventListener('click',event=>{event.preventDefault();clicks.push('destination');});
 return clicks;
}
it('clicks the actual rendered workspace, module, nested disclosure and destination in order',async()=>{
 const clicks=fixture();await clickNativeShellDestination(page(),'/analytics',()=>90000);
 expect(clicks).toEqual(['workspace','nav-flyout-insights','nested','destination']);
 expect(document.querySelector('main button')!.getAttribute('aria-expanded')).toBe('false');
});
it('refuses duplicate and absent destinations without clicking any substitute route',async()=>{
 const clicks=fixture({duplicate:true});await expect(clickNativeShellDestination(page(),'/analytics',()=>90000)).rejects.toThrow('ambiguous');expect(clicks).not.toContain('destination');
 const denied=fixture({denied:true});await expect(clickNativeShellDestination(page(),'/analytics',()=>90000)).rejects.toThrow('absent');expect(denied).not.toContain('destination');
});
it('refuses invalid addresses and obeys the caller deadline before traversing disclosures',async()=>{
 const clicks=fixture();await expect(clickNativeShellDestination(page(),'https://outside.invalid',()=>90000)).rejects.toThrow('reviewed static');
 await expect(clickNativeShellDestination(page(),'/analytics',()=>{throw Error('original deadline');})).rejects.toThrow('original deadline');expect(clicks).toEqual([]);
});

it('observes absence through every native workspace/disclosure before a separate direct-route refusal',async()=>{
 const clicks=fixture({denied:true});await assertNativeShellDestinationHidden(page(),'/analytics',()=>90000);
 expect(clicks).toEqual(['workspace','nav-flyout-insights','nested']);
 expect(document.querySelector('main button')!.getAttribute('aria-expanded')).toBe('false');
});
it('rejects visible, collapsed, disabled and later-mounted native destination anchors as hidden proof',async()=>{
 for(const state of ['collapsed','visible','disabled','later-mounted']){
  const clicks=fixture({denied:state==='later-mounted'});
  const anchor=document.querySelector('nav a');
  if(state==='visible'){document.getElementById('nav-flyout-insights')!.removeAttribute('hidden');document.getElementById('nested')!.removeAttribute('hidden');}
  if(state==='disabled')anchor!.setAttribute('aria-disabled','true');
  if(state==='later-mounted')document.querySelector('[aria-controls="nested"]')!.addEventListener('click',()=>{document.getElementById('nested')!.innerHTML='<a href="/analytics">Newly mounted</a>';});
  await expect(assertNativeShellDestinationHidden(page(),'/analytics',()=>90000)).rejects.toThrow('still rendered');
  expect(clicks).not.toContain('destination');
 }
});
it('keeps the original caller deadline and traversal bound for hidden observations',async()=>{
 const clicks=fixture({denied:true});await expect(assertNativeShellDestinationHidden(page(),'/analytics',()=>{throw Error('same original deadline');})).rejects.toThrow('same original deadline');
 expect(clicks).toEqual([]);
});

it('refuses a destination mounted after the zero-count snapshot and before the visible read without clicking it',async()=>{
 const clicks=fixture({denied:true});let mounted=false,zeroSnapshotObserved=false;
 const racingPage=page(count=>{
  if(mounted)return;expect(count).toBe(0);zeroSnapshotObserved=true;mounted=true;
  const anchor=document.createElement('a');anchor.href='/analytics';anchor.textContent='Mounted between awaited reads';
  anchor.addEventListener('click',event=>{event.preventDefault();clicks.push('racing-destination');});
  document.querySelector('aside nav')!.append(anchor);
 });
 await expect(assertNativeShellDestinationHidden(racingPage,'/analytics',()=>90000)).rejects.toThrow('became visible');
 expect(zeroSnapshotObserved).toBe(true);expect(mounted).toBe(true);expect(clicks).not.toContain('racing-destination');expect(clicks).not.toContain('destination');
});
it('rechecks mounted-anchor absence when a hidden anchor appears after the final visible-count snapshot',async()=>{
 const clicks=fixture({denied:true});let targetReads=0,mounted=false;
 const racingPage=page(count=>{
  targetReads++;if(targetReads!==2)return;expect(count).toBe(0);mounted=true;
  const anchor=document.createElement('a');anchor.href='/analytics';anchor.hidden=true;
  anchor.addEventListener('click',event=>{event.preventDefault();clicks.push('late-hidden-destination');});
  document.querySelector('aside nav')!.append(anchor);
 });
 await expect(assertNativeShellDestinationHidden(racingPage,'/analytics',()=>90000)).rejects.toThrow('before native workspace observation completed');
 expect(mounted).toBe(true);expect(clicks).not.toContain('late-hidden-destination');expect(clicks).not.toContain('destination');
});

function appendDisabledDestination(root:Element,href:string){
 const row=document.createElement('span');
 row.setAttribute('aria-disabled','true');
 row.setAttribute('data-shell-destination',href);
 const label=document.createElement('span');
 label.textContent='Locked destination';row.append(label);root.append(row);
 return row;
}
it('rejects the actual disabled span shape in each mounted sidebar or flyout root',async()=>{
 for(const selector of ['aside nav','#nav-flyout-insights nav','#atelier-flyout-insights nav']){
  const clicks=fixture({denied:true});
  if(selector.startsWith('#atelier'))document.body.insertAdjacentHTML('beforeend','<div id="atelier-flyout-insights" hidden><nav></nav></div>');
  const row=appendDisabledDestination(document.querySelector(selector)!,'/analytics');
  expect(row.tagName).toBe('SPAN');expect(row.hasAttribute('href')).toBe(false);
  await expect(assertNativeShellDestinationHidden(page(),'/analytics',()=>90000)).rejects.toThrow('still rendered');
  expect(clicks).toEqual([]);
 }
});
it('keeps destination identity exact and scoped, and follows only actual hrefs when clicking',async()=>{
 const clicks=fixture({denied:true});
 const rail=document.querySelector('aside nav')!;
 appendDisabledDestination(rail,'/analytics-settings');
 appendDisabledDestination(rail,'/insights/analytics');
 appendDisabledDestination(document.querySelector('main')!,'/analytics');
 await assertNativeShellDestinationHidden(page(),'/analytics',()=>90000);
 expect(clicks).toEqual(['workspace','nav-flyout-insights','nested']);

 const aliasClicks=fixture({denied:true});
 const alias=document.createElement('a');alias.href='/another-route';alias.setAttribute('data-shell-destination','/analytics');
 alias.addEventListener('click',event=>{event.preventDefault();aliasClicks.push('alias');});document.querySelector('aside nav')!.append(alias);
 await expect(assertNativeShellDestinationHidden(page(),'/analytics',()=>90000)).rejects.toThrow('still rendered');
 await expect(clickNativeShellDestination(page(),'/analytics',()=>90000)).rejects.toThrow('absent');
 expect(aliasClicks).not.toContain('alias');
 alias.setAttribute('href','/analytics');alias.setAttribute('data-shell-destination','/another-route');
 await expect(assertNativeShellDestinationHidden(page(),'/analytics',()=>90000)).rejects.toThrow('still rendered');
});
it('refuses malformed disabled identities and selector inputs before clicking disclosures',async()=>{
 for(const identity of [null,'','//analytics','/analytics/','/analytics\n','/analytics"]']){
  const clicks=fixture({denied:true});
  const row=appendDisabledDestination(document.querySelector('aside nav')!,identity??'/analytics');
  if(identity===null)row.removeAttribute('data-shell-destination');
  await expect(assertNativeShellDestinationHidden(page(),'/analytics',()=>90000)).rejects.toThrow('no valid identity');
  if(identity)await expect(assertNativeShellDestinationHidden(page(),identity,()=>90000)).rejects.toThrow('reviewed static');
  expect(clicks).toEqual([]);
 }
 const clicks=fixture({denied:true});
 const wrongState=appendDisabledDestination(document.querySelector('aside nav')!,'/another-route');
 wrongState.setAttribute('aria-disabled','false');
 await expect(assertNativeShellDestinationHidden(page(),'/analytics',()=>90000)).rejects.toThrow('no valid identity');
 expect(clicks).toEqual([]);
});
it('rechecks mounted disabled spans after the final visible-count snapshot',async()=>{
 const clicks=fixture({denied:true});let targetReads=0;
 const racingPage=page(count=>{
  if(++targetReads!==2)return;
  expect(count).toBe(0);
  const row=appendDisabledDestination(document.querySelector('aside nav')!,'/analytics');
  row.hidden=true;
  row.addEventListener('click',()=>clicks.push('disabled-destination'));
 });
 await expect(assertNativeShellDestinationHidden(racingPage,'/analytics',()=>90000)).rejects.toThrow('before native workspace observation completed');
 expect(targetReads).toBe(3);expect(clicks).toEqual([]);
});
