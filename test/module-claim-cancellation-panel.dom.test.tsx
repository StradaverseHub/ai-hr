/** @vitest-environment jsdom */
/** ADR-0151 wave 1: the claim cancellation panel's browser protocol. Two explicit human steps, references
 * only, and a lost confirmation is reopened rather than retried. Engine/auth proof is the DB test. */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ModuleClaimCancellationPanel} from '../components/assistant/module-claim-cancellation-panel';
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>values?`${key}:${Object.values(values).join('|')}`:key),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10)})}));
vi.mock('../components/ui',()=>({Button:({children,variant:_,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string})=><button {...props}>{children}</button>,inputCls:''}));
import {OWN_CLAIM_CANCELLATION_ACTION as action} from '../lib/assistant-actions/own-claim-cancellation-contract';
const id='20000000-0000-4000-8000-000000000001',employmentId='20000000-0000-4000-8000-000000000002',claimId='20000000-0000-4000-8000-000000000003',eventId='20000000-0000-4000-8000-000000000004';
const row={employmentId,claimId,claimTypeName:'Fictional taxi',incurredOn:'2026-10-27',amount:'42.50'};
const choices={kind:'choices' as const,truncated:false,claims:[row]};
const content={action,contractVersion:1 as const,employmentId,claimId,cancel:true as const};
const prepared=(expired=false)=>({kind:'prepared',review:{action,contractVersion:1,actionId:id,reviewedDigest:'b'.repeat(64),createdAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+(expired?-1000:60000)).toISOString(),content,review:{employmentId,claimId,claimTypeName:'Fictional taxi',incurredOn:'2026-10-27',amount:'42.50',status:'pending'},consequence:'pending_claim_cancelled_no_payment'}});
const completed=()=>({kind:'completed',receipt:{action,contractVersion:1,actionId:id,state:'completed',receipt:{kind:'cancelled',claimId,cancelledEventId:eventId,employmentId,currentStatus:'cancelled'}}});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function prepare(){fireEvent.change(screen.getByLabelText('cancelChoose'),{target:{value:claimId}});expect((screen.getByRole('button',{name:'cancelPrepare'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByLabelText('cancelConsent'));fireEvent.click(screen.getByRole('button',{name:'cancelPrepare'}));await screen.findByRole('heading',{name:'cancelReviewTitle'});}

it('needs a chosen claim and two separate human confirmations, and sends only references',async()=>{
 fetcher.mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json(completed()));render(<ModuleClaimCancellationPanel choices={choices}/>);expect(fetcher).not.toHaveBeenCalled();
 await prepare();expect(packets()[0]).toEqual({action,operation:'prepare',input:content});
 const confirmButton=screen.getByRole('button',{name:'cancelConfirm'}) as HTMLButtonElement;expect(confirmButton.disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('cancelConfirmConsent'));fireEvent.click(confirmButton);await screen.findByRole('heading',{name:'cancelDone'});
 expect(packets()[1]).toEqual({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId:id,reviewedDigest:'b'.repeat(64)}});
});
it('reopens the same review after a lost confirmation and never retries the cancellation',async()=>{
 fetcher.mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(completed()));render(<ModuleClaimCancellationPanel choices={choices}/>);
 await prepare();fireEvent.click(screen.getByLabelText('cancelConfirmConsent'));fireEvent.click(screen.getByRole('button',{name:'cancelConfirm'}));
 await screen.findByText('cancelUncertain');expect(fetcher).toHaveBeenCalledTimes(2);
 fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'cancelDone'});
 expect(packets()[2]).toEqual({action,operation:'reopen',actionId:id});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);
});
it('disables confirmation once the review has expired',async()=>{
 fetcher.mockResolvedValueOnce(json(prepared(true)));render(<ModuleClaimCancellationPanel choices={choices}/>);await prepare();
 await screen.findByText('expired');expect((screen.getByRole('button',{name:'cancelConfirm'}) as HTMLButtonElement).disabled).toBe(true);
});
it('refuses a response for a different claim instead of showing it',async()=>{
 const other=prepared();other.review.review={...other.review.review,claimId:id};fetcher.mockResolvedValueOnce(json(other));render(<ModuleClaimCancellationPanel choices={choices}/>);
 fireEvent.change(screen.getByLabelText('cancelChoose'),{target:{value:claimId}});fireEvent.click(screen.getByLabelText('cancelConsent'));fireEvent.click(screen.getByRole('button',{name:'cancelPrepare'}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('cancelUnavailable'));expect(screen.queryByRole('heading',{name:'cancelReviewTitle'})).toBeNull();
});
it('shows that there is nothing to cancel without making a request',()=>{render(<ModuleClaimCancellationPanel choices={{kind:'choices',claims:[],truncated:false}}/>);expect(screen.getByText('cancelNone')).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();});
