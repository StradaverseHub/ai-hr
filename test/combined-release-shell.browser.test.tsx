/**
 * Real production components and compiled CSS in a fictional session shell. The copied server-shell
 * class strings are independently pinned by combined-release-shell-contract.test.ts. This establishes
 * component/CSS compatibility, not a live authenticated page, server-data or human acceptance result.
 */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import type {ReactNode,ComponentProps,MouseEvent} from 'react';
import en from '../messages/en.json';
import geometry from './fixtures/combined-release-shell-geometry.json';
import {NavIndexProvider,useNavIndex} from '../components/nav-index-context';
import {UiThemeProvider} from '../components/ui-theme-context';
import type {UiTheme} from '../lib/ui-theme';
import {pageState,parsePageQuery} from '../lib/pagination';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/login/login.css';

const ports=vi.hoisted(()=>({path:'/admin/personnel',search:'q=Fictional&size=25',replace:vi.fn(),push:vi.fn(),scope:vi.fn(),ask:vi.fn(),delegation:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>ports.path,useSearchParams:()=>new URLSearchParams(ports.search),useRouter:()=>({replace:ports.replace,push:ports.push,refresh:vi.fn()})}));
vi.mock('../components/intent-link',async()=>{const React=await import('react');function Link({prefetch:_prefetch,...props}:ComponentProps<'a'>&{prefetch?:boolean}){return React.createElement('a',{...props,onClick:(event:MouseEvent<HTMLAnchorElement>)=>{event.preventDefault();props.onClick?.(event);}});}return{default:Link,IntentLink:Link};});
vi.mock('@/app/scope-actions',()=>({setCompanyScope:ports.scope}));
vi.mock('@/app/assistant/actions',()=>({askAssistantAction:ports.ask}));
vi.mock('@/app/delegations/actions',()=>({loadDelegationContextAction:ports.delegation}));
vi.mock('@/components/delegation-manager',()=>({DelegationManager:()=>null}));
const {Sidebar}=await import('../components/sidebar');
const {ShellRoutePath}=await import('../components/shell-top-line');
const {CompanySwitcher}=await import('../components/company-switcher');
const {CommandBar}=await import('../components/command-bar');
const {ClientPager}=await import('../components/client-pager');
const {PageHeader}=await import('../components/ui');
const {InternalAuthForm}=await import('../app/login/internal-form');
const {WorkspaceComposer}=await import('../components/assistant/workspace-composer');
const {AtelierAskBox}=await import('../components/atelier-ask-box');
const themes:UiTheme[]=['atelier','classic','monolith'];
const companies=[{id:'fictional-a',name:'Fictional Company A'},{id:'fictional-b',name:'Fictional Company B'}];
const initialBodyClass=document.body.className;
const tick=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
const box=(element:Element)=>element.getBoundingClientRect();
function providers(theme:UiTheme,children:ReactNode){return <NextIntlClientProvider locale="en" messages={en}><UiThemeProvider theme={theme}><NavIndexProvider>{children}</NavIndexProvider></UiThemeProvider></NextIntlClientProvider>;}
function NavProbe(){const index=useNavIndex();return <output data-testid="nav-inventory" hidden>{JSON.stringify(index.entries)}</output>;}
function Screen({theme,title='Fictional personnel',admin=true}:{theme:UiTheme;title?:string;admin?:boolean}){
 const query=parsePageQuery(Object.fromEntries(new URLSearchParams(ports.search)));
 const state=pageState(query,100,25);
 return providers(theme,<div data-app-shell className={geometry.shell}>
  <Sidebar isAdmin={admin} canApprove={admin} enabledModules={null} defaultCollapsed={false}/>
  <div data-app-content className={geometry.content}>
   <header data-app-header className={geometry.header}>
    <div className="flex min-w-0 items-center gap-2"><ShellRoutePath/><CompanySwitcher companies={companies} selected={['fictional-a']}/></div>
    <CommandBar/><span className="text-xs">Fictional reviewer</span>
   </header>
   <main className={geometry.main} data-testid="release-main"><div className="space-y-4">
    <PageHeader title={title} description="Fictional fixture: production components and CSS; no server session or HR data." actions={<><label className="sr-only" htmlFor="fixture-search">Find fictional rows</label><input id="fixture-search" aria-label="Find fictional rows" className="max-w-full rounded border px-2 py-1" defaultValue="Fictional"/><button type="button" className="rounded border px-2 py-1">Read-only action</button></>}/>
    <ClientPager state={state}/>
    <table className="w-full text-sm"><thead><tr><th>Fictional row</th></tr></thead><tbody>{Array.from({length:25},(_,i)=><tr key={i} style={{height:40}}><td>{`Fictional row ${state.from+i}`}</td></tr>)}</tbody></table>
    <NavProbe/>
   </div></main>
  </div>
 </div>);
}
async function mount(theme:UiTheme,width:number,dark=false,admin=true,title='Fictional personnel'){
 await page.viewport(width,844);document.documentElement.setAttribute('data-ui-theme',theme);document.documentElement.classList.toggle('dark',dark);document.body.className=geometry.body;
 const view=render(<Screen theme={theme} admin={admin} title={title}/>);view.container.style.height='100%';await tick();return view;
}
async function capture(name:string,element:Element){
 const wrapper=window.frameElement?.parentElement,style=wrapper?.getAttribute('style'),scale=wrapper?.getAttribute('data-scale');
 wrapper?.style.setProperty('transform','none','important');wrapper?.setAttribute('data-scale','1');
 try{
  const shot=await page.screenshot({element,path:`../.vitest-attachments/combined-${name}.png`,animations:'disabled',scale:'css',base64:true,style:'#vitest-tester [data-scale], #tester-ui [data-scale] {transform:none!important}'});
  const bytes=Uint8Array.from(atob(shot.base64),char=>char.charCodeAt(0)),png=new DataView(bytes.buffer);
  expect(png.getUint32(16)).toBe(Math.round(box(element).width));
  console.info('FICTIONAL_COMPONENT_CAPTURE',{path:shot.path,width:png.getUint32(16),height:png.getUint32(20)});
 }finally{if(wrapper){if(style==null)wrapper.removeAttribute('style');else wrapper.setAttribute('style',style);if(scale==null)wrapper.removeAttribute('data-scale');else wrapper.setAttribute('data-scale',scale);}}
}
afterEach(async()=>{
 cleanup();await new Promise<void>(resolve=>setTimeout(resolve,0));
 document.body.className=initialBodyClass;document.documentElement.removeAttribute('data-ui-theme');document.documentElement.classList.remove('dark');
 ports.path='/admin/personnel';ports.search='q=Fictional&size=25';vi.clearAllMocks();vi.unstubAllGlobals();await page.viewport(1280,844);
});

