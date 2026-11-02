/** Inbox › Review › back (staging acceptance, 3 November 2026): the Review link carries an allow-listed origin, never
 * a return URL, and the shell offers the way back only for that origin. Fictional; no session. */
import type {ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre} from './helpers/ai-centre-messages';
import {AI_INBOX_HREF,cameFromInbox,withInboxOrigin} from '../lib/ai-centre/inbox-origin';

const query=vi.hoisted(()=>({value:''}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams(query.value),usePathname:()=>'/approvals'}));
vi.mock('next/link',()=>({default:({children,...props}:{children:ReactNode;href:string})=><a {...props}>{children}</a>}));
const {BackToInbox}=await import('../components/ai-centre/back-to-inbox');
afterEach(()=>{cleanup();query.value='';});

describe('Inbox origin',()=>{
 it('adds the origin to the query, before the fragment, keeping the existing query',()=>{
  expect(withInboxOrigin('/approvals?category=leave&task=leave&requestId=r1#leave-r1')).toBe('/approvals?category=leave&task=leave&requestId=r1&from=ai-inbox#leave-r1');
  expect(withInboxOrigin('/performance/review/abc')).toBe('/performance/review/abc?from=ai-inbox');
  expect(withInboxOrigin('/tasks#onboarding-1')).toBe('/tasks?from=ai-inbox#onboarding-1');
 });
 it('accepts only the allow-listed origin, once',()=>{
  expect(cameFromInbox(new URLSearchParams('from=ai-inbox'))).toBe(true);
  for(const value of ['','from=','from=https%3A%2F%2Fevil.example','from=%2Fassistant','from=AI-INBOX','from=ai-inbox&from=ai-inbox','from=ai-inbox%20'])
   expect(cameFromInbox(new URLSearchParams(value)),value).toBe(false);
  expect(cameFromInbox(null)).toBe(false);
 });
 it('shows the way back to the Inbox only for that origin, always to the fixed Inbox address',()=>{
  const mount=()=>render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}><BackToInbox/></NextIntlClientProvider>);
  query.value='category=leave&from=ai-inbox';
  const shown=mount();const link=shown.container.querySelector('[data-back-to-inbox] a');
  expect(link).toHaveAttribute('href',AI_INBOX_HREF);expect(link?.textContent).toContain(enWithAiCentre.aiCentre.tabs.inbox);
  cleanup();
  for(const value of ['category=leave','from=https%3A%2F%2Fevil.example','from=%2F%2Fevil.example','from=ai-inbox&from=other']){
   query.value=value;const view=mount();expect(view.container.querySelector('[data-back-to-inbox]'),value).toBeNull();cleanup();
  }
 });
});
