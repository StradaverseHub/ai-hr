/** @vitest-environment jsdom */
/** Issue 17 (owner: "Merge both entirely", 3 November 2026): the Control Tower is AI Centre › Operations and
 * Administration. The rail has ONE item for both, the AI Centre row, which is the current row on every
 * /control-tower page; no Control Tower module remains in Ops, every other row, the Ops/Strat switch and System
 * Configuration stay, and the Dashboard row reads "Today" on the same route. Per role, with the props app/layout.tsx
 * derives (isAdmin(session) for canAdministerAi, isGroupAdmin(session) for the provider). Navigation only: every
 * /control-tower page still runs requireAdmin, pinned in test/ai-centre-operations-guards.test.ts. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre as messages} from './helpers/ai-centre-messages';

const state=vi.hoisted(()=>({path:'/'}));
vi.mock('next/navigation',()=>({usePathname:()=>state.path,useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
import {Sidebar} from '../components/sidebar';

const nav=messages.nav;
type Role='employee'|'manager'|'hrAdmin'|'groupAdmin';
const PROPS:Readonly<Record<Role,Record<string,boolean>>>={
 employee:{isAdmin:false,canAdministerAi:false,canConfigureAiProvider:false,canApprove:false,canAccessTeam:false},
 manager:{isAdmin:false,canAdministerAi:false,canConfigureAiProvider:false,canApprove:true,canAccessTeam:true},
 hrAdmin:{isAdmin:true,canAdministerAi:true,canConfigureAiProvider:false,canApprove:false,canAccessTeam:true},
 groupAdmin:{isAdmin:true,canAdministerAi:true,canConfigureAiProvider:true,canApprove:false,canAccessTeam:true},
};
const rail=(role:Role,extra:{assistantAccess?:boolean;enabledModules?:string[]|null}={})=>render(<NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>
 <Sidebar {...PROPS[role]} enabledModules={extra.enabledModules===undefined?null:extra.enabledModules} assistantAccess={extra.assistantAccess??true} defaultCollapsed={false}/>
</NextIntlClientProvider>);
const centreRows=()=>[...document.querySelectorAll('a[href="/assistant"]')];
const ROLES:readonly Role[]=['employee','manager','hrAdmin','groupAdmin'];
afterEach(()=>{cleanup();state.path='/';});

describe('AI Centre is the one sidebar item for Operations and Administration',()=>{
 it.each(ROLES)('%s: no Control Tower module and no /control-tower row; Today on /; the AI Centre row is offered',role=>{
  rail(role);
  expect(screen.queryByRole('button',{name:'Control Tower'})).toBeNull();
  expect(document.querySelector('a[href^="/control-tower"]')).toBeNull();
  expect(document.body.textContent).not.toMatch(/control tower/i);
  expect(nav.dashboard).toBe('Today');
  expect(screen.getByRole('link',{name:'Today'})).toHaveAttribute('href','/');
  expect(screen.queryByRole('link',{name:'Dashboard'})).toBeNull();
  expect(centreRows()).toHaveLength(1);expect(centreRows()[0].textContent).toContain(nav.aiCentre);
 });

 it.each(['hrAdmin','groupAdmin'] as const)('%s keeps the Ops modules, the Ops/Strat switch and System Configuration',role=>{
  rail(role);
  const ops=screen.getByRole('group',{name:nav.workspaceSwitch});
  expect(within(ops).getAllByRole('button').map(button=>button.textContent)).toEqual([nav.workspaceOps,nav.workspaceStrata]);
  // The first Ops module is People now; before issue 17 it was the Control Tower.
  for(const label of [nav.modulePeople,nav.moduleLeave,nav.payroll])expect(screen.getByRole('button',{name:label})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:nav.systemConfiguration})).toBeInTheDocument();
  fireEvent.click(within(ops).getByRole('button',{name:nav.workspaceStrata}));
  expect(screen.getByRole('button',{name:nav.workspaceStrata})).toHaveAttribute('aria-pressed','true');
 });

 it.each([
  '/control-tower','/control-tower/exceptions','/control-tower/readiness','/control-tower/actions','/control-tower/opportunities',
  '/control-tower/agents','/control-tower/agents/features','/control-tower/agents/inventory','/control-tower/agents/allowances','/control-tower/agents/provider',
 ])('the AI Centre row is the one current row on %s',path=>{
  state.path=path;rail('groupAdmin');
  const current=[...document.querySelectorAll('a[aria-current="page"]')];
  expect(current.map(link=>link.getAttribute('href'))).toEqual(['/assistant']);
 });

 it('an HR administrator keeps the AI Centre row without the Assistant grant or module, because Operations lives there',()=>{
  rail('hrAdmin',{assistantAccess:false,enabledModules:['employees','leave']});
  expect(centreRows()).toHaveLength(1);
 });

 it.each(['employee','manager'] as const)('%s without Assistant access still has no AI Centre row (unchanged)',role=>{
  rail(role,{assistantAccess:false});
  expect(centreRows()).toHaveLength(0);
  cleanup();
  rail(role,{enabledModules:['employees','leave']});
  expect(centreRows()).toHaveLength(0);
 });
});
