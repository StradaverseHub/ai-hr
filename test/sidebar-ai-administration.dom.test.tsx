/** @vitest-environment jsdom */
/** The AI Control Tower menu (with its AI management sub-menu) and Administration › AI run requireAdmin
 * (hr_admin/super_admin). Payroll and performance-compensation partners share the broad administration
 * rail, so the rail listed these screens and every click sent them home. Provider setup additionally needs
 * group-wide administration: a company administrator is sent from it back to the AI Overview. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next/navigation',()=>({usePathname:()=>'/',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/(app)/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
import {Sidebar} from '../components/sidebar';

const nav=messages.nav;
afterEach(cleanup);
describe('AI administration navigation',()=>{
 it.each([
  {viewer:'group-wide HR administrator',rail:true,ai:true,provider:true},
  {viewer:'company HR administrator',rail:true,ai:true,provider:false},
  {viewer:'payroll or performance partner',rail:true,ai:false,provider:false},
  {viewer:'employee',rail:false,ai:false,provider:false},
 ])('lists AI administration only where the pages open ($viewer)',({rail,ai,provider})=>{
  render(<NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>
   <Sidebar isAdmin={rail} canAdministerAi={ai} canConfigureAiProvider={provider} enabledModules={null} defaultCollapsed={false}/>
  </NextIntlClientProvider>);
  const tower=screen.queryByRole('button',{name:nav.aiControlTower});
  if(!ai){
   expect(tower).toBeNull();
   const system=screen.queryByRole('button',{name:nav.systemConfiguration});
   // The partner keeps its other administration rows; only the AI screens are withheld.
   if(rail)expect(system).not.toBeNull();
   if(system)fireEvent.click(system);
   expect(screen.queryByRole('link',{name:nav.aiConfig})).toBeNull();
   expect(document.querySelector('a[href^="/control-tower"]')).toBeNull();
   return;
  }
  fireEvent.click(tower!);
  const panel=screen.getByRole('navigation',{name:nav.aiControlTower});
  const hrefs=within(panel).getAllByRole('link').map(link=>link.getAttribute('href'));
  for(const href of ['/control-tower','/control-tower/agents','/control-tower/agents/allowances'])expect(hrefs).toContain(href);
  expect(hrefs.includes('/control-tower/agents/provider')).toBe(provider);
 });
});
