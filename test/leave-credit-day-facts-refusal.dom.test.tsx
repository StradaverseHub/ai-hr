import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {LeaveCreditRequestTable,type LeaveCreditDayFacts,type LeaveCreditHrMode} from '../components/leave/leave-credit-request-table';
import type {LeaveCreditDayFactsResult} from '../lib/leave-credit-day-facts-result';
import {todayInKualaLumpur} from '../lib/hr-date';
const today=todayInKualaLumpur(),facts:LeaveCreditDayFacts={kind:'rest_day',shiftStart:null,shiftEnd:null,actualClockIn:'09:00',actualClockOut:'19:01',measuredExtendedMinutes:0,approvedOtPlan:null};
const hr:LeaveCreditHrMode={employmentId:'picked-employee',help:'Fixture',submitLabel:'Grant',consentLabel:'Consent',pickEmployeeFirst:'Choose',alreadyCredited:'Already',overtimeNote:()=>'',blocked:false};
function mount(action:(date:string)=>Promise<LeaveCreditDayFactsResult<LeaveCreditDayFacts>>,hrMode?:LeaveCreditHrMode,locale='en',messages=en){
 return render(<NextIntlClientProvider locale={locale} messages={messages}><LeaveCreditRequestTable replacementType={{id:'replacement',name:'Replacement'}} submitAction={async()=>{}} today={today} dayFactsAction={action} claimReviewAction={async()=>({basis:'legacy'})} tiers={{extendedHalfDayMinutes:240,extendedFullDayMinutes:480,extendedBreakMinutes:0,extendedGraceMinutes:0}} ordinaryDayAllowed={true} hr={hrMode}/></NextIntlClientProvider>);
}
afterEach(cleanup);
describe('known day-fact refusal is explicit settled state rather than transport retry',()=>{
 for(const [locale,messages]of Object.entries({en,ms,zh,ta,th,vi:viMessages}))it.each([false,true])('renders one native cash reason and no retry/credit in '+locale+' HR=%s',async isHr=>{
  const action=vi.fn().mockResolvedValue({state:'unavailable',reason:'cashConflict'}),{container}=mount(action,isHr?hr:undefined,locale,messages);
  fireEvent.change(container.querySelector('input[type="date"]')!,{target:{value:today}});fireEvent.change(container.querySelector('textarea')!,{target:{value:'Fictional claim'}});
  await waitFor(()=>expect(screen.getAllByText(messages.replacementRequest.formulaReview.errors.cashConflict)).toHaveLength(1));
  const alert=screen.getByRole('alert');expect(alert).toBeVisible();expect(alert.closest('table')).toBeNull();expect(alert.closest('.overflow-x-auto')).toBeNull();expect(screen.queryByTestId('leave-credit-day-type-retry')).toBeNull();
  expect(screen.getByTestId('leave-credit-day-type')).not.toHaveTextContent(messages.replacementRequest.table.dayTypeLookupFailed);expect(screen.getByTestId('leave-credit-day-type')).not.toHaveTextContent(messages.replacementRequest.table.dayTypeNotFound);expect(screen.getByTestId('leave-credit-details-toggle')).toBeDisabled();expect(screen.getByTestId('leave-credit-submit')).toBeDisabled();expect(screen.getByTestId('leave-credit-total')).toHaveTextContent(messages.replacementRequest.formulaReview.creditUnavailable);
  expect(action).toHaveBeenCalledWith(today,...(isHr?[hr.employmentId]:[]));
 });
 it('retains retry for unexpected rejection and recovers real facts on retry',async()=>{
  const action=vi.fn().mockRejectedValueOnce(Error('Private SQL detail')).mockResolvedValue(facts),{container}=mount(action);
  fireEvent.change(container.querySelector('input[type="date"]')!,{target:{value:today}});
  await waitFor(()=>expect(screen.getByTestId('leave-credit-day-type-retry')).toBeVisible());expect(screen.queryByText('Private SQL detail')).toBeNull();
  fireEvent.click(screen.getByTestId('leave-credit-day-type-retry'));
  await waitFor(()=>expect(screen.getByTestId('leave-credit-day-type')).toHaveTextContent(en.replacementRequest.dayKind.restDay));expect(action).toHaveBeenCalledTimes(2);expect(screen.queryByTestId('leave-credit-day-type-retry')).toBeNull();
 });
 it('does not apply a late refusal to another date',async()=>{
  const older=todayInKualaLumpur(new Date(Date.now()-86400000));
  let resolveOld!:(v:LeaveCreditDayFactsResult<LeaveCreditDayFacts>)=>void;const pending=new Promise<LeaveCreditDayFactsResult<LeaveCreditDayFacts>>(resolve=>{resolveOld=resolve;});
  const action=vi.fn().mockImplementation(async(date:string)=>date===older?pending:facts),{container}=mount(action),input=container.querySelector('input[type="date"]')!;
  fireEvent.change(input,{target:{value:older}});await waitFor(()=>expect(action).toHaveBeenCalledWith(older));fireEvent.change(input,{target:{value:today}});
  await waitFor(()=>expect(screen.getByTestId('leave-credit-day-type')).toHaveTextContent(en.replacementRequest.dayKind.restDay));resolveOld({state:'unavailable',reason:'cashConflict'});
  await waitFor(()=>expect(screen.queryByText(en.replacementRequest.formulaReview.errors.cashConflict)).toBeNull());expect(screen.getByTestId('leave-credit-day-type')).toHaveTextContent(en.replacementRequest.dayKind.restDay);
 });
});
