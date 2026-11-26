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
// Board 8fa0a31d — the Security Center section lists its pages directly in the reporter's order. The overview is not a
// row (it was a duplicate of the section's own name); it stays the section's breadcrumb landing and a "Go to" entry.
const hrefs=['/admin/users/access','/admin/security-center/password-policy','/admin/users/function-access','/admin/users','/admin/users/create','/admin/users/invite'];
const withoutPolicy=hrefs.filter(href=>href!=='/admin/security-center/password-policy');
beforeEach(()=>{route.path='/admin/users/create';});
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
let published:ReturnType<typeof useNavIndex>={entries:[],active:null};
function IndexWitness(){published=useNavIndex();return null;}
function show(theme:string,admin=true,configure=true,provision=true,passwordPolicy=admin&&provision,locale:Locale='en',collapsed=false){document.documentElement.setAttribute('data-ui-theme',theme);return render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><NavIndexProvider><Sidebar isAdmin={admin} canAdministerSecurity={admin} canConfigureAccess={configure} canProvisionUsers={provision} canConfigureLoginPresentation={admin&&provision} canConfigurePasswordPolicy={passwordPolicy} defaultCollapsed={collapsed}/><IndexWitness/></NavIndexProvider></NextIntlClientProvider>);}
function open(locale:Locale='en'){const buttons=screen.getAllByRole('button',{name:copies[locale].nav.securityCenter});expect(buttons).toHaveLength(1);expect(buttons[0]).toHaveAttribute('aria-controls','nav-section-securityCenter');if(buttons[0].getAttribute('aria-expanded')!=='true')fireEvent.click(buttons[0]);return screen.getByRole('navigation',{name:copies[locale].nav.securityCenter});}
const linkHrefs=(element:HTMLElement)=>within(element).getAllByRole('link').map(link=>link.getAttribute('href'));
describe.each(['classic','monolith','atelier'])('%s Security Center navigation',theme=>{
 it.each(Object.keys(copies) as Locale[])('%s lists the six pages in its own section with only the selected leaf active',async locale=>{
  show(theme,true,true,true,true,locale);fireEvent.click(screen.getByRole('button',{name:copies[locale].nav.workspaceSwitch}));const panel=open(locale);expect(linkHrefs(panel)).toEqual(hrefs);
  await captureAiReviewScreenshots(`<div class="flex h-[940px] items-start">${aiReviewDomHtml(document.body)}</div>`,locale,`security-flyout-${theme}`,'real sidebar with fictional current authority; no authenticated server journey',theme as 'classic'|'monolith'|'atelier');
  expect(panel.querySelectorAll('[aria-current="page"]')).toHaveLength(1);expect(panel.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/admin/users/create');
 },30_000);
 it('renders System Configuration and Security Center as two sections with no repeated Security Center row',()=>{
  route.path='/admin/holidays';show(theme);
  const system=screen.getAllByRole('button',{name:en.nav.systemConfiguration});expect(system).toHaveLength(1);
  expect(system[0]).toHaveAttribute('aria-controls','nav-section-systemConfiguration');
  // Classic and Atelier headings draw the section icon beside the chevron; Monolith headings carry no icon at all.
  const securityHeading=screen.getByRole('button',{name:en.nav.securityCenter});
  for(const heading of [system[0],securityHeading])expect(heading.querySelectorAll('svg')).toHaveLength(theme==='monolith'?0:2);
  const config=screen.getByRole('navigation',{name:en.nav.systemConfiguration});
  expect(linkHrefs(config)).toContain('/admin/holidays');expect(linkHrefs(config).some(href=>href!==null&&isSecurityDestination(href))).toBe(false);
  const security=open();expect(linkHrefs(security)).toEqual(hrefs);
  // The section's name is never repeated as a row, and the overview is no menu row anywhere in the rail.
  expect(within(security).queryByRole('link',{name:en.nav.securityCenter})).toBeNull();
  expect(document.querySelector(`a[href="${SECURITY_CENTER}"]`)).toBeNull();
  // Security Center follows System Configuration at the end of the rail; Classic and Monolith pin the first of them.
  const sections=[...document.querySelectorAll<HTMLElement>('[data-nav-section]')].map(section=>section.dataset.navSection);
  expect(sections.slice(-2)).toEqual(['systemConfiguration','securityCenter']);
  if(theme!=='atelier'){
   expect(document.querySelector('[data-nav-section="systemConfiguration"]')).toHaveClass('mt-auto');
   expect(document.querySelector('[data-nav-section="securityCenter"]')).not.toHaveClass('mt-auto');
  }
 });
 it('keeps password policy unavailable independently of login-presentation authority',()=>{show(theme,true,true,true,false);const panel=open();expect(within(panel).queryByRole('link',{name:en.nav.passwordPolicy})).toBeNull();expect(linkHrefs(panel)).toEqual(withoutPolicy);});
 it('hides group provisioning from delegated admins',()=>{route.path='/admin/users';show(theme,true,false,false);const panel=open();expect(linkHrefs(panel)).toEqual(['/admin/users/function-access','/admin/users']);});
 it('admits configure-only users to only their Security Center row, with the overview kept as the section landing',()=>{
  route.path='/admin/users/access';show(theme,false,true,false);const panel=open();expect(linkHrefs(panel)).toEqual(['/admin/users/access']);
  expect(document.querySelector(`a[href="${SECURITY_CENTER}"]`)).toBeNull();
  const row=published.entries.find(entry=>entry.href==='/admin/users/access');
  expect(row).toMatchObject({section:en.nav.securityCenter,sectionHref:SECURITY_CENTER,parent:null});
  expect(published.entries.filter(entry=>entry.href===SECURITY_CENTER)).toEqual([{href:SECURITY_CENTER,label:en.nav.securityCenter,section:null,parent:null,parentHref:null}]);
 });
 it('opens the Security Center section and marks its landing active on the overview page',()=>{
  route.path=SECURITY_CENTER;show(theme);
  const heading=screen.getByRole('button',{name:en.nav.securityCenter});expect(heading).toHaveAttribute('aria-expanded','true');
  expect(linkHrefs(screen.getByRole('navigation',{name:en.nav.securityCenter}))).toEqual(hrefs);
  expect(published.active).toMatchObject({href:SECURITY_CENTER,section:null,parent:null});
 });
 it('offers no landing to a viewer who may not open the overview',()=>{
  route.path='/admin/users/create';show(theme,false,false,true);
  expect(published.entries.some(entry=>entry.href===SECURITY_CENTER)).toBe(false);
 });
 it('does not expose a security node to an employee',()=>{show(theme,false,false,false);expect(screen.queryByRole('button',{name:en.nav.securityCenter})).toBeNull();expect(screen.queryByRole('navigation',{name:en.nav.securityCenter})).toBeNull();expect(document.querySelector('a[href="/admin/security-center"]')).toBeNull();expect(published.entries.some(entry=>entry.href===SECURITY_CENTER)).toBe(false);});
 it('shows an hr_admin every destination the resolver admits: the pre-change set without the overview row',()=>{
  route.path='/admin/users/create';show(theme,true,true,true,true);
  const facts={isAdmin:true,canAdministerSecurity:true,canConfigureAccess:true,canProvisionUsers:true,canConfigureLoginPresentation:true,canConfigurePasswordPolicy:true};
  const resolved=resolveShellNavigation(facts);
  // Pre-change, the security family was the overview plus SECURITY_PAGES; only the overview row is gone, and no other
  // row changed in this item (shell-inventory diff), so the admitted set is the former set minus the overview.
  const admitted=new Set(resolved.destinations.filter(row=>!row.disabled).map(row=>row.navigationHref??row.href));
  expect([...admitted].filter(isSecurityDestination).sort()).toEqual(SECURITY_PAGES.map(page=>page.href).sort());
  expect(admitted.has(SECURITY_CENTER)).toBe(false);expect(resolved.securityLanding).toBe(SECURITY_CENTER);
  // Splitting the sections loses and adds nothing: the two sections publish exactly the system-area destinations
  // (the rail's single source for "Go to" and the breadcrumb), plus the landing with no section of its own.
  const system=placeNavigation(resolved.destinations).placed.filter(row=>row.placement.area==='system'&&!row.destination.disabled).map(row=>row.destination);
  const systemHrefs=system.map(row=>row.navigationHref??row.href),aliases=system.flatMap(row=>(row.searchAliases??[]).map(alias=>alias.href));
  const inSections=published.entries.filter(entry=>entry.section===en.nav.systemConfiguration||entry.section===en.nav.securityCenter).map(entry=>entry.href);
  expect(systemHrefs.length).toBeGreaterThan(6);
  expect(new Set(inSections.filter(href=>!aliases.includes(href)))).toEqual(new Set(systemHrefs));
  expect(published.entries.filter(entry=>entry.href===SECURITY_CENTER).map(entry=>entry.section)).toEqual([null]);
 });
});
describe.each(['classic','atelier'])('%s collapsed icon rail',theme=>{
 it('shows each administration section as one trigger that opens its pages',()=>{
  route.path='/admin/users/access';show(theme,true,true,true,true,'en',true);
  for(const key of ['systemConfiguration','securityCenter'] as const){
   const section=document.querySelector<HTMLElement>(`[data-nav-section="${key}"]`)!;
   expect(within(section).getAllByRole('button')).toEqual([within(section).getByRole('button',{name:en.nav[key]})]);
   expect(within(section).queryAllByRole('link')).toHaveLength(0);
  }
  fireEvent.click(within(document.querySelector<HTMLElement>('[data-nav-section="securityCenter"]')!).getByRole('button',{name:en.nav.securityCenter}));
  const panel=screen.getByRole('navigation',{name:en.nav.securityCenter});
  expect(linkHrefs(panel)).toEqual(hrefs);
  expect(within(panel).getByRole('link',{name:en.nav.securityPermissions})).toHaveAttribute('aria-current','page');
 });
});