describe('isolated combined release: actual shell CSS and controls',()=>{
 for(const theme of themes)for(const width of [390,639,640,1280])for(const dark of [false,true])it(`${theme} ${width} ${dark?'dark':'light'} keeps real scrolling, header actions and page chrome`,async()=>{
  await mount(theme,width,dark);
  const main=screen.getByTestId('release-main'),header=main.querySelector('[data-page-header]')!;
  expect(main.scrollHeight).toBeGreaterThan(main.clientHeight+250);expect(main.clientHeight).toBeGreaterThan(80);
  if(!dark&&width===1280)await capture(`${theme}-initial-pager`,document.querySelector('[data-app-shell]')!);
  main.scrollTop=420;await tick();expect(main.scrollTop).toBeGreaterThan(300);
  expect(getComputedStyle(header).position).toBe(width>=640?'sticky':'static');
  if(width>=640){expect(box(header).top).toBeGreaterThanOrEqual(box(main).top-1);expect(box(header).bottom).toBeLessThan(box(main).bottom);expect(box(screen.getByLabelText('Find fictional rows')).bottom).toBeLessThan(box(main).bottom);if(theme==='atelier')expect(getComputedStyle(header).boxShadow).not.toBe('none');}
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width+1);
  if(!dark||width===390)await capture(`${theme}-${width}-${dark?'dark':'light'}-scroll`,document.querySelector('[data-app-shell]')!);
 });
 for(const theme of themes)it(`${theme} preserves filters while the real pager advances to rows 26–50`,async()=>{
  const view=await mount(theme,1280);const pager=document.querySelector('[data-ui-pager]')!;
  const next=within(pager as HTMLElement).getByRole('button',{name:theme==='atelier'?en.pagination.nextPage:en.pagination.next});
  expect(box(pager).bottom).toBeLessThanOrEqual(box(screen.getByRole('table')).top+1);fireEvent.click(next);
  expect(ports.replace).toHaveBeenCalledOnce();const [url,options]=ports.replace.mock.calls[0];const sp=new URLSearchParams(String(url).slice(1));expect(Object.fromEntries(sp)).toEqual({q:'Fictional',size:'25',page:'1'});expect(options).toEqual({scroll:false});
  ports.search=String(url).slice(1);view.rerender(<Screen theme={theme}/>);expect(screen.getByText('Fictional row 26')).toBeVisible();expect(screen.queryByText('Fictional row 1')).toBeNull();
 });
 it('uses actual rail destinations for module/list links and follows the real h1 when a record changes',async()=>{
  ports.path='/attendance/individual/2026-10-29';const view=await mount('atelier',1280,false,true,'Fictional attendance A');
  const crumb=await screen.findByRole('navigation',{name:en.topbar.breadcrumb});
  await waitFor(()=>expect(crumb.querySelector('[aria-current=page]')?.textContent).toBe('Fictional attendance A'));
  const hrefs=Array.from(crumb.querySelectorAll('a')).map(link=>link.getAttribute('href'));expect(hrefs).toContain('/attendance');expect(hrefs).toContain('/attendance/clock');
  // A streamed route can commit its new pathname before the previous heading is replaced.
  ports.path='/attendance/individual/2026-10-30';view.rerender(<Screen theme="atelier" title="Fictional attendance A"/>);await tick();
  view.rerender(<Screen theme="atelier" title="Fictional attendance B"/>);
  await waitFor(()=>expect(crumb.querySelector('[aria-current=page]')?.textContent).toBe('Fictional attendance B'));expect(crumb.textContent).not.toContain('Fictional attendance A');
  await capture('atelier-final-record-b',document.querySelector('[data-app-shell]')!);
 });
 it('updates a renamed heading on the same path and clears a removed or empty heading',async()=>{
  ports.path='/attendance/individual/2026-10-29';const view=await mount('atelier',1280,false,true,'Fictional attendance A');
  const crumb=await screen.findByRole('navigation',{name:en.topbar.breadcrumb});const current=()=>crumb.querySelector('[aria-current=page]')?.textContent;
  await waitFor(()=>expect(current()).toBe('Fictional attendance A'));
  view.rerender(<Screen theme="atelier" title="Fictional renamed attendance"/>);
  await waitFor(()=>expect(current()).toBe('Fictional renamed attendance'));
  view.rerender(<Screen theme="atelier" title=""/>);await waitFor(()=>expect(current()).toBe(en.topbar.details));
  const header=screen.getByTestId('release-main').querySelector('[data-page-header]')!;header.querySelector('h1')!.remove();
  await tick();expect(current()).toBe(en.topbar.details);
  const heading=document.createElement('h1');heading.textContent='Fictional replacement attendance';header.append(heading);
  await waitFor(()=>expect(current()).toBe('Fictional replacement attendance'));
  heading.firstChild!.textContent='Fictional edited text node';await waitFor(()=>expect(current()).toBe('Fictional edited text node'));
 });
 for(const theme of themes)it(`${theme} keeps company and command overlays above the sticky page header without executing actions`,async()=>{
  await mount(theme,1280);const main=screen.getByTestId('release-main');main.scrollTop=400;await tick();
  const company=document.querySelector('[data-company-switcher]') as HTMLButtonElement;fireEvent.click(company);
  const form=company.parentElement!.querySelector('form')!;const bounds=box(form);const top=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+Math.min(35,bounds.height/2));expect(form.contains(top)).toBe(true);expect(ports.scope).not.toHaveBeenCalled();await capture(`${theme}-company-context`,document.querySelector('[data-app-shell]')!);fireEvent.click(company);
  fireEvent.keyDown(window,{key:'k',ctrlKey:true});const dialog=await screen.findByRole('dialog',{name:en.commandBar.open});const rect=box(dialog);expect(dialog.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+25))).toBe(true);expect(rect.right).toBeLessThanOrEqual(window.innerWidth);expect(ports.delegation).not.toHaveBeenCalled();
  await capture(`${theme}-overlays`,document.body);fireEvent.keyDown(dialog,{key:'Escape',code:'Escape'});await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 });
 for(const theme of themes)it(`${theme} employee nav publishes no admin audit/personnel destinations`,async()=>{
  ports.path='/me/payslip';await mount(theme,390,false,false);
  await waitFor(()=>expect(screen.getByTestId('nav-inventory').textContent).toContain('/me/payslip'));
  const entries=JSON.parse(screen.getByTestId('nav-inventory').textContent!) as {href:string}[];expect(entries.length).toBeGreaterThan(3);expect(entries.some(entry=>entry.href.startsWith('/admin/audit')||entry.href.startsWith('/admin/personnel'))).toBe(false);
 });
 for(const theme of themes)it(`${theme} public tour pauses and login remains contained on a phone`,async()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);await page.viewport(1440,900);
  const noRequests=vi.fn(()=>{throw new Error('No authentication request is permitted in this blank fixture');});vi.stubGlobal('fetch',noRequests);
  const view=render(providers(theme,<InternalAuthForm/>));
  const tour=screen.getByRole('region',{name:en.loginTour.label});fireEvent.click(within(tour).getByRole('button',{name:en.loginTour.pause}));expect(within(tour).getByRole('button',{name:en.loginTour.play})).toBeVisible();
  expect(await within(tour).findByText(en.loginTour.leave.open1,{}, {timeout:3000})).toBeVisible();
  fireEvent.click(within(tour).getByRole('button',{name:en.loginTour.leave.pickA1}));
  expect(await within(tour).findByText(en.loginTour.leave.open2,{}, {timeout:4000})).toBeVisible();
  expect(tour.querySelectorAll('ol li:not([data-typing])').length).toBeGreaterThanOrEqual(4);
  await capture(`${theme}-login-tour`,view.container.querySelector('main')!);
  fireEvent.click(within(tour).getByRole('button',{name:en.loginTour.pay.topic}));
  expect(await within(tour).findByText(en.loginTour.pay.open1,{}, {timeout:3000})).toBeVisible();
  fireEvent.click(within(tour).getByRole('button',{name:en.loginTour.play}));expect(within(tour).getByRole('button',{name:en.loginTour.pause})).toBeVisible();fireEvent.click(within(tour).getByRole('button',{name:en.loginTour.pause}));
  await page.viewport(390,844);await tick();const button=screen.getByRole('button',{name:en.internalAuth.signIn});expect(box(button).left).toBeGreaterThanOrEqual(0);expect(box(button).right).toBeLessThanOrEqual(390);expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  expect(screen.getByLabelText(en.internalAuth.password)).toHaveValue('');expect(screen.getByLabelText(en.internalAuth.username)).toHaveValue('');expect(noRequests).not.toHaveBeenCalled();await capture(`${theme}-blank-login-phone`,view.container.querySelector('main')!);
 },15000);
 for(const theme of themes)it(`${theme} workspace focus rings the whole composer including Send without submission`,async()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);await page.viewport(390,844);
  render(providers(theme,<main className="p-4"><WorkspaceComposer action={ports.ask} tasks={[]} layout="hero" labels={{tasks:'Tasks',taskHint:'Pick a task',question:'Fictional question',placeholder:'Ask about a fixture',ask:'Send fixture',working:'Working',scope:'Fictional data only'}}/></main>));
  const field=screen.getByLabelText('Fictional question') as HTMLTextAreaElement,frame=document.querySelector('[data-ui-composer]')!,before=getComputedStyle(frame).boxShadow;
  fireEvent.change(field,{target:{value:'A fictional question'}});field.focus();await waitFor(()=>expect(getComputedStyle(frame).boxShadow).not.toBe(before));expect(getComputedStyle(field).outlineStyle).toBe('none');const focusedShadow=getComputedStyle(frame).boxShadow;expect(focusedShadow).not.toBe('none');await capture(`${theme}-composer-textarea`,frame.closest('main')!);
  const send=screen.getByRole('button',{name:'Send fixture'});send.focus();expect(frame.matches(':focus-within')).toBe(true);await waitFor(()=>expect(getComputedStyle(frame).boxShadow).toBe(focusedShadow));expect(box(send).bottom).toBeLessThanOrEqual(box(frame).bottom);expect(ports.ask).not.toHaveBeenCalled();await capture(`${theme}-composer`,frame.closest('main')!);
 });
 it('Atelier home composer also includes its send bar in the focus frame',async()=>{
  document.documentElement.setAttribute('data-ui-theme','atelier');await page.viewport(390,844);
  render(providers('atelier',<main className="p-4"><AtelierAskBox label="Fictional home question" placeholder="Ask about a fixture" submitLabel="Send home fixture" suggestions={[]}/></main>));
  const field=screen.getByLabelText('Fictional home question'),frame=document.querySelector('[data-ui-composer]')!;fireEvent.change(field,{target:{value:'A fictional question'}});field.focus();await tick();const send=screen.getByRole('button',{name:'Send home fixture'});send.focus();expect(frame.matches(':focus-within')).toBe(true);expect(getComputedStyle(field).boxShadow).toBe('none');expect(box(send).bottom).toBeLessThanOrEqual(box(frame).bottom);expect(ports.ask).not.toHaveBeenCalled();expect(getComputedStyle(frame).boxShadow).not.toBe('none');await capture('atelier-home-composer',frame.closest('main')!);
 });
});
