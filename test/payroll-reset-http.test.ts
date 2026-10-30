/** Protocol-only mocks. Native permissions, effects and custody are exercised by separate real DB cases. */
import {describe,it,expect,vi} from 'vitest';
import {createModuleActionBrowserHandler} from '../lib/assistant-actions/module-action-http';
const origin='https://fixture.test',id='10000000-0000-4000-8000-000000000001',batchId='10000000-0000-4000-8000-000000000002',action='payroll.reset' as const;
const input={action,contractVersion:1,batchId,reason:'Fictional human reason',confirmResetProcessedRun:true,acknowledgePayslipLoanClaimConsequences:true};
const prepared={action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64),createdAt:'2026-10-30T00:00:00Z',expiresAt:'2026-10-30T00:10:00Z',content:input,review:{batchId,companyId:id,companyName:'Fictional company',payPeriodId:id,payPeriod:'2026-10',runType:'regular',runSeq:1,cycleName:null,beforeStatus:'processed',afterStatus:'draft',payslipsToDelete:1,appliedRepaymentRows:0,affectedLoans:0,paidClaimsToRevert:0,consumedItemsToRelease:0,recalculationMarked:false,statutoryReportCount:0,recordedPaymentSummaryExport:false,consequence:'delete_payslips_clear_totals_unwind_native_loans_claims_consumption_and_recalc_keep_draft_inputs',downstreamMeaning:'recorded_exports_and_reports_retained_no_bank_reversal_or_filing_withdrawal',parentAndSiblings:'unchanged'}};
function fixture(){
 const session={serverOnly:'Fictional authenticated session'},retired={kind:'retired',receipt:{action,contractVersion:1,actionId:id,state:'discarded'}};
 const owner={choices:vi.fn(async()=>({kind:'choices',batches:[]} as unknown)),list:vi.fn(async()=>({kind:'payroll_reset_review_index',reviews:[]} as unknown)),prepare:vi.fn(async()=>({kind:'prepared',review:prepared} as unknown)),reopen:vi.fn(async()=>({kind:'prepared',review:prepared} as unknown)),confirm:vi.fn(async()=>retired as unknown),discard:vi.fn(async()=>retired as unknown)};
 const services={authenticate:vi.fn(async()=>session),payrollReset:owner,list:vi.fn(async()=>({kind:'module_review_index',reviews:[]} as unknown)),prepare:vi.fn(async()=>prepared as unknown),reopen:vi.fn(async()=>prepared as unknown),confirm:vi.fn(async()=>retired as unknown),discard:vi.fn(async()=>retired as unknown)};
 return{owner,services,session,handle:createModuleActionBrowserHandler(services,{publicOrigin:origin})};
}
const request=(body:unknown)=>new Request(origin+'/api/assistant/module-actions',{method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)});
describe('closed Payroll reset transport',()=>{
 it('routes explicit choices, preparation and same-ID recovery to the registered owner with the authenticated session',async()=>{
  const f=fixture();expect((await f.handle(request({action,operation:'choices'}))).status).toBe(200);expect(f.owner.choices).toHaveBeenCalledWith(f.session,undefined);
  const response=await f.handle(request({action,operation:'prepare',input}));expect(response.status).toBe(200);expect(await response.json()).toEqual({kind:'prepared',review:prepared});expect(f.owner.prepare).toHaveBeenCalledWith(f.session,input);expect(f.services.prepare).not.toHaveBeenCalled();
  expect((await f.handle(request({action,operation:'reopen',actionId:id}))).status).toBe(200);expect(f.owner.reopen).toHaveBeenCalledWith(f.session,id);
 });
 it('rejects posted authority, money and missing human acknowledgement before authentication',async()=>{
  const f=fixture();for(const patch of [{net:99},{userId:id},{reviewedDigest:'b'.repeat(64)},{acknowledgePayslipLoanClaimConsequences:false}])expect((await f.handle(request({action,operation:'prepare',input:{...input,...patch}}))).status).toBe(400);expect(f.services.authenticate).not.toHaveBeenCalled();expect(f.owner.prepare).not.toHaveBeenCalled();
 });
 it('refuses a retargeted response, wrong recovered ID and private source fields',async()=>{
  const f=fixture(),other='10000000-0000-4000-8000-000000000003';f.owner.prepare.mockResolvedValueOnce({kind:'prepared',review:{...prepared,content:{...input,batchId:other},review:{...prepared.review,batchId:other}}});expect((await f.handle(request({action,operation:'prepare',input}))).status).toBe(503);
  f.owner.reopen.mockResolvedValueOnce({kind:'prepared',review:{...prepared,actionId:other}});expect((await f.handle(request({action,operation:'reopen',actionId:id}))).status).toBe(503);
  f.owner.prepare.mockResolvedValueOnce({kind:'prepared',review:{...prepared,sourceDigest:'PRIVATE source witness'}});const response=await f.handle(request({action,operation:'prepare',input}));expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain('PRIVATE');
 });
});
