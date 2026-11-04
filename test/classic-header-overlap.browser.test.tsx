/** Real customer-header controls in source-pinned server-shell geometry; no session or HR data. */
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import type {ComponentProps,MouseEvent} from 'react';
import en from '../messages/en.json';
import geometry from './fixtures/combined-release-shell-geometry.json';
import controls from './fixtures/classic-header-controls.json';
import {installTopbarFonts} from './fixtures/topbar-fonts';
import {NavIndexProvider} from '../components/nav-index-context';
import {UiThemeProvider} from '../components/ui-theme-context';
import type {UiTheme} from '../lib/ui-theme';
import '../app/globals.css';
import '../app/onboarding-workspace.css';
import '../app/atelier.css';

const ports=vi.hoisted(()=>({scope:vi.fn(),locale:vi.fn(),logout:vi.fn(),uiTheme:vi.fn(),colorTheme:vi.fn(),markRead:vi.fn(),markAllRead:vi.fn(),refresh:vi.fn(),dark:false}));
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/v9',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:ports.refresh,push:vi.fn(),replace:vi.fn()})}));
// Match the existing shell fixture's inert router boundary; direct next/link imports stay real.
vi.mock('../components/intent-link',async()=>{
 const React=await import('react');
 function FixtureLink({prefetch:_prefetch,...props}:ComponentProps<'a'>&{prefetch?:boolean}){return React.createElement('a',{...props,onClick:(event:MouseEvent<HTMLAnchorElement>)=>{event.preventDefault();props.onClick?.(event);}});}
 return {default:FixtureLink,IntentLink:FixtureLink};
});
vi.mock('@/app/scope-actions',()=>({setCompanyScope:ports.scope}));
vi.mock('@/app/i18n-actions',()=>({setLocale:ports.locale}));
vi.mock('@/app/auth-actions',()=>({logoutAction:ports.logout}));
vi.mock('@/app/ui-theme-actions',()=>({setUiTheme:ports.uiTheme}));
vi.mock('@/app/notification-actions',()=>({markNotificationReadAction:ports.markRead,markAllNotificationsReadAction:ports.markAllRead}));
vi.mock('@/app/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('@/components/delegation-manager',()=>({DelegationManager:()=>null}));
// The color preference action is outside this geometry test; ThemeToggle itself is real.
vi.mock('next-themes',()=>({useTheme:()=>({resolvedTheme:ports.dark?'dark':'light',setTheme:ports.colorTheme})}));
const {Sidebar}=await import('../components/sidebar');
const {ShellRoutePath,ShellLiveClock}=await import('../components/shell-top-line');
const {CompanySwitcher}=await import('../components/company-switcher');
const {CommandBar}=await import('../components/command-bar');
const {NotificationCenter}=await import('../components/notification-center');
const {LanguageSwitcher}=await import('../components/language-switcher');
const {ThemeToggle}=await import('../components/theme-toggle');
const {UserMenu}=await import('../components/user-menu');

const initialBodyClass=document.body.className,initialMargin=document.body.style.margin;
let restoreFonts:(()=>void)|undefined;
beforeAll(async()=>{restoreFonts=await installTopbarFonts();});
afterAll(()=>restoreFonts?.());
afterEach(async()=>{
 cleanup();
 for(const action of [ports.scope,ports.locale,ports.logout,ports.uiTheme,ports.colorTheme,ports.markRead,ports.markAllRead,ports.refresh])expect(action).not.toHaveBeenCalled();
 vi.clearAllMocks();document.body.className=initialBodyClass;document.body.style.margin=initialMargin;
 document.documentElement.removeAttribute('data-ui-theme');document.documentElement.classList.remove('dark');
 await page.viewport(1280,844);
});
const companies=[{id:'fictional-a',name:'Fictional International Manufacturing and Services Company'},{id:'fictional-b',name:'Fictional Company B'}];
const box=(el:Element)=>el.getBoundingClientRect();
const intersects=(a:DOMRect,b:DOMRect)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5;
async function mount(theme:UiTheme,width:number,dark:boolean,longLabels=false){
 await page.viewport(width,844);ports.dark=dark;
 document.documentElement.setAttribute('data-ui-theme',theme);document.documentElement.classList.toggle('dark',dark);
 document.body.className=geometry.body;document.body.style.margin='0';
 const view=render(<NextIntlClientProvider locale="en" messages={en}><UiThemeProvider theme={theme}><NavIndexProvider>
  <div data-app-shell className={geometry.shell}>
   <Sidebar isAdmin={false} canApprove={false} enabledModules={null} defaultCollapsed={false}/>
   <div data-app-content className={geometry.content}>
    <header data-app-header className={geometry.header}>
     <div className={controls.left}>
      <ShellRoutePath/><span data-shell-group-label className={controls.group}>Demo Group</span>
      <CompanySwitcher companies={companies} selected={longLabels?['fictional-a']:['fictional-a','fictional-b']}/><ShellLiveClock/>
     </div>
     <div className={controls.search}><CommandBar/></div>
     <div className={controls.right}>
      <div className={controls.divider}/>
      <NotificationCenter unread={8} items={[]} taskCount={longLabels?120:36}/>
      <span data-tour="language"><LanguageSwitcher/></span>
      <span data-tour="theme"><ThemeToggle/></span>
      <UserMenu name={longLabels?'Fictional Reviewer With A Deliberately Long Name':'Fictional Reviewer'} employeeCode="EMP-0001" employed/>
     </div>
    </header>
    <main className={geometry.main} aria-label="Fictional working page"><h1>Fictional working page</h1></main>
   </div>
  </div>
 </NavIndexProvider></UiThemeProvider></NextIntlClientProvider>);
 view.container.style.height='100%';
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 const header=document.querySelector<HTMLElement>('[data-app-header]')!;
 // Flush layout, then await the real finite header reveal; the descendant live-dot loop is unrelated.
 const before=box(header).toJSON();
 const animations=header.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime));
 if(animations.length)console.info('SYNTHETIC_HEADER_ANIMATION_BEFORE',JSON.stringify({theme,width,before,animations:animations.map(animation=>({playState:animation.playState,currentTime:animation.currentTime,timing:animation.effect?.getComputedTiming()}))}));
 await Promise.all(animations.map(animation=>animation.finished));
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 if(animations.length)console.info('SYNTHETIC_HEADER_ANIMATION_SETTLED',JSON.stringify({theme,width,box:box(header).toJSON(),animations:animations.map(animation=>({playState:animation.playState,currentTime:animation.currentTime}))}));
 return header;
}
function assertReachableHeader(header:HTMLElement,width:number){
 const company=header.querySelector<HTMLButtonElement>('[data-company-switcher]')!;
 const named=within(header),bell=named.getByRole('button',{name:/^Notifications,/});
 const buttons=[company,bell,named.getByRole('button',{name:'Change language'}),named.getByRole('button',{name:'Toggle theme'}),named.getByRole('button',{name:'Account menu'})];
 const search=named.queryByRole('button',{name:/^Search for an action/});if(search)buttons.push(search);
 expect(buttons).toHaveLength(document.documentElement.getAttribute('data-ui-theme')==='classic'?6:5);
 const bounds=box(header),diagnostic=JSON.stringify({viewport:width,header:bounds.toJSON(),buttons:buttons.map(button=>({name:button.getAttribute('aria-label')??button.textContent,box:box(button).toJSON()}))});
 expect(company,diagnostic).toBeTruthy();expect(box(company).width,diagnostic).toBeGreaterThanOrEqual(44);
 for(const button of buttons){
  const r=box(button);
  expect(r.height,diagnostic).toBeGreaterThanOrEqual(44);
  expect(r.width,diagnostic).toBeGreaterThanOrEqual(width<640?44:36);
  expect(r.left,diagnostic).toBeGreaterThanOrEqual(bounds.left-.5);
  expect(r.right,diagnostic).toBeLessThanOrEqual(bounds.right+.5);
  expect(button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),diagnostic).toBe(true);
 }
 for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++)expect(intersects(box(buttons[i]),box(buttons[j])),diagnostic).toBe(false);
 expect(document.documentElement.scrollWidth,diagnostic).toBeLessThanOrEqual(width);
 expect(box(screen.getByRole('main',{name:'Fictional working page'})).height,diagnostic).toBeGreaterThan(80);
 return {company,bell,diagnostic};
}

