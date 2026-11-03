/** AI v2 W9: an AI Centre tab switch should render from the client cache, not from the loading shell. Every page here
 * is dynamic, so the default prefetch stops at the loading boundary (components/route-loading.tsx) and a click waits
 * for the whole server render plus React's Suspense reveal (components/intent-link.tsx, r394). The tab rows elsewhere
 * in the product prefetch the full destination once the person shows intent; this pins the same for the AI Centre tab
 * bar and the administrator sub-navigation, for an administrator and an employee, without changing a link, a label or
 * the current-page marker. Fictional; no session. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import type {ReactNode} from 'react';
vi.mock('next/link',()=>({
 default:({prefetch,children,...rest}:{prefetch?:unknown;children?:ReactNode}&Record<string,unknown>)=><a data-prefetch={String(prefetch)} {...(rest as Record<string,unknown>)}>{children}</a>,
}));
vi.mock('next/navigation',()=>({usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));
import {enWithAiCentre} from './helpers/ai-centre-messages';
import {AiCentreSubnav,AiCentreTabs} from '../components/ai-centre/centre-tabs';
import {INTENT_DWELL_MS} from '../components/intent-link';
import {ADMIN_GROUPS,centreTabsFor} from '../lib/ai-centre/centre-nav';

const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}>{node}</NextIntlClientProvider>);
const links=(container:HTMLElement)=>[...container.querySelectorAll<HTMLAnchorElement>('[data-ai-centre-tabs] a')];
beforeEach(()=>{vi.useFakeTimers();});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('AI Centre tabs prefetch the whole destination on intent',()=>{
 for(const isAdmin of [true,false])it(`${isAdmin?'administrator':'employee'}: every tab starts at the default prefetch and escalates on focus, touch or a resting pointer`,()=>{
  const view=wrap(<AiCentreTabs active="ask" isAdmin={isAdmin}/>);
  const tabs=links(view.container);
  // Same tabs, same targets, same order as before: only the prefetch behaviour is new.
  expect(tabs.map(link=>link.getAttribute('href'))).toEqual(centreTabsFor({isAdmin}).map(tab=>tab.href));
  for(const link of tabs)expect(link.getAttribute('data-prefetch'),link.getAttribute('href')??'').toBe('null');
  const [ask,inbox,jobs]=tabs;
  fireEvent.focus(inbox);expect(inbox.getAttribute('data-prefetch')).toBe('true');
  fireEvent.touchStart(jobs);expect(jobs.getAttribute('data-prefetch')).toBe('true');
  const last=tabs.at(-1)!;
  fireEvent.pointerEnter(last);expect(last.getAttribute('data-prefetch'),'not before the dwell').toBe('null');
  act(()=>{vi.advanceTimersByTime(INTENT_DWELL_MS);});
  expect(last.getAttribute('data-prefetch')).toBe('true');
  // A pointer passing over without resting never asks for the full page.
  fireEvent.pointerEnter(ask);act(()=>{vi.advanceTimersByTime(INTENT_DWELL_MS-30);});fireEvent.pointerLeave(ask);act(()=>{vi.advanceTimersByTime(1000);});
  expect(ask.getAttribute('data-prefetch')).toBe('null');
  // The current-page marker is unchanged.
  expect(view.container.querySelectorAll('[data-ai-centre-tabs] a[aria-current="page"]')).toHaveLength(1);
  expect(ask.getAttribute('aria-current')).toBe('page');
 });

 it('administrator sub-navigation: the same intent prefetch on every section link',()=>{
  const sections=ADMIN_GROUPS.spend.map(item=>item.section);
  const view=wrap(<AiCentreSubnav group="spend" active="allowances" available={sections} hrefOf={section=>`/control-tower/agents/${section}`}/>);
  const items=[...view.container.querySelectorAll<HTMLAnchorElement>('a')];
  expect(items.map(link=>link.getAttribute('href'))).toEqual(sections.map(section=>`/control-tower/agents/${section}`));
  for(const link of items)expect(link.getAttribute('data-prefetch')).toBe('null');
  fireEvent.focus(items[1]);expect(items[1].getAttribute('data-prefetch')).toBe('true');
  expect(items[0].getAttribute('aria-current')).toBe('page');
 });
});
