/** @vitest-environment jsdom */
/** Review R6 rendered evidence: the in-chat action card in every state — ready (prepared review awaiting the
 * person's confirmation), confirming, confirmed, discarded, stale and failure — in the six shipped locales,
 * through the real card, panel, Button and next-intl copy. Fictional data; the guarded endpoint is a scripted
 * fetch double, so this proves the browser presentation, not authority or effects (store/DB tests own those).
 * On the selected GitHub runner (AIHR_FOCUSED_EVIDENCE_DIR) each state is also rendered by Chrome with the
 * application's compiled CSS at desktop and mobile widths, and the capture fails on horizontal overflow. */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const refresh=vi.hoisted(()=>vi.fn());
vi.mock('next/navigation',()=>({useRouter:()=>({refresh}),usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams()}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
import {ConversationActionProposal} from '../components/assistant/conversation-action-proposal';
import {ASSIGNED_CLAIM_DECISION_ACTION as claimAction} from '../lib/assistant-actions/assigned-decision-contract';

const copies={en,ms,zh,vi:viCopy,th,ta};type Locale=keyof typeof copies;
const actionId='70000000-0000-4000-8000-000000000001',employmentId='70000000-0000-4000-8000-000000000002',subjectId='70000000-0000-4000-8000-000000000003',eventId='70000000-0000-4000-8000-000000000004';
const item={employmentId,subjectId,employeeName:'Fictional Ana',employeeCode:'E-1',claimTypeName:'Fictional taxi',itemName:null,incurredOn:'2026-10-27',amount:'123.50',description:null};
const stamp=(offset:number)=>new Date(Date.now()+offset).toISOString();
const content={action:claimAction,contractVersion:1,employmentId,subjectId,decision:'approved'};
const choices={kind:'choices',items:[item],truncated:false};
const prepared={kind:'prepared',review:{action:claimAction,contractVersion:1,actionId,reviewedDigest:'f'.repeat(64),createdAt:stamp(-1000),expiresAt:stamp(600000),content,review:item,consequence:'assigned_claim_decided_payment_by_payroll_or_reimbursement'}};
const completed={kind:'completed',receipt:{action:claimAction,contractVersion:1,actionId,state:'completed',receipt:{kind:'decided',subjectId,eventId,employmentId,decision:'approved',recorded:'final',currentStatus:'approved'}}};
const discarded={kind:'retired',receipt:{action:claimAction,contractVersion:1,actionId,state:'discarded'}};
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn();
beforeEach(()=>{fetcher.mockReset();refresh.mockReset();vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

function mount(locale:Locale,node:React.ReactNode){
 return render(<NextIntlClientProvider locale={locale} messages={copies[locale] as never} timeZone="Asia/Kuala_Lumpur">
  <main className="mx-auto w-full max-w-3xl space-y-4">{node}</main>
 </NextIntlClientProvider>);
}
async function capture(locale:Locale,state:string){
 const card=document.querySelector('section[aria-labelledby]') as HTMLElement|null;expect(card,state).not.toBeNull();
 await captureAiReviewScreenshots(aiReviewDomHtml(document.body.firstElementChild as HTMLElement),locale,`chat-card-${state}`,'real card, panel and copy; fictional claim; scripted same-origin endpoint; no authenticated server journey');
}
/** Drive the real decision panel to a prepared review that awaits the person's own confirmation. */
async function toReview(locale:Locale){
 const d=copies[locale].assistant.workspace.decisionActions;
 mount(locale,<ConversationActionProposal action={claimAction} hints={{}}/>);
 await screen.findByText(copies[locale].assistant.workspace.proposal.resolutionOne);
 fireEvent.click(screen.getByLabelText(d.approve));fireEvent.click(screen.getByLabelText(d.consent));
 fireEvent.click(screen.getByRole('button',{name:d.prepare}));
 await screen.findByRole('heading',{name:d.reviewTitle});
 return d;
}

describe('in-chat action card states in six locales',()=>{
 it.each(Object.keys(copies) as Locale[])('%s renders ready, confirming, confirmed, discarded, stale, unverified and failure',async locale=>{
  const p=copies[locale].assistant.workspace.proposal;
  for(const key of['badgeReady','badgeStale','badgeUnverified','staleNote','staleBody','unverifiedBody','refresh','failureBody','retry'] as const)expect(p[key],`${locale}.${key}`).toBeTruthy();

  // READY: the server's canonical prepared review, waiting for the person's own confirmation.
  let release:(value:Response)=>void=()=>undefined;
  fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared)).mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve;}));
  let d=await toReview(locale);
  expect(screen.getByText(p.badgeReady)).toBeTruthy();expect(screen.getByText('123.50')).toBeTruthy();
  expect((screen.getByRole('button',{name:d.confirm}) as HTMLButtonElement).disabled).toBe(true);
  await capture(locale,'ready');
  // CONFIRMING: one digest-bound confirm in flight; every action is disabled until it settles.
  fireEvent.click(screen.getByLabelText(d.confirmConsent));fireEvent.click(screen.getByRole('button',{name:d.confirm}));
  await screen.findByText(d.working);
  expect((screen.getByRole('button',{name:d.confirm}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('button',{name:d.discard}) as HTMLButtonElement).disabled).toBe(true);
  await capture(locale,'confirming');
  // CONFIRMED: the receipt as recorded by the owning service.
  release(json(completed));
  await screen.findByRole('heading',{name:d.done});expect(screen.getByText(d.doneFinal)).toBeTruthy();
  // Settled: no longer a suggestion, so the badge and the "nothing prepared" note are gone.
  await waitFor(()=>expect(screen.queryByText(p.badgeReady)).toBeNull());expect(screen.queryByText(p.note)).toBeNull();
  await capture(locale,'confirmed');
  const bodies=fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
  expect(bodies.map(body=>body.operation)).toEqual(['choices','prepare','confirm']);
  expect(bodies[2].confirmation).toEqual({action:claimAction,contractVersion:1,actionId,reviewedDigest:'f'.repeat(64)});
  cleanup();fetcher.mockReset();

  // DISCARDED: the person retires the prepared review; nothing is decided.
  fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared)).mockResolvedValueOnce(json(discarded));
  d=await toReview(locale);
  fireEvent.click(screen.getByRole('button',{name:d.discard}));
  await waitFor(()=>expect(document.body.textContent).toContain(d.states.discarded));
  await waitFor(()=>expect(screen.queryByText(p.badgeReady)).toBeNull());expect(screen.queryByText(p.note)).toBeNull();
  expect(fetcher.mock.calls.map(call=>JSON.parse(call[1].body).operation)).toEqual(['choices','prepare','discard']);
  await capture(locale,'discarded');
  cleanup();fetcher.mockReset();

  // STALE: the sealed suggestion is no longer in this person's current catalogue. Refused; refresh offered.
  mount(locale,<ConversationActionProposal action={claimAction} hints={{}} availability="stale"/>);
  expect(screen.getByText(p.badgeStale)).toBeTruthy();expect(screen.getByText(p.staleBody)).toBeTruthy();
  expect(screen.queryByRole('button',{name:d.prepare})).toBeNull();expect(fetcher).not.toHaveBeenCalled();
  await capture(locale,'stale');
  fireEvent.click(screen.getByRole('button',{name:p.refresh}));expect(refresh).toHaveBeenCalledTimes(1);
  cleanup();

  // UNVERIFIED: the catalogue could not be checked just now. Neutral, retryable, never "out of date".
  mount(locale,<ConversationActionProposal action={claimAction} hints={{}} availability="unverified"/>);
  expect(screen.getByText(p.badgeUnverified)).toBeTruthy();expect(screen.getByText(p.unverifiedBody)).toBeTruthy();expect(screen.queryByText(p.badgeStale)).toBeNull();
  expect(screen.queryByRole('button',{name:d.prepare})).toBeNull();expect(fetcher).not.toHaveBeenCalled();
  await capture(locale,'unverified');
  fireEvent.click(screen.getByRole('button',{name:p.retry}));expect(refresh).toHaveBeenCalledTimes(2);
  cleanup();

  // FAILURE: the card's own choices read failed. Plain reason, a safe retry (a read) and the usual page.
  fetcher.mockResolvedValueOnce(json({kind:'unavailable'}));
  mount(locale,<ConversationActionProposal action="claims.cancel" hints={{}}/>);
  await screen.findByText(p.failureBody);expect(screen.getByRole('button',{name:p.retry})).toBeTruthy();expect(screen.getByText(p.openPage)).toBeTruthy();
  await capture(locale,'failure');
 },180000);
});
