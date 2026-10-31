/** Pure contract coverage; no action registration, execution or native proof claim. */
import {describe,expect,it} from 'vitest';
import {ReviewedPayrollResetHumanContent as Human,ReviewedPayrollResetNomination as Nomination,ReviewedPayrollResetReview as Review} from '../lib/assistant-actions/reviewed-payroll-reset-contract';
const batchId='10000000-0000-4000-8000-000000000001';
const human={action:'payroll.reset',contractVersion:1,batchId,reason:'  Correct a keyed input  ',confirmResetProcessedRun:true,acknowledgePayslipLoanClaimConsequences:true};
describe('proposed Payroll reset human boundary',()=>{
 it('accepts only a run nomination and requires the human reason and both explicit acknowledgements',()=>{
  expect(Nomination.parse({action:'payroll.reset',contractVersion:1,batchId})).toEqual({action:'payroll.reset',contractVersion:1,batchId});
  expect(Human.parse(human).reason).toBe('Correct a keyed input');
  for(const value of [{...human,reason:'  '},{...human,confirmResetProcessedRun:false},{...human,acknowledgePayslipLoanClaimConsequences:false}])expect(Human.safeParse(value).success).toBe(false);
 });
 it('rejects model-supplied counts, money, effect references, identities, bypass flags and executable content',()=>{
  for(const [key,value] of Object.entries({payslipsToDelete:0,basicSalary:0,resetEventId:batchId,userId:batchId,employmentId:batchId,skipPermission:true,sql:'delete from payslip'})){
   expect(Human.safeParse({...human,[key]:value}).success,key).toBe(false);
   expect(Nomination.safeParse({action:'payroll.reset',contractVersion:1,batchId,[key]:value}).success,key).toBe(false);
  }
 });
 it('bounds every native source count and states destructive and retained downstream consequences explicitly',()=>{
  const review={batchId,companyId:batchId,companyName:'Fictional company',payPeriodId:batchId,payPeriod:'2026-10',runType:'regular',runSeq:1,cycleName:null,beforeStatus:'processed',afterStatus:'draft',payslipsToDelete:4,appliedRepaymentRows:2,affectedLoans:1,paidClaimsToRevert:3,consumedItemsToRelease:5,recalculationMarked:true,statutoryReportCount:2,recordedPaymentSummaryExport:true,consequence:'delete_payslips_clear_totals_unwind_native_loans_claims_consumption_and_recalc_keep_draft_inputs',downstreamMeaning:'recorded_exports_and_reports_retained_no_bank_reversal_or_filing_withdrawal',parentAndSiblings:'unchanged'};
  expect(Review.safeParse(review).success).toBe(true);
  for(const patch of [{payslipsToDelete:-1},{paidClaimsToRevert:0.5},{consumedItemsToRelease:10001},{affectedLoans:3},{afterStatus:'processed'},{bankPaymentReversed:true}])expect(Review.safeParse({...review,...patch}).success).toBe(false);
 });
});