describe('Classic company scope stays reachable when the rail appears',()=>{
 const widths=[320,390,639,640,768,899,900,1023,1024,1280,1512];
 it.each([false,true].flatMap(dark=>[false,true].flatMap(longLabels=>widths.map(width=>({width,dark,longLabels})))))('separates the full real control set at $width px (dark=$dark, longLabels=$longLabels)',async({width,dark,longLabels})=>{
  const header=await mount('classic',width,dark,longLabels),{company,bell,diagnostic}=assertReachableHeader(header,width);
  if(width<1024)expect(box(company).bottom,diagnostic).toBeLessThanOrEqual(box(bell).top-.5);
  else{expect(box(header).height,diagnostic).toBe(64);expect(box(company).top,diagnostic).toBeCloseTo(box(bell).top,0);}
  if([640,1023,1024].includes(width))console.info('SYNTHETIC_CLASSIC_HEADER_GEOMETRY',diagnostic);
 });
 it.each([false,true].flatMap(dark=>[640,1023].map(width=>({dark,width}))))('opens company and account menus without changing scope at $width px (dark=$dark)',async({dark,width})=>{
  const header=await mount('classic',width,dark),{company}=assertReachableHeader(header,width);
  console.info('CHO_CLICK '+JSON.stringify({phase:'start',target:'All companies',w:Date.now()}));await page.getByRole('button',{name:'All companies',exact:true}).click();console.info('CHO_CLICK '+JSON.stringify({phase:'end',target:'All companies',w:Date.now()}));
  expect(company).toHaveAttribute('aria-expanded','true');
  const backdrop=company.parentElement!.querySelector<HTMLElement>('.fixed.inset-0')!;
  expect(backdrop).toBeTruthy();
  expect(document.elementFromPoint(width/2,830)).toBe(backdrop);
  fireEvent.click(backdrop);expect(company).toHaveAttribute('aria-expanded','false');
  console.info('CHO_CLICK '+JSON.stringify({phase:'start',target:'Account menu',w:Date.now()}));await page.getByRole('button',{name:'Account menu',exact:true}).click();console.info('CHO_CLICK '+JSON.stringify({phase:'end',target:'Account menu',w:Date.now()}));
  expect(screen.getByRole('menu',{name:'Account menu'})).toBeVisible();
  fireEvent.keyDown(document,{key:'Escape'});
  expect(screen.queryByRole('menu',{name:'Account menu'})).toBeNull();
  expect(within(header).getByRole('button',{name:'Account menu'})).toBe(document.activeElement);
  assertReachableHeader(header,width);
 });
});
describe('Classic-only CSS preserves the other shell themes',()=>{
 it.each((['monolith','atelier'] as const).flatMap(theme=>[false,true].flatMap(dark=>[390,640,1023,1024,1512].map(width=>({theme,dark,width})))))('$theme controls remain reachable at $width px (dark=$dark)',async({theme,dark,width})=>{
  const header=await mount(theme,width,dark);assertReachableHeader(header,width);
 });
});
