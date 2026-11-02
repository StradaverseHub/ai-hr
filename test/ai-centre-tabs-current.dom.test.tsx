/** AI centre tab bar: every view marks exactly its own tab as the current page (staging acceptance, 3 November 2026,
 * "the active tab indicator is missing on every tab except Ask"). The marker logic was already right; the visible loss
 * was Atelier's sticky page title painting over the tab row (test/ai-centre-title-tabs.browser.test.tsx). This pins the
 * single source of truth: the key a page passes, for every view and both viewers. Fictional; no session. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre} from './helpers/ai-centre-messages';
import {AiCentreTabs} from '../components/ai-centre/centre-tabs';
import {CENTRE_TABS,centreTabsFor,type CentreTabKey} from '../lib/ai-centre/centre-nav';

vi.mock('next/navigation',()=>({usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));
afterEach(cleanup);

const mount=(active:CentreTabKey,isAdmin:boolean)=>render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}><AiCentreTabs active={active} isAdmin={isAdmin}/></NextIntlClientProvider>);

describe('AI centre tab bar current page',()=>{
 for(const isAdmin of [true,false])for(const tab of centreTabsFor({isAdmin}))it(`${isAdmin?'administrator':'employee'} on ${tab.key}: exactly that tab is the current page`,()=>{
  const view=mount(tab.key,isAdmin);
  const current=view.container.querySelectorAll('[data-ai-centre-tabs] a[aria-current="page"]');
  expect(current).toHaveLength(1);
  expect(current[0].getAttribute('href')).toBe(tab.href);
  // The visible marker travels with the attribute: only the current link carries the primary underline.
  for(const link of view.container.querySelectorAll('[data-ai-centre-tabs] a'))
   expect(link.className.includes('border-primary'),link.getAttribute('href')??'').toBe(link===current[0]);
 });
 it('renders a streamed Inbox badge inside the Inbox tab, and the plain count still works (issue 12)',()=>{
  const streamed=render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}><AiCentreTabs active="ask" isAdmin={false} inboxBadge={<span data-fixture-badge>3</span>}/></NextIntlClientProvider>);
  expect(streamed.container.querySelector('a[href="/assistant?view=inbox"] [data-fixture-badge]')).not.toBeNull();
  cleanup();
  const counted=render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}><AiCentreTabs active="ask" isAdmin={false} inboxCount={2}/></NextIntlClientProvider>);
  expect(counted.container.querySelector('a[href="/assistant?view=inbox"]')?.textContent).toContain('2');
  cleanup();
  const none=render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}><AiCentreTabs active="ask" isAdmin={false} inboxCount={0}/></NextIntlClientProvider>);
  expect(none.container.querySelector('a[href="/assistant?view=inbox"] .rounded-full')).toBeNull();
 });
 it('lists every tab once for an administrator and hides only the administrator tabs from an employee',()=>{
  expect(new Set(CENTRE_TABS.map(tab=>tab.key)).size).toBe(CENTRE_TABS.length);
  expect(centreTabsFor({isAdmin:false}).map(tab=>tab.key)).toEqual(CENTRE_TABS.filter(tab=>!tab.adminOnly).map(tab=>tab.key));
 });
});
