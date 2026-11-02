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
const copies={en,ms,zh,vi:viCopy,ta,th};
type Locale=keyof typeof copies;
const route=vi.hoisted(()=>({path:'/admin/users/create'}));
vi.mock('next/navigation',()=>({usePathname:()=>route.path,useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),refresh:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
import {Sidebar} from '../components/sidebar';
const hrefs=['/admin/security-center','/admin/users/access','/admin/users/function-access','/admin/users/create','/admin/users/invite','/admin/users','/admin/security-center/password-policy'];
beforeEach(()=>{route.path='/admin/users/create';});
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
function show(theme:string,admin=true,configure=true,provision=true,passwordPolicy=admin&&provision,locale:Locale='en'){document.documentElement.setAttribute('data-ui-theme',theme);return render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><Sidebar isAdmin={admin} canAdministerSecurity={admin} canConfigureAccess={configure} canProvisionUsers={provision} canConfigureLoginPresentation={admin&&provision} canConfigurePasswordPolicy={passwordPolicy} defaultCollapsed={false}/></NextIntlClientProvider>);}
function open(locale:Locale='en'){const buttons=screen.getAllByRole('button',{name:copies[locale].nav.securityCenter});if(buttons[0].getAttribute('aria-expanded')!=='true')fireEvent.click(buttons[0]);return screen.getByRole('navigation',{name:copies[locale].nav.securityCenter});}
describe.each(['classic','monolith','atelier'])('%s Security Center navigation',theme=>{
 it.each(Object.keys(copies) as Locale[])('%s offers the hub and six pages with only the selected leaf active',async locale=>{
  show(theme,true,true,true,true,locale);fireEvent.click(screen.getByRole('button',{name:copies[locale].nav.workspaceSwitch}));const panel=open(locale);expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(hrefs);
  await captureAiReviewScreenshots(`<div class="flex h-[940px] items-start">${aiReviewDomHtml(document.body)}</div>`,locale,`security-flyout-${theme}`,'real sidebar with fictional current authority; no authenticated server journey',theme as 'classic'|'monolith'|'atelier');
  expect(panel.querySelectorAll('[aria-current="page"]')).toHaveLength(1);expect(panel.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/admin/users/create');
 },30_000);
 it('keeps password policy unavailable independently of login-presentation authority',()=>{show(theme,true,true,true,false);const panel=open();expect(within(panel).queryByRole('link',{name:en.nav.passwordPolicy})).toBeNull();expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(hrefs.slice(0,-1));});
 it('hides group provisioning from delegated admins',()=>{route.path='/admin/users';show(theme,true,false,false);const panel=open();const shown=within(panel).getAllByRole('link').map(link=>link.getAttribute('href'));expect(shown).toEqual(['/admin/security-center','/admin/users/function-access','/admin/users']);});
 it('admits configure-only users without listing role administration or provisioning',()=>{route.path='/admin/users/access';show(theme,false,true,false);const panel=open();expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/admin/security-center','/admin/users/access']);});
 it('does not expose a security node to an employee',()=>{show(theme,false,false,false);expect(screen.queryByRole('button',{name:en.nav.securityCenter})).toBeNull();expect(document.querySelector('a[href="/admin/security-center"]')).toBeNull();});
});
