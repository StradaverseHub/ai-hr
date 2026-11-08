// @vitest-environment jsdom
/** DOM adapter controls only. These do not qualify an actual application/browser. */
import {afterEach,expect,it} from 'vitest';
import type {Page} from 'playwright';
import {clickNativeShellDestination} from '../scripts/performance/navigation-shell-browser';
class DomLocator {
 constructor(private readonly nodes:()=>Element[]){}
 async count(){return this.nodes().length;}
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
const page=()=>({locator:(selector:string)=>new DomLocator(()=>Array.from(document.querySelectorAll(selector)))})as unknown as Page;
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
