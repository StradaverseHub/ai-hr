/** @vitest-environment jsdom */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import {ReviewedDecisionBatch} from '../components/assistant/reviewed-decision-batch';
import {ASSIGNED_CLAIM_DECISION_ACTION as action} from '../lib/assistant-actions/assigned-decision-contract';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import viMessages from '../messages/vi.json';import ta from '../messages/ta.json';import th from '../messages/th.json';
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
const ids=Array.from({length:25},(_,i)=>`50000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`),employmentId='60000000-0000-4000-8000-000000000001',subjectId='60000000-0000-4000-8000-000000000002',eventId='60000000-0000-4000-8000-000000000003';
const item={employmentId,subjectId,employeeName:'Fictional Ana',employeeCode:'E-1',claimTypeName:'Taxi',itemName:null,incurredOn:'2026-10-27',amount:'42.50',description:'Fictional journey to customer site'};
const stamp=(offset:number)=>new Date(Date.now()+offset).toISOString();
const review=(id:string)=>({kind:'prepared',review:{action,contractVersion:1,actionId:id,reviewedDigest:'e'.repeat(64),createdAt:stamp(-1000),expiresAt:stamp(600000),content:{action,contractVersion:1,employmentId,subjectId,decision:'rejected',note:'My explicit reason for rejecting this claim'},review:item,consequence:'assigned_claim_decided_payment_by_payroll_or_reimbursement'}});
const completed=(id:string)=>({kind:'completed',receipt:{action,contractVersion:1,actionId:id,state:'completed',receipt:{kind:'decided',subjectId,eventId,employmentId,decision:'rejected',recorded:'final',currentStatus:'rejected'}}});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
let fetcher:ReturnType<typeof vi.fn>;const packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
function configure(count=2,loseSecond=false){fetcher.mockImplementation(async(_url:unknown,init:RequestInit)=>{const p=JSON.parse(String(init.body));if(p.operation==='list')return json({kind:'claim_decision_review_index',reviews:ids.slice(0,count).map(actionId=>({action,contractVersion:1,actionId,state:'awaiting_confirmation',createdAt:stamp(-1000),expiresAt:stamp(600000)}))});if(p.operation==='reopen')return json(review(p.actionId));if(p.operation==='confirm'){if(loseSecond&&p.confirmation.actionId===ids[1])throw Error('lost after possible native commit');return json(completed(p.confirmation.actionId));}throw Error('Unexpected command');});}
function mount(locale='en',messages:typeof en=en){return render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}><main className="mx-auto max-w-4xl space-y-5"><ReviewedDecisionBatch action={action} leaveChoices={{kind:'unavailable'}}/></main></NextIntlClientProvider>);}
beforeEach(()=>{fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('loads at most twenty saved reviews with no selection or implicit reopen/prepare/confirm',async()=>{
 configure(25);mount();expect(fetcher).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:en.assistant.workspace.bulkDecisions.load}));
 await waitFor(()=>expect(screen.getAllByRole('listitem')).toHaveLength(20));expect(packets().map(p=>p.operation)).toEqual(['list']);expect(screen.queryAllByRole('checkbox')).toHaveLength(0);expect(screen.getByRole('button',{name:'Confirm 0 reviewed decisions'}).hasAttribute('disabled')).toBe(true);
});
it('requires full individual reopened reviews and selections; preserves per-item success and lost-response recovery without retry',async()=>{
 configure(2,true);mount();fireEvent.click(screen.getByRole('button',{name:en.assistant.workspace.bulkDecisions.load}));await waitFor(()=>expect(screen.getAllByRole('listitem')).toHaveLength(2));
 const rows=screen.getAllByRole('listitem');for(const row of rows){fireEvent.click(within(row).getByRole('button',{name:en.assistant.workspace.decisionActions.reopen}));await within(row).findByRole('heading',{name:en.assistant.workspace.decisionActions.reviewTitle});expect(within(row).getByText(item.description)).toBeTruthy();fireEvent.click(within(row).getByRole('checkbox'));}
 fireEvent.click(screen.getByRole('button',{name:'Confirm 2 reviewed decisions'}));await screen.findByText(en.assistant.workspace.bulkDecisions.finished);
 expect(within(rows[0]).getByRole('heading',{name:en.assistant.workspace.decisionActions.done})).toBeTruthy();expect(within(rows[1]).getByRole('button',{name:en.assistant.workspace.decisionActions.reopen})).toBeTruthy();
 expect(packets().filter(p=>p.operation==='confirm').map(p=>p.confirmation.actionId)).toEqual(ids.slice(0,2));expect(packets().some(p=>p.operation==='prepare')).toBe(false);expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
});
it('refresh clears individually reviewed selection and does not resend any decision',async()=>{
 configure(1);mount();fireEvent.click(screen.getByRole('button',{name:en.assistant.workspace.bulkDecisions.load}));const row=(await screen.findAllByRole('listitem'))[0];fireEvent.click(within(row).getByRole('button',{name:en.assistant.workspace.decisionActions.reopen}));await within(row).findByRole('checkbox');fireEvent.click(within(row).getByRole('checkbox'));await screen.findByRole('button',{name:'Confirm 1 reviewed decision'});
 fireEvent.click(screen.getByRole('button',{name:en.assistant.workspace.bulkDecisions.load}));await waitFor(()=>expect(screen.queryAllByRole('checkbox')).toHaveLength(0));expect(packets().filter(p=>p.operation==='confirm')).toHaveLength(0);
});
for(const [locale,messages] of Object.entries({en,ms,zh,vi:viMessages,ta,th}))it(`renders complete reviewed facts and consent in ${locale} desktop/mobile`,async()=>{
 configure(1);const result=mount(locale,messages);fireEvent.click(screen.getByRole('button',{name:messages.assistant.workspace.bulkDecisions.load}));const row=(await screen.findAllByRole('listitem'))[0];fireEvent.click(within(row).getByRole('button',{name:messages.assistant.workspace.decisionActions.reopen}));await within(row).findByRole('checkbox');fireEvent.click(within(row).getByRole('checkbox'));await waitFor(()=>expect(screen.getByRole('button',{name:createTranslator({locale,messages,namespace:'assistant.workspace.bulkDecisions'})('confirm',{count:1})}).hasAttribute('disabled')).toBe(false));
 // Includes cold Tailwind compilation, browser startup and two font-complete captures on CI.
 await captureAiReviewScreenshots(aiReviewDomHtml(result.container),locale,'chat-card-reviewed-bulk','real saved-review composition and full native review cards; fictional fixture; no authenticated journey');
},60000);
