/** The AI Assistant sidebar row follows the tenant's assistant entitlement. Before the fix the row was
 * mapped to `assistant` in components/sidebar.tsx but lib/nav-entitlements.ts never emitted that code, so
 * a resolved snapshot hid it even with the module active. The enabledModules lists below are what
 * visibleModuleCodes returns for an active / inactive assistant (pinned in slice4-nav-gating.test.ts). */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';

vi.mock('next/navigation',()=>({usePathname:()=>'/',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/(app)/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));

import {Sidebar} from '../components/sidebar';

const rail=(enabledModules:string[]|null,assistantAccess=true)=>render(<NextIntlClientProvider locale="en" messages={messages}>
 <Sidebar isAdmin canApprove canAccessTeam enabledModules={enabledModules} assistantAccess={assistantAccess} defaultCollapsed={false}/>
</NextIntlClientProvider>);
const assistantRows=()=>document.querySelectorAll('a[href="/assistant"]');
afterEach(cleanup);

describe('AI Assistant sidebar row',()=>{
 it('shows when the tenant snapshot has the assistant module active',()=>{
  rail(['employees','leave','assistant']);
  expect(assistantRows().length).toBeGreaterThan(0);
  expect(assistantRows()[0].textContent).toContain(messages.nav.assistant);
 });
 it('hides when the snapshot resolves without the assistant module',()=>{
  rail(['employees','leave']);
  expect(assistantRows()).toHaveLength(0);
  // Discriminating, not blank: other Home rows still render.
  expect(document.querySelector('a[href="/knowledge-base"]')).not.toBeNull();
 });
 it('hides the row from a login without Assistant access, even with the module active',()=>{
  rail(['employees','leave','assistant'],false);
  expect(assistantRows()).toHaveLength(0);
 });
 it('fails open like every other module row when no snapshot resolved',()=>{
  rail(null);
  expect(assistantRows().length).toBeGreaterThan(0);
 });
});
