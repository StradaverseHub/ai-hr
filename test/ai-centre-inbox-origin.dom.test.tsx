/** Today › Review › back (staging acceptance, 3 November 2026; AI v2 Phase 1 moved it from the retired AI Centre Inbox
 * to Today): the Review link carries an allow-listed origin, never a return URL, and the shell offers the way back
 * to Today only for that origin. Fictional; no session. */
import type {ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre} from './helpers/ai-centre-messages';
import {TODAY_HREF,cameFromToday,withTodayOrigin} from '../lib/ai-centre/inbox-origin';
import {todayInboxRedirect} from '../lib/ai-centre/today-redirect';

const query=vi.hoisted(()=>({value:''}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams(query.value),usePathname:()=>'/approvals'}));
vi.mock('next/link',()=>({default:({children,...props}:{children:ReactNode;href:string})=><a {...props}>{children}</a>}));
const {BackToInbox}=await import('../components/ai-centre/back-to-inbox');
afterEach(()=>{cleanup();query.value='';});

describe('Today origin',()=>{
 it('is Today at /',()=>{expect(TODAY_HREF).toBe('/');});
 it('adds the origin to the query, before the fragment, keeping the existing query',()=>{
  expect(withTodayOrigin('/approvals?category=leave&task=leave&requestId=r1#leave-r1')).toBe('/approvals?category=leave&task=leave&requestId=r1&from=today#leave-r1');
  expect(withTodayOrigin('/performance/review/abc')).toBe('/performance/review/abc?from=today');
  expect(withTodayOrigin('/tasks#onboarding-1')).toBe('/tasks?from=today#onboarding-1');
 });
 it('accepts only the allow-listed origin, once',()=>{
  expect(cameFromToday(new URLSearchParams('from=today'))).toBe(true);
  // The retired Inbox marker no longer offers a way back.
  for(const value of ['','from=','from=ai-inbox','from=https%3A%2F%2Fevil.example','from=%2F','from=TODAY','from=today&from=today','from=today%20'])
   expect(cameFromToday(new URLSearchParams(value)),value).toBe(false);
  expect(cameFromToday(null)).toBe(false);
 });
 it('shows the way back to Today only for that origin, always to /, labelled "Back to Today"',()=>{
  const mount=()=>render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}><BackToInbox/></NextIntlClientProvider>);
  query.value='category=leave&from=today';
  const shown=mount();const link=shown.container.querySelector('[data-back-to-today] a');
  expect(link).toHaveAttribute('href','/');expect(link?.textContent).toContain('Back to Today');
  expect(enWithAiCentre.aiCentre.backToToday).toBe('Back to Today');
  cleanup();
  for(const value of ['category=leave','from=ai-inbox','from=https%3A%2F%2Fevil.example','from=%2F%2Fevil.example','from=today&from=other']){
   query.value=value;const view=mount();expect(view.container.querySelector('[data-back-to-today]'),value).toBeNull();cleanup();
  }
 });
});

describe('the retired Inbox address',()=>{
 it('moves to Today, carrying only a well-formed recommendation id',()=>{
  expect(todayInboxRedirect(undefined)).toBe('/');
  expect(todayInboxRedirect('11111111-2222-4333-8444-555555555555')).toBe('/?recommend=11111111-2222-4333-8444-555555555555');
  for(const value of ['','x','//evil.example','11111111-2222-4333-8444-555555555555&from=today',['11111111-2222-4333-8444-555555555555'],42])
   expect(todayInboxRedirect(value),String(value)).toBe('/');
 });
});
