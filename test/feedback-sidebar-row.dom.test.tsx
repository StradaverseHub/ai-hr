/** 0696 — the Feedback sidebar row follows the operator's per-customer switch. app/layout.tsx passes
 * feedbackAccess from feedback.menu_enabled; /feedback refuses on its own when the switch is off. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';

vi.mock('next/navigation',()=>({usePathname:()=>'/',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));

import {Sidebar} from '../components/sidebar';

const rail=(feedbackAccess?:boolean,isAdmin=false)=>render(<NextIntlClientProvider locale="en" messages={messages}>
 <Sidebar isAdmin={isAdmin} enabledModules={['employees','leave']} feedbackAccess={feedbackAccess} defaultCollapsed={false}/>
</NextIntlClientProvider>);
const feedbackRows=()=>document.querySelectorAll('a[href="/feedback"]');
afterEach(cleanup);

describe('Feedback sidebar row',()=>{
 it('shows by default and when the operator leaves it on',()=>{
  rail();
  expect(feedbackRows().length).toBeGreaterThan(0);
  expect(feedbackRows()[0].textContent).toContain(messages.nav.feedback);
  cleanup();rail(true);
  expect(feedbackRows().length).toBeGreaterThan(0);
 });
 it('hides for employees and administrators alike when the operator turns it off',()=>{
  for(const isAdmin of [false,true]){
   rail(false,isAdmin);
   expect(feedbackRows()).toHaveLength(0);
   // Discriminating, not blank: other Home rows still render.
   expect(document.querySelector('a[href="/knowledge-base"]')).not.toBeNull();
   cleanup();
  }
 });
});
