/** @vitest-environment jsdom */
/** 28 Oct 2026 (owner): the AI Control Tower menu in the sidebar is the Control Tower's only menu. It lists
 * every Control Tower screen with the same names the retired tab row used, and AI management's own pages
 * under an "AI management" heading. Payroll-only queues stay hidden without the payroll module. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';

vi.mock('next/navigation',()=>({usePathname:()=>'/control-tower/agents/allowances',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/(app)/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
import {Sidebar} from '../components/sidebar';

const nav=messages.nav;
const rail=(enabledModules:string[]|null)=>render(<NextIntlClientProvider locale="en" messages={messages}>
 <Sidebar isAdmin canAdministerAi canConfigureAiProvider canApprove canAccessTeam enabledModules={enabledModules} defaultCollapsed={false}/>
</NextIntlClientProvider>);
const openTower=()=>{fireEvent.click(screen.getByRole('button',{name:nav.aiControlTower}));return screen.getByRole('navigation',{name:nav.aiControlTower});};
const hrefs=(panel:HTMLElement)=>within(panel).getAllByRole('link').map(link=>link.getAttribute('href'));
afterEach(cleanup);

describe('AI Control Tower sidebar menu',()=>{
 it('lists every Control Tower screen, then AI management’s pages under their own heading',()=>{
  rail(null);
  const panel=openTower();
  expect(hrefs(panel)).toEqual(['/control-tower','/control-tower/readiness','/control-tower/exceptions','/control-tower/actions','/control-tower/opportunities','/control-tower/how-it-works',
   '/control-tower/agents/inventory','/control-tower/agents','/control-tower/agents/provider','/control-tower/agents/assistant','/control-tower/agents/features','/control-tower/agents/allowances','/control-tower/agents/spending','/control-tower/agents/orchestrator','/control-tower/agents/runs']);
  // The same names the tab row used, so nothing is renamed by moving.
  for(const [href,label] of [['/control-tower/readiness','Employee data'],['/control-tower/exceptions','Payroll exceptions'],['/control-tower/actions','Approvals']] as const)
   expect(within(panel).getByRole('link',{name:label}).getAttribute('href')).toBe(href);
  expect(within(panel).getByText(nav.sectionAiManagement)).toBeInTheDocument();
  // The open page is the one current entry; the Overview is exact, so it is not current here too.
  const current=within(panel).getAllByRole('link').filter(link=>link.getAttribute('aria-current')==='page');
  expect(current.map(link=>link.getAttribute('href'))).toEqual(['/control-tower/agents/allowances']);
 });
 it('hides the payroll-only queues without the payroll module and keeps everything else',()=>{
  rail(['employees','leave']);
  const shown=hrefs(openTower());
  expect(shown).not.toContain('/control-tower/exceptions');expect(shown).not.toContain('/control-tower/actions');
  for(const href of ['/control-tower','/control-tower/readiness','/control-tower/agents','/control-tower/agents/provider','/control-tower/how-it-works'])expect(shown).toContain(href);
 });
});
