/** @vitest-environment jsdom */
/** AI Centre › Operations and Administration (the former Control Tower and AI management pages) and
 * Administration › AI run requireAdmin (hr_admin/super_admin). Payroll and performance-compensation partners share the broad administration
 * rail, so the rail listed these screens and every click sent them home. Provider setup additionally needs
 * group-wide administration: a company administrator is sent from it back to the AI Overview. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre as messages} from './helpers/ai-centre-messages';
vi.mock('next/navigation',()=>({usePathname:()=>'/',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
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
  // Issue 17: the former Control Tower menu is gone from the rail for everyone; its pages are AI Centre tabs, shown
  // only to a viewer whose requireAdmin admits them (test/ai-centre-tabs-roles.dom.test.tsx).
  expect(screen.queryByRole('button',{name:'Control Tower'})).toBeNull();
  expect(document.querySelector('a[href^="/control-tower"]')).toBeNull();
  const system=screen.queryByRole('button',{name:nav.systemConfiguration});
  // The partner keeps its other administration rows; only the AI screens are withheld.
  if(rail)expect(system).not.toBeNull();
  if(system)fireEvent.click(system);
  expect(screen.queryByRole('link',{name:nav.aiConfig})).toBeNull();
  // The AI Centre row stays for an HR administrator even without the Assistant grant, because Operations lives there.
  cleanup();
  render(<NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>
   <Sidebar isAdmin={rail} canAdministerAi={ai} canConfigureAiProvider={provider} assistantAccess={false} enabledModules={null} defaultCollapsed={false}/>
  </NextIntlClientProvider>);
  expect(document.querySelectorAll('a[href="/assistant"]')).toHaveLength(ai?1:0);
 });
});
