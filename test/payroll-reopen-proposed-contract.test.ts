import {describe,expect,it} from 'vitest';
import {ReviewedPayrollReopenHumanContent as Human,ReviewedPayrollReopenNomination as Nomination,ReviewedPayrollReopenSourceReceipt as Receipt,ReviewedPayrollReopenWarnings as Warnings} from '../lib/assistant-actions/reviewed-payroll-reopen-contract';
const id='10000000-0000-4000-8000-000000000001',base={action:'payroll.reopen',contractVersion:1,batchId:id};
describe('proposed Payroll reopen boundary (unmounted)',()=>{
 it('allows only a run nomination and requires a bounded human reason and both explicit consents',()=>{
  expect(Nomination.parse(base)).toEqual(base);expect(Human.safeParse(base).success).toBe(false);
  const content={...base,reason:'  correct run  ',confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true};
  expect(Human.parse(content).reason).toBe('correct run');
  for(const extra of [{reason:' '},{reason:'x'.repeat(4001)},{confirmReopenClosedRun:false},{acknowledgeRecordedDownstreamWarnings:false},{force:true},{amount:10},{userId:id},{service:'unlockClosedBatch'}])expect(Human.safeParse({...content,...extra}).success).toBe(false);
 });
 it('requires coherent native warning counts without treating an export as bank settlement',()=>{
  const warnings={paymentDisbursed:true,statutoryFiled:false,statutoryFiledCount:0,statutoryReportCount:2};
  expect(Warnings.safeParse(warnings).success).toBe(true);
  for(const extra of [{statutoryFiled:true},{statutoryFiledCount:3},{settlementVerified:true}])expect(Warnings.safeParse({...warnings,...extra}).success).toBe(false);
 });
 it('requires exact conditional parent proof and separates historical reopening from current reclosed state',()=>{
  const receipt={kind:'reopened',batchId:id,payPeriodId:id,statusHistoryId:id,unlockedEventId:id,periodReopenedEventId:null,parentWasReopened:false,currentStatus:'closed',currentPeriodStatus:'closed',proof:'exact_unlock_history_batch_event_conditional_parent_event',semantics:'historical_reopen_not_reset_recalculated_or_payment_reversed',replayed:true};
  expect(Receipt.safeParse(receipt).success).toBe(true);
  expect(Receipt.safeParse({...receipt,parentWasReopened:true}).success).toBe(false);
  expect(Receipt.safeParse({...receipt,periodReopenedEventId:id}).success).toBe(false);
  expect(Receipt.safeParse({...receipt,paymentReversed:true}).success).toBe(false);
 });
});
