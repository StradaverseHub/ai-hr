/** Protocol-only mocks. Native permissions, effects and custody are exercised by separate real DB cases. */
import {describe,it,expect,vi} from 'vitest';
import {PayrollReopen as C} from '../lib/assistant-actions/reviewed-payroll-reopen-contract';
import {checkGenericPacket,readGenericModuleActionResponse} from '../components/assistant/generic-module-action-transport';
import {createModuleActionBrowserHandler} from '../lib/assistant-actions/module-action-http';
const origin='https://fixture.test',id='10000000-0000-4000-8000-000000000001',batchId='10000000-0000-4000-8000-000000000002',action='payroll.reopen' as const;
const input={action,contractVersion:1,batchId,reason:'Fictional human reason',confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true};
const prepared={action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64),createdAt:'2026-10-30T00:00:00Z',expiresAt:'2026-10-30T00:10:00Z',content:input,review:{batchId,companyId:id,companyName:'Fictional company',payPeriodId:id,payPeriod:'2026-10',runType:'regular',runSeq:1,cycleName:null,beforeStatus:'closed',afterStatus:'processed',beforePeriodStatus:'closed',afterPeriodStatus:'open',parentWillReopen:true,warnings:{paymentDisbursed:true,statutoryFiled:true,statutoryFiledCount:1,statutoryReportCount:2},paymentWarningMeaning:'recorded_payment_summary_export_not_verified_bank_settlement',consequence:'enable_later_payroll_edits_no_recalculation_payment_reversal_or_statutory_withdrawal'}};
function fixture(){
 const session={serverOnly:'Fictional authenticated session'},retired={kind:'retired',receipt:{action,contractVersion:1,actionId:id,state:'discarded'}};
 const owner={choices:vi.fn(async()=>({kind:'choices',batches:[]} as unknown)),list:vi.fn(async()=>({kind:'payroll_reopen_review_index',reviews:[]} as unknown)),prepare:vi.fn(async()=>({kind:'prepared',review:prepared} as unknown)),reopen:vi.fn(async()=>({kind:'prepared',review:prepared} as unknown)),confirm:vi.fn(async()=>retired as unknown),discard:vi.fn(async()=>retired as unknown)};
 const services={authenticate:vi.fn(async()=>session),payrollReopen:owner,list:vi.fn(async()=>({kind:'module_review_index',reviews:[]} as unknown)),prepare:vi.fn(async()=>prepared as unknown),reopen:vi.fn(async()=>prepared as unknown),confirm:vi.fn(async()=>retired as unknown),discard:vi.fn(async()=>retired as unknown)};
 return{owner,services,session,handle:createModuleActionBrowserHandler(services,{publicOrigin:origin})};
}
const request=(body:unknown)=>new Request(origin+'/api/assistant/module-actions',{method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)});
describe('closed Payroll reopening transport',()=>{
 it('routes explicit choices, preparation and same-ID recovery to the registered owner with the authenticated session',async()=>{
  const f=fixture();expect((await f.handle(request({action,operation:'choices'}))).status).toBe(200);expect(f.owner.choices).toHaveBeenCalledWith(f.session,undefined);
  const response=await f.handle(request({action,operation:'prepare',input}));expect(response.status).toBe(200);expect(await response.json()).toEqual({kind:'prepared',review:prepared});expect(f.owner.prepare).toHaveBeenCalledWith(f.session,input);expect(f.services.prepare).not.toHaveBeenCalled();
  expect((await f.handle(request({action,operation:'reopen',actionId:id}))).status).toBe(200);expect(f.owner.reopen).toHaveBeenCalledWith(f.session,id);
 });
 it('rejects posted authority, money and missing human acknowledgement before authentication',async()=>{
  const f=fixture();for(const patch of [{net:99},{userId:id},{reviewedDigest:'b'.repeat(64)},{acknowledgeRecordedDownstreamWarnings:false}])expect((await f.handle(request({action,operation:'prepare',input:{...input,...patch}}))).status).toBe(400);expect(f.services.authenticate).not.toHaveBeenCalled();expect(f.owner.prepare).not.toHaveBeenCalled();
 });
 it('refuses a retargeted response, wrong recovered ID and private source fields',async()=>{
  const f=fixture(),other='10000000-0000-4000-8000-000000000003';f.owner.prepare.mockResolvedValueOnce({kind:'prepared',review:{...prepared,content:{...input,batchId:other},review:{...prepared.review,batchId:other}}});expect((await f.handle(request({action,operation:'prepare',input}))).status).toBe(503);
  f.owner.reopen.mockResolvedValueOnce({kind:'prepared',review:{...prepared,actionId:other}});expect((await f.handle(request({action,operation:'reopen',actionId:id}))).status).toBe(503);
  f.owner.prepare.mockResolvedValueOnce({kind:'prepared',review:{...prepared,sourceDigest:'PRIVATE source witness'}});const response=await f.handle(request({action,operation:'prepare',input}));expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain('PRIVATE');
 });
 it('recovers the same committed large review through the actual handler and split UTF-8 streaming decoder',async()=>{
  const f=fixture(),longInput={...input,reason:'理'.repeat(4000)},longReview={...prepared,content:longInput,review:{...prepared.review,companyName:'公'.repeat(4000),cycleName:'月'.repeat(4000)}};
  let committed:unknown=null;f.owner.prepare.mockImplementationOnce(async()=>{committed={kind:'prepared',review:longReview};return committed;});f.owner.reopen.mockImplementationOnce(async()=>committed);
  const value={action,operation:'prepare',input:longInput};expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(20480);
  for(const packetValue of [value,{action,operation:'reopen',actionId:id}]){
   const response=await f.handle(request(packetValue));expect(response.status).toBe(200);const bytes=new Uint8Array(await response.arrayBuffer());expect(bytes.byteLength).toBeGreaterThan(32768);expect(bytes.byteLength).toBeLessThan(131072);
   const body=new ReadableStream<Uint8Array>({start(controller){for(let offset=0;offset<bytes.length;offset+=2003)controller.enqueue(bytes.slice(offset,offset+2003));controller.close();}}),packet=checkGenericPacket(packetValue);if(!packet)throw Error('Expected valid reopening packet');
   const parsed=await readGenericModuleActionResponse(new Response(body,{headers:{'Content-Type':'application/json'}}),packet);expect(parsed.kind).toBe('prepared');const checked=C.Prepared.parse((parsed as unknown as {review:unknown}).review);expect(checked).toEqual(longReview);
  }
  expect(f.owner.prepare).toHaveBeenCalledTimes(1);expect(f.owner.reopen).toHaveBeenCalledWith(f.session,id);
 });
 it('retains request and expanded response bounds for reopening',async()=>{
  const f=fixture();expect((await f.handle(request({action,operation:'prepare',input:{...input,reason:'理'.repeat(7000)}}))).status).toBe(400);expect(f.owner.prepare).not.toHaveBeenCalled();
  const valid={action,operation:'reopen',actionId:id},packet=checkGenericPacket(valid);if(!packet)throw Error('Expected reopening packet');await expect(readGenericModuleActionResponse(new Response(' '.repeat(131073),{headers:{'Content-Type':'application/json'}}),packet)).rejects.toThrow();
 });
});
