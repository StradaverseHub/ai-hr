import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import {withAiCentre} from './helpers/ai-centre-messages';
const copies={en:withAiCentre('en',en),ms:withAiCentre('ms',ms),zh:withAiCentre('zh',zh),vi:withAiCentre('vi',viCopy),ta:withAiCentre('ta',ta),th:withAiCentre('th',th)};
type Locale=keyof typeof copies;
const route=vi.hoisted(()=>({path:'/admin/users/create'}));
vi.mock('next/navigation',()=>({usePathname:()=>route.path,useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),refresh:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
import {Sidebar} from '../components/sidebar';
import {NavIndexProvider,useNavIndex} from '../components/nav-index-context';
import {resolveShellNavigation} from '../lib/navigation/shell-resolver';
import {placeNavigation} from '../lib/navigation-workspaces';
import {SECURITY_CENTER,SECURITY_PAGES,isSecurityDestination} from '../lib/security-center-navigation';
// Board 8fa0a31d (revision 2) — System Configuration and Security Center are two ordinary module rows at the end of the
// rail, each one trigger that opens its own fly-out exactly as Payroll does. The overview is not a row; it stays the
// Security Center module's breadcrumb landing and a "Go to" entry.
const hrefs=['/admin/users/access','/admin/security-center/password-policy','/admin/users','/admin/users/function-access','/admin/users/create','/admin/users/invite'];
const withoutPolicy=hrefs.filter(href=>href!=='/admin/security-center/password-policy');
type Theme='classic'|'monolith'|'atelier';
type Key='systemConfiguration'|'securityCenter';
/** The id each theme's module trigger controls: the shared fly-out panel (Classic, Atelier) or Monolith's inline list. */
const panelId=(theme:Theme,key:Key)=>`${theme==='classic'?'nav-flyout':theme==='atelier'?'atelier-flyout':'rail-kids'}-${key}`;
const icon={systemConfiguration:'svg.lucide-settings-2',securityCenter:'svg.lucide-shield-check'} as const;
beforeEach(()=>{route.path='/admin/users/create';});
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
let published:ReturnType<typeof useNavIndex>={entries:[],active:null};
function IndexWitness(){published=useNavIndex();return null;}
function show(theme:string,admin=true,configure=true,provision=true,passwordPolicy=admin&&provision,locale:Locale='en',collapsed=false){document.documentElement.setAttribute('data-ui-theme',theme);return render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><NavIndexProvider><Sidebar isAdmin={admin} canAdministerSecurity={admin} canConfigureAccess={configure} canProvisionUsers={provision} canConfigureLoginPresentation={admin&&provision} canConfigurePasswordPolicy={passwordPolicy} defaultCollapsed={collapsed}/><IndexWitness/></NavIndexProvider></NextIntlClientProvider>);}
/** The module's single trigger: exactly one control carries its name, and it controls the module's own panel. */
function trigger(theme:Theme,key:Key,locale:Locale='en'){const buttons=screen.getAllByRole('button',{name:copies[locale].nav[key]});expect(buttons).toHaveLength(1);expect(buttons[0]).toHaveAttribute('aria-controls',panelId(theme,key));return buttons[0];}
function open(theme:Theme,key:Key='securityCenter',locale:Locale='en'){const button=trigger(theme,key,locale);if(button.getAttribute('aria-expanded')!=='true')fireEvent.click(button);expect(button).toHaveAttribute('aria-expanded','true');return screen.getByRole('navigation',{name:copies[locale].nav[key]});}
const linkHrefs=(element:HTMLElement)=>within(element).getAllByRole('link').map(link=>link.getAttribute('href'));
const pinned=()=>document.querySelector<HTMLElement>('[data-nav-pinned]')!;
describe.each(['classic','monolith','atelier'] as const)('%s Security Center navigation',theme=>{
 it.each(Object.keys(copies) as Locale[])('%s opens the six pages from the Security Center module with only the selected leaf active',async locale=>{
  show(theme,true,true,true,true,locale);fireEvent.click(screen.getByRole('button',{name:copies[locale].nav.workspaceSwitch}));const panel=open(theme,'securityCenter',locale);expect(linkHrefs(panel)).toEqual(hrefs);
  await captureAiReviewScreenshots(`<div class="flex h-[940px] items-start">${aiReviewDomHtml(document.body)}</div>`,locale,`security-flyout-${theme}`,'real sidebar with fictional current authority; no authenticated server journey',theme);
  expect(panel.querySelectorAll('[aria-current="page"]')).toHaveLength(1);expect(panel.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/admin/users/create');
 },30_000);
 it('renders System Configuration and Security Center as two module triggers, not section headings',()=>{
  route.path='/admin/holidays';show(theme);
  const system=trigger(theme,'systemConfiguration'),security=trigger(theme,'securityCenter');
  // No section heading or section body carries either name any more.
  for(const key of ['systemConfiguration','securityCenter'])expect(document.getElementById(`nav-section-${key}`)).toBeNull();
  // Like Payroll: one trigger each, the gear and the shield in Classic and Atelier; Monolith's rail draws no icons.
  for(const [key,button] of [['systemConfiguration',system],['securityCenter',security]] as const){
   expect(button.querySelectorAll(icon[key])).toHaveLength(theme==='monolith'?0:1);
   expect(button.closest('a')).toBeNull();
  }
  // Both sit, in that order, in the one unlabelled group pinned to the end of the rail, holding nothing else.
  const group=pinned();
  expect(within(group).getAllByRole('button')).toEqual([system,security]);
  expect(group.parentElement!.lastElementChild).toBe(group);
  if(theme!=='atelier')expect(group).toHaveClass('mt-auto');
  const config=open(theme,'systemConfiguration');
  expect(linkHrefs(config)).toContain('/admin/holidays');expect(linkHrefs(config).some(href=>href!==null&&isSecurityDestination(href))).toBe(false);
  expect(config.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/admin/holidays');
  const panel=open(theme,'securityCenter');expect(linkHrefs(panel)).toEqual(hrefs);
  // The module's name is never repeated as a row, and the overview is no menu row anywhere in the rail.
  expect(within(panel).queryByRole('link',{name:en.nav.securityCenter})).toBeNull();
  expect(document.querySelector(`a[href="${SECURITY_CENTER}"]`)).toBeNull();
 });
 it('keeps password policy unavailable independently of login-presentation authority',()=>{show(theme,true,true,true,false);const panel=open(theme);expect(within(panel).queryByRole('link',{name:en.nav.passwordPolicy})).toBeNull();expect(linkHrefs(panel)).toEqual(withoutPolicy);});
 it('hides group provisioning from delegated admins',()=>{route.path='/admin/users';show(theme,true,false,false);const panel=open(theme);expect(linkHrefs(panel)).toEqual(['/admin/users','/admin/users/function-access']);});
 it('admits configure-only users to only their Security Center row, with the overview kept as the module landing',()=>{
  route.path='/admin/users/access';show(theme,false,true,false);const panel=open(theme);expect(linkHrefs(panel)).toEqual(['/admin/users/access']);
  // A module stays a module with one visible page; System Configuration, with no visible page, is omitted.
  expect(screen.queryByRole('button',{name:en.nav.systemConfiguration})).toBeNull();
  expect(screen.queryByRole('link',{name:en.nav.securityCenter})).toBeNull();
  expect(document.querySelector(`a[href="${SECURITY_CENTER}"]`)).toBeNull();
  const row=published.entries.find(entry=>entry.href==='/admin/users/access');
  expect(row).toMatchObject({section:null,parent:en.nav.securityCenter,parentHref:SECURITY_CENTER});
  expect(published.entries.filter(entry=>entry.href===SECURITY_CENTER)).toEqual([{href:SECURITY_CENTER,label:en.nav.securityCenter,section:null,parent:null,parentHref:null}]);
 });
 it('lights the Security Center module and marks its landing active on the overview page',()=>{
  route.path=SECURITY_CENTER;show(theme);
  const button=trigger(theme,'securityCenter');
  if(theme==='monolith')expect(button).toHaveAttribute('aria-expanded','true');else expect(button).toHaveClass('bg-accent');
  expect(linkHrefs(open(theme))).toEqual(hrefs);
  expect(published.active).toMatchObject({href:SECURITY_CENTER,section:null,parent:null});
 });
 it('offers no landing to a viewer who may not open the overview',()=>{
  route.path='/admin/users/create';show(theme,false,false,true);
  expect(published.entries.some(entry=>entry.href===SECURITY_CENTER)).toBe(false);
 });
 it('does not expose a security node to an employee',()=>{show(theme,false,false,false);expect(screen.queryByRole('button',{name:en.nav.securityCenter})).toBeNull();expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();expect(document.querySelector('a[href="/admin/security-center"]')).toBeNull();expect(published.entries.some(entry=>entry.href===SECURITY_CENTER)).toBe(false);});
 it('shows an hr_admin every destination the resolver admits: the pre-change set',()=>{
  route.path='/admin/users/create';show(theme,true,true,true,true);
  const facts={isAdmin:true,canAdministerSecurity:true,canConfigureAccess:true,canProvisionUsers:true,canConfigureLoginPresentation:true,canConfigurePasswordPolicy:true};
  const resolved=resolveShellNavigation(facts);
  // Revision 2 changes no row: the admitted security family is still SECURITY_PAGES, with the overview as landing only.
  const admitted=new Set(resolved.destinations.filter(row=>!row.disabled).map(row=>row.navigationHref??row.href));
  expect([...admitted].filter(isSecurityDestination).sort()).toEqual(SECURITY_PAGES.map(page=>page.href).sort());
  expect(admitted.has(SECURITY_CENTER)).toBe(false);expect(resolved.securityLanding).toBe(SECURITY_CENTER);
  // The two modules publish exactly the system-area destinations (the rail's single source for "Go to" and the
  // breadcrumb), plus the landing with no module of its own, and their fly-outs render exactly those links.
  const system=placeNavigation(resolved.destinations).placed.filter(row=>row.placement.area==='system'&&!row.destination.disabled).map(row=>row.destination);
  const systemHrefs=system.map(row=>row.navigationHref??row.href),aliases=system.flatMap(row=>(row.searchAliases??[]).map(alias=>alias.href));
  const inModules=published.entries.filter(entry=>entry.parent===en.nav.systemConfiguration||entry.parent===en.nav.securityCenter).map(entry=>entry.href);
  expect(systemHrefs.length).toBeGreaterThan(6);
  expect(new Set(inModules.filter(href=>!aliases.includes(href)))).toEqual(new Set(systemHrefs));
  expect(published.entries.filter(entry=>entry.href===SECURITY_CENTER).map(entry=>[entry.section,entry.parent])).toEqual([[null,null]]);
  const rendered=[...linkHrefs(open(theme,'systemConfiguration')),...linkHrefs(open(theme,'securityCenter'))];
  expect(new Set(rendered)).toEqual(new Set(systemHrefs));expect(rendered).toHaveLength(systemHrefs.length);
 });
});
describe.each(['classic','atelier'] as const)('%s module fly-outs',theme=>{
 it.each([false,true])('opens one panel at a time, closing with its close button and Escape (collapsed rail: %s)',collapsed=>{
  route.path='/admin/users/access';show(theme,true,true,true,true,'en',collapsed);
  if(collapsed){
   // The icon rail shows each module as its icon alone: the gear and the shield, and no links.
   const group=pinned();
   expect(within(group).getAllByRole('button')).toEqual([trigger(theme,'systemConfiguration'),trigger(theme,'securityCenter')]);
   expect(within(group).queryAllByRole('link')).toHaveLength(0);
   for(const key of ['systemConfiguration','securityCenter'] as const)expect(trigger(theme,key).querySelectorAll(icon[key])).toHaveLength(1);
  }
  const config=open(theme,'systemConfiguration');expect(linkHrefs(config).length).toBeGreaterThan(0);
  const panel=open(theme,'securityCenter');
  expect(screen.queryByRole('navigation',{name:en.nav.systemConfiguration})).toBeNull();
  expect(trigger(theme,'systemConfiguration')).toHaveAttribute('aria-expanded','false');
  expect(linkHrefs(panel)).toEqual(hrefs);
  expect(within(panel).getByRole('link',{name:en.nav.securityPermissions})).toHaveAttribute('aria-current','page');
  fireEvent.click(within(document.getElementById(panelId(theme,'securityCenter'))!).getByRole('button',{name:en.common.close}));
  expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();
  open(theme,'systemConfiguration');fireEvent.keyDown(document,{key:'Escape'});
  expect(screen.queryByRole('navigation',{name:en.nav.systemConfiguration})).toBeNull();
  expect(trigger(theme,'systemConfiguration')).toHaveFocus();
 });
});
