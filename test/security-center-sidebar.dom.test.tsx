import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const route=vi.hoisted(()=>({path:'/admin/users/create'}));
vi.mock('next/navigation',()=>({usePathname:()=>route.path,useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),refresh:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/(app)/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
import {Sidebar} from '../components/sidebar';
const hrefs=['/admin/security-center','/admin/users/access','/admin/users/function-access','/admin/users/create','/admin/users/invite','/admin/users'];
beforeEach(()=>{route.path='/admin/users/create';});
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
function show(theme:string,admin=true,configure=true,provision=true){document.documentElement.setAttribute('data-ui-theme',theme);return render(<NextIntlClientProvider locale="en" messages={en} onError={error=>{throw error;}}><Sidebar isAdmin={admin} canAdministerSecurity={admin} canConfigureAccess={configure} canProvisionUsers={provision} defaultCollapsed={false}/></NextIntlClientProvider>);}
function open(){const buttons=screen.getAllByRole('button',{name:en.nav.securityCenter});if(buttons[0].getAttribute('aria-expanded')!=='true')fireEvent.click(buttons[0]);return screen.getByRole('navigation',{name:en.nav.securityCenter});}
describe.each(['classic','monolith','atelier'])('%s Security Center navigation',theme=>{
 it('offers hub and five pages with only the selected leaf active',()=>{
  show(theme);const panel=open();expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(hrefs);
  expect(panel.querySelectorAll('[aria-current="page"]')).toHaveLength(1);expect(panel.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/admin/users/create');
 });
 it('hides group provisioning from delegated admins',()=>{route.path='/admin/users';show(theme,true,false,false);const panel=open();const shown=within(panel).getAllByRole('link').map(link=>link.getAttribute('href'));expect(shown).toEqual(['/admin/security-center','/admin/users/function-access','/admin/users']);});
 it('admits configure-only users without listing role administration or provisioning',()=>{route.path='/admin/users/access';show(theme,false,true,false);const panel=open();expect(within(panel).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/admin/security-center','/admin/users/access']);});
 it('does not expose a security node to an employee',()=>{show(theme,false,false,false);expect(screen.queryByRole('button',{name:en.nav.securityCenter})).toBeNull();expect(document.querySelector('a[href="/admin/security-center"]')).toBeNull();});
});
