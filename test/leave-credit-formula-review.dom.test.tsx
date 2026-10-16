import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {LeaveCreditRequestTable,type LeaveCreditHrMode} from '../components/leave/leave-credit-request-table';
import {LeaveCreditClaimReviewNotice} from '../components/leave/leave-credit-claim-review';
import {leaveCreditClaimReviewBlocks,type LeaveCreditClaimReview,type LeaveCreditClaimReviewAction} from '../lib/leave-credit-claim-review';
const facts={kind:'rest_day' as const,shiftStart:null,shiftEnd:null,actualClockIn:'09:00',actualClockOut:'19:01',measuredExtendedMinutes:0,approvedOtPlan:null};
const over:LeaveCreditClaimReview={basis:'formula',workedDayKind:'rest_day',status:'refused',reason:'exceedsBound',claimedMinutes:601,boundMinutes:60,eligibleMinutes:null,creditDays:null,calculationId:'recorded-calculation',sourceRevision:3};
const ready:LeaveCreditClaimReview={...over,status:'ready',reason:null,claimedMinutes:60,eligibleMinutes:60,creditDays:0.5};
const hr:LeaveCreditHrMode={employmentId:'fictional-employee',help:'Fictional HR preview',submitLabel:'Grant',consentLabel:'Consent',pickEmployeeFirst:'Choose',alreadyCredited:'Already credited',overtimeNote:()=>'',blocked:false};
function mount(action?:LeaveCreditClaimReviewAction,hrMode?:LeaveCreditHrMode){
 const view=render(<NextIntlClientProvider locale="en" messages={en}><LeaveCreditRequestTable replacementType={{id:'replacement',name:'Replacement'}} submitAction={async()=>{}} today="2026-10-16" dayFactsAction={async()=>facts} claimReviewAction={action} tiers={{extendedHalfDayMinutes:240,extendedFullDayMinutes:480,extendedBreakMinutes:0,extendedGraceMinutes:0}} ordinaryDayAllowed={true} hr={hrMode}/></NextIntlClientProvider>);
 return view;
}
async function fill(container:HTMLElement,end='19:01'){
 fireEvent.change(container.querySelector('input[type="date"]')!,{target:{value:'2026-10-16'}});
 await waitFor(()=>expect(screen.getByTestId('leave-credit-row')).toHaveTextContent(en.replacementRequest.dayKind.restDay));
 const times=container.querySelectorAll('input[type="time"]');fireEvent.change(times[0],{target:{value:'09:00'}});fireEvent.change(times[1],{target:{value:end}});
 fireEvent.change(container.querySelector('textarea')!,{target:{value:'Fictional reviewed work'}});
}
afterEach(cleanup);
describe('formula bound never silently becomes a legacy promise',()=>{
 it.each([false,true])('refuses601 versus60 in the actual shared table, HR=%s',async isHr=>{
  const action=vi.fn<LeaveCreditClaimReviewAction>().mockResolvedValue(over),{container}=mount(action,isHr?hr:undefined);await fill(container);
  await waitFor(()=>expect(screen.getByText(en.replacementRequest.formulaReview.errors.exceedsBound)).toBeVisible());
  expect(screen.getByTestId('leave-credit-total')).toHaveTextContent(en.replacementRequest.formulaReview.creditUnavailable);
  expect(screen.getByTestId('leave-credit-row-credit')).not.toHaveTextContent('1.0');expect(screen.getByTestId('leave-credit-submit')).toBeDisabled();
  expect(action).toHaveBeenCalledWith('2026-10-16','09:00','19:01',isHr?hr.employmentId:undefined);
 });
 it('keeps the dated refusal and calculation reference outside the horizontal input table',async()=>{
  const calculationId='a-long-recorded-calculation-identity-without-spaces-to-wrap-on-a-narrow-screen';
  const {container}=mount(async()=>({...over,calculationId}));await fill(container);
  await waitFor(()=>expect(screen.getByText(en.replacementRequest.formulaReview.errors.exceedsBound)).toBeVisible());
  const reviews=screen.getByTestId('leave-credit-claim-reviews'),alert=screen.getByRole('alert');
  expect(reviews.closest('table')).toBeNull();expect(reviews.closest('.overflow-x-auto')).toBeNull();
  expect(reviews).toContainElement(alert);expect(reviews).toHaveTextContent('2026-10-16');expect(reviews).toHaveTextContent(calculationId);
  expect(alert).toHaveClass('min-w-0','max-w-full','whitespace-normal','[overflow-wrap:anywhere]');
  expect(screen.getByTestId('leave-credit-table')).not.toContainElement(alert);
  expect(screen.getByTestId('leave-credit-submit')).toBeDisabled();
 });
 it('preserves the uncapped legacy self-declared window only after explicit owner proof',async()=>{
  const {container}=mount(async()=>({basis:'legacy'}));await fill(container);
  await waitFor(()=>expect(screen.getByTestId('leave-credit-submit')).not.toBeDisabled());
  expect(screen.getByTestId('leave-credit-row-credit')).toHaveTextContent('1');expect(screen.queryByText(en.replacementRequest.formulaReview.errors.exceedsBound)).toBeNull();
 });
 it.each([undefined,async()=>{throw Error('private driver detail');}])('does not fallback when review is absent or fails',async action=>{
  const {container}=mount(action);await fill(container);
  await waitFor(()=>expect(screen.getByText(en.replacementRequest.formulaReview.errors.unavailable)).toBeVisible());
  expect(screen.getByTestId('leave-credit-submit')).toBeDisabled();expect(screen.getByTestId('leave-credit-total')).toHaveTextContent(en.replacementRequest.formulaReview.creditUnavailable);expect(screen.queryByText('private driver detail')).toBeNull();
 });
 it('discards a late response for a different claim window',async()=>{
  let resolveOld!:(review:LeaveCreditClaimReview)=>void;
  const old=new Promise<LeaveCreditClaimReview>(resolve=>{resolveOld=resolve;});
  const action=vi.fn<LeaveCreditClaimReviewAction>().mockImplementation(async(_date,_start,end)=>end==='19:01'?old:ready);
  const {container}=mount(action);await fill(container);await waitFor(()=>expect(action).toHaveBeenCalledWith('2026-10-16','09:00','19:01',undefined));
  fireEvent.change(container.querySelectorAll('input[type="time"]')[1],{target:{value:'10:00'}});
  // A newer context replaces queued work but must not start a second active proof.
  expect(action).not.toHaveBeenCalledWith('2026-10-16','09:00','10:00',undefined);
  expect(screen.getByTestId('leave-credit-submit')).toBeDisabled();resolveOld(over);
  await waitFor(()=>expect(screen.getByTestId('leave-credit-row-credit')).toHaveTextContent('0.5'));
  expect(action).toHaveBeenCalledWith('2026-10-16','09:00','10:00',undefined);
  await waitFor(()=>expect(screen.queryByText(en.replacementRequest.formulaReview.errors.exceedsBound)).toBeNull());expect(screen.getByTestId('leave-credit-submit')).not.toBeDisabled();
 });
 it('refuses a formula review whose recorded day classification differs from the visible day facts',async()=>{
  const {container}=mount(async()=>({...ready,workedDayKind:'workday'}));await fill(container,'10:00');
  await waitFor(()=>expect(screen.getByText(en.replacementRequest.formulaReview.errors.stale)).toBeVisible());
  expect(screen.getByTestId('leave-credit-submit')).toBeDisabled();
  expect(screen.getByTestId('leave-credit-total')).toHaveTextContent(en.replacementRequest.formulaReview.creditUnavailable);
 });
 it.each(Object.entries({en,ms,zh,ta,th,vi:viMessages}))('renders the duration/refusal without money or salary in %s',(locale,messages)=>{
  render(<NextIntlClientProvider locale={locale} messages={messages}><LeaveCreditClaimReviewNotice review={over}/></NextIntlClientProvider>);
  expect(screen.getByRole('alert')).toHaveTextContent('601');expect(screen.getByRole('alert')).toHaveTextContent('60');expect(screen.getByRole('alert')).toHaveTextContent(messages.replacementRequest.formulaReview.errors.exceedsBound);
  expect(screen.getByRole('alert').textContent).not.toMatch(/MYR|basicSalary|amountMinorUnits/);
 });
 it('keeps all six locale helpers honest about formula limits and configured tiers',()=>{
  for(const messages of Object.values({en,ms,zh,ta,th,vi:viMessages})){
   expect(messages.replacementRequest.table.help.trim()).not.toBe('');
   expect(messages.replacementRequest.table.attendanceReferenceOnly.trim()).not.toBe('');
   expect(messages.admin.leaveCredit.add.help.trim()).not.toBe('');
   expect(messages.replacementRequest.table.companyRule).toContain('{half}');expect(messages.replacementRequest.table.companyRule).toContain('{full}');
  }
  expect(en.replacementRequest.table.help).toContain('recorded formula limits apply');
  expect(en.replacementRequest.table.attendanceReferenceOnly).toContain('duration limits still apply');
  expect(en.replacementRequest.table.help).not.toMatch(/does not limit|Four eligible hours|eight a full day/);
  expect(en.admin.leaveCredit.add.help).not.toMatch(/Four eligible hours|eight a full day/);
 });
 it('treats pending and every finite unavailable reason as unresolved for approver controls',()=>{
  expect(leaveCreditClaimReviewBlocks(undefined)).toBe(true);
  for(const reason of ['unavailable','stale','fractional','cashConflict'] as const)expect(leaveCreditClaimReviewBlocks({basis:'unavailable',reason})).toBe(true);
  expect(leaveCreditClaimReviewBlocks({...ready,creditDays:null})).toBe(true);
  expect(leaveCreditClaimReviewBlocks({...ready,eligibleMinutes:null})).toBe(true);
  expect(leaveCreditClaimReviewBlocks(over)).toBe(true);expect(leaveCreditClaimReviewBlocks(ready)).toBe(false);expect(leaveCreditClaimReviewBlocks({basis:'legacy'})).toBe(false);
 });
});
