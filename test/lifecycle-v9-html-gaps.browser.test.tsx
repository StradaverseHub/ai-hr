import {afterEach,expect,it,vi} from 'vitest';
import {page,userEvent} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {UiThemeProvider} from '../components/ui-theme-context';
import {v9HtmlWorkspace} from './helpers/v9-html-fixture';
import type {V9WorkspaceView} from '../lib/lifecycle-v9-navigation';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/onboarding-workspace.css';
import '../app/lifecycle/v9/workspace.css';
const saves=vi.hoisted(()=>vi.fn());
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/v9',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('next/link',async()=>{const React=await import('react');return {default:({prefetch,...props}:any)=>React.createElement('a',props,props.children)};});
vi.mock('../components/user-menu',()=>({UserMenu:()=> <button>Account menu</button>}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn(),readV9Case:vi.fn(),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:saves,setupV9:vi.fn()}));
vi.mock('../app/lifecycle/onboarding/v31-actions',()=>({changeOnboarding:vi.fn(),saveOnboardingConfig:vi.fn(),saveOnboardingChecklistTasks:vi.fn(),writeOnboardingNote:vi.fn(),setupOnboarding:vi.fn(),loadOnboardingTask:vi.fn(),markOnboardingSeen:vi.fn()}));
const {V9Workspace}=await import('../app/lifecycle/v9/workspace');
afterEach(async()=>{cleanup();vi.clearAllMocks();document.documentElement.removeAttribute('data-ui-theme');document.documentElement.classList.remove('dark');await page.viewport(1280,720);});
function workspace(theme:'classic'|'monolith'|'atelier',view:V9WorkspaceView) {
 return <UiThemeProvider theme={theme}><NextIntlClientProvider locale="en" messages={messages}><div data-app-content className="p-6"><V9Workspace navigation="global" initialView={view} companyScope={['alpha','beta']} viewer={{name:'Fictional HR',employeeCode:null,employed:false}} initial={v9HtmlWorkspace()}/></div></NextIntlClientProvider></UiThemeProvider>;
}
function contrast(a:string,b:string) {
 const luminance=(s:string)=>{const rgb=s.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
/** DIAGNOSTIC COPY ONLY. Observe existing actions; no extra focus, key, click, retry or wait. */
function observeKeyboard(route:string){
 const kind='MEASURED_COPY_NOT_ORIGINAL_OR_RELEASE',events:Record<string,unknown>[]=[],ids=new WeakMap<Element,number>();let sequence=0,selected:HTMLElement|null=null;
 const identify=(value:EventTarget|null)=>{const element=value instanceof Element?value:null;if(element&&!ids.has(element))ids.set(element,++sequence);return element?{node:ids.get(element),tag:element.tagName,label:element.getAttribute('aria-label'),controls:element.getAttribute('aria-controls')}:null;};
 const record=(phase:string,event?:Event)=>{
  if(events.length>=512)return;const current=document.querySelector<HTMLElement>('button[aria-label="Assignment rules"]');let parentActive:unknown=null;try{const parent=window.parent.document.activeElement;parentActive=parent?{tag:parent.tagName,label:parent.getAttribute('aria-label'),isOwnFrame:parent===window.frameElement}:null;}catch{parentActive='unavailable';}
  events.push({phase,at:performance.now(),wall:Date.now(),route,documentFocused:document.hasFocus(),visibility:document.visibilityState,active:identify(document.activeElement),parentActive,selected:identify(selected),selectedConnected:selected?.isConnected??null,current:identify(current),sameCurrent:selected===current,expanded:selected?.getAttribute('aria-expanded'),currentExpanded:current?.getAttribute('aria-expanded'),rect:selected?.getBoundingClientRect().toJSON(),scroll:[window.scrollX,window.scrollY],viewport:[window.innerWidth,window.innerHeight],...(event?{type:event.type,trusted:event.isTrusted,defaultPrevented:event.defaultPrevented,target:identify(event.target),key:event instanceof KeyboardEvent?event.key:null,code:event instanceof KeyboardEvent?event.code:null,repeat:event instanceof KeyboardEvent?event.repeat:null}:{} )});
 };
 const captured=(event:Event)=>record('captured-event',event),bubbled=(event:Event)=>record('bubbled-event',event),windowEvent=(event:Event)=>record('window-event',event);
 const types=['focusin','focusout','keydown','keypress','keyup','click'];for(const type of types){document.addEventListener(type,captured,true);document.addEventListener(type,bubbled);}
 window.addEventListener('focus',windowEvent);window.addEventListener('blur',windowEvent);
 const observer=new MutationObserver(changes=>{if(changes.some(change=>change.type==='childList'||change.target===selected))record('observed-dom-change');});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-expanded']});record('before-existing-render');
 return{bind:(button:HTMLElement)=>{selected=button;record('existing-button-selected');},record,finish:()=>{
  record('after-existing-route-or-failure');observer.disconnect();for(const type of types){document.removeEventListener(type,captured,true);document.removeEventListener(type,bubbled);}window.removeEventListener('focus',windowEvent);window.removeEventListener('blur',windowEvent);
  console.info('V9_CAUSAL_TRACE '+JSON.stringify({kind,route,events}));
  // Capture AFTER the existing assertions/failure, so image RPC cannot change the failing key step.
  if(route==='offChecklists')return page.screenshot({base64:true,animations:'disabled',scale:'css'}).then(shot=>{console.info('V9_CAUSAL_IMAGE '+JSON.stringify({kind,route,base64:shot.base64}));}).catch(error=>{console.info('V9_CAUSAL_CAPTURE_FAILURE '+JSON.stringify({kind,route,error:String(error)}));});
 }};
}
for(const theme of ['classic','monolith','atelier'] as const)for(const dark of [false,true])for(const mobile of [false,true]) {
 it(`repairs reference details, keyboard sections, notice and duplicate chrome in ${theme} ${dark?'dark':'light'} ${mobile?'mobile':'desktop'}`,async()=>{
  await page.viewport(mobile?390:1512,mobile?844:805);document.documentElement.setAttribute('data-ui-theme',theme);document.documentElement.classList.toggle('dark',dark);
  const view=render(workspace(theme,'leavers'));
  const notice=screen.getByText('Start a case from the employee record, review the checklist and confirm the case to begin assignments and workflows.');
  await expect.poll(()=>contrast(getComputedStyle(notice).color,getComputedStyle(notice).backgroundColor)).toBeGreaterThanOrEqual(4.5);
  console.info('V9_NOTICE_CONTRAST '+JSON.stringify({theme,dark,mobile,foreground:getComputedStyle(notice).color,background:getComputedStyle(notice).backgroundColor,ratio:contrast(getComputedStyle(notice).color,getComputedStyle(notice).backgroundColor)}));
  for(const route of ['joiners','leavers','onbChecklists','offChecklists','templates','workflows','settings','groups','access'] as const){view.rerender(workspace(theme,route));expect(document.querySelector('.v9-toolbar')).toBeNull();expect(screen.queryByRole('combobox',{name:'Company'})).toBeNull();expect(screen.queryByRole('button',{name:'Account menu'})).toBeNull();expect(document.documentElement.scrollWidth).toBeLessThanOrEqual((mobile?390:1512)+1);}
  for(const route of ['onbChecklists','offChecklists'] as const){
   const observation=theme==='atelier'&&!dark&&mobile?observeKeyboard(route):null;
   try{
   view.rerender(workspace(theme,route));const details=screen.getByRole('region',{name:'Checklist details'}),name=within(details).getByRole('textbox',{name:'Checklist name'}),duplicate=within(details).getByRole('button',{name:'Duplicate'}),owner=within(details).getByRole('button',{name:'Change owner'});
   const n=name.getBoundingClientRect(),d=duplicate.getBoundingClientRect(),o=owner.getBoundingClientRect();
   expect(contrast(getComputedStyle(owner).color,getComputedStyle(details).backgroundColor)).toBeGreaterThanOrEqual(4.5);
   expect(n.width).toBeGreaterThan(200);expect(d.width).toBeGreaterThan(50);
   if(!mobile){expect(Math.abs(n.top-d.top)).toBeLessThan(2);expect(d.left-n.right).toBeGreaterThanOrEqual(15);expect(d.left-n.right).toBeLessThanOrEqual(17);expect(o.left).toBeGreaterThan(d.right);expect(o.top).toBeLessThan(n.top);}
   else {for(const rect of [n,d,o]){expect(rect.left).toBeGreaterThanOrEqual(0);expect(rect.right).toBeLessThanOrEqual(391);}expect(d.top).toBeGreaterThan(n.bottom);}
   const rules=screen.getByRole('button',{name:'Assignment rules'}),tasks=screen.getByRole('button',{name:'Tasks'});
   observation?.bind(rules);
   expect(rules.getAttribute('aria-expanded')).toBe('false');expect(tasks.getAttribute('aria-expanded')).toBe('true');
   rules.focus();await expect.poll(()=>document.activeElement).toBe(rules);observation?.record('before-existing-Enter');await userEvent.keyboard('{Enter}');observation?.record('after-existing-Enter');
   const rulesAtKeyReturn=rules.getAttribute('aria-expanded');await expect.poll(()=>rules.getAttribute('aria-expanded')).toBe('true');expect(screen.getByText(/Population preview/)).toBeVisible();
   console.info('V9_KEYBOARD_COMMIT '+JSON.stringify({theme,dark,mobile,route,atKeyReturn:rulesAtKeyReturn,committed:rules.getAttribute('aria-expanded'),focused:document.activeElement===rules}));
   tasks.focus();await expect.poll(()=>document.activeElement).toBe(tasks);await userEvent.keyboard(' ');await expect.poll(()=>tasks.getAttribute('aria-expanded')).toBe('false');expect(screen.queryAllByRole('textbox',{name:'Task name'})).toHaveLength(0);
   await userEvent.keyboard('{Enter}');await expect.poll(()=>tasks.getAttribute('aria-expanded')).toBe('true');expect(screen.getAllByRole('textbox',{name:'Task name'}).length).toBeGreaterThan(0);
   rules.focus();await expect.poll(()=>document.activeElement).toBe(rules);await userEvent.keyboard('{Enter}');await expect.poll(()=>rules.getAttribute('aria-expanded')).toBe('false');
   console.info('V9_CHECKLIST_GEOMETRY '+JSON.stringify({theme,dark,mobile,route,name:n.toJSON(),duplicate:d.toJSON(),owner:o.toJSON()}));
   // Fictional derived fixture only, never labelled as staging or the reference artifact.
   name.focus();const shot=await page.screenshot({base64:true,path:`../.vitest-attachments/v9-html-gaps-${theme}-${dark?'dark':'light'}-${mobile?'mobile':'desktop'}-${route}.png`,animations:'disabled',scale:'css'});console.info('V9_HTML_GAPS_SCREENSHOT '+JSON.stringify({theme,dark,mobile,route,fixture:'fictional-derived-not-staging',base64:shot.base64}));
   }finally{const image=observation?.finish();if(image)await image;}
  }
  expect(saves).not.toHaveBeenCalled();
 });
}
