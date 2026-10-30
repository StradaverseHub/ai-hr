/** Transport admission and correlation only; DB fixtures establish native authority/effects. */
import {describe,expect,it,vi} from 'vitest';
import {createModuleActionBrowserHandler} from '../lib/assistant-actions/module-action-http';
import {EMPLOYEE_DRAFT_DISCARD_ACTION as action} from '../lib/assistant-actions/employee-draft-discard-contract';
const origin='https://fixture.test',actionId='11111111-1111-4111-8111-111111111111',draftId='22222222-2222-4222-8222-222222222222',companyId='33333333-3333-4333-8333-333333333333';
const confirmation={action,contractVersion:1,actionId,draftId,companyId,reviewedDigest:'a'.repeat(64),consent:'discard_saved_draft_captured_input'};
const retired={kind:'retired',receipt:{action,contractVersion:1,actionId,state:'discarded'}};
function fixture(){
 const session={serverOnly:'fictional-transport-session'},authenticate=vi.fn(async()=>session),fallback=vi.fn(async()=>{throw Error('Wrong action owner');});
 const owner={choices:vi.fn(async()=>({kind:'unavailable'})),list:fallback,prepare:fallback,reopen:vi.fn(async()=>retired),confirm:vi.fn(async()=>retired),discard:vi.fn(async()=>retired)};
 const handle=createModuleActionBrowserHandler({authenticate,employeeDraftDiscard:owner,list:fallback,prepare:fallback,reopen:fallback,confirm:fallback,discard:fallback},{publicOrigin:origin});
 return{session,authenticate,owner,fallback,handle};
}
function request(packet:unknown,headers:Record<string,string>={},method='POST'){
 return new Request(origin+'/api/assistant/module-actions',{method,headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin',...headers},...(method==='POST'?{body:JSON.stringify(packet)}:{})});
}
describe('saved draft discard fixed browser owner',()=>{
 it('dispatches the complete explicit confirmation exactly once to the authenticated owner',async()=>{const f=fixture(),response=await f.handle(request({action,operation:'confirm',confirmation}));expect(response.status).toBe(200);expect(await response.json()).toEqual(retired);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(f.owner.confirm).toHaveBeenCalledExactlyOnceWith(f.session,confirmation);expect(f.owner.prepare).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();});
 it('retires review custody through the fixed discard method without deleting the native draft',async()=>{const f=fixture(),retirement={action,contractVersion:1,actionId};expect((await f.handle(request({action,operation:'retire',confirmation:retirement}))).status).toBe(200);expect(f.owner.discard).toHaveBeenCalledExactlyOnceWith(f.session,retirement);expect(f.owner.confirm).not.toHaveBeenCalled();});
 it.each([{...confirmation,consent:'yes'},{...confirmation,draftId:undefined},{...confirmation,companyId:undefined},{...confirmation,ctx:{userId:actionId}},{...confirmation,receipt:{eventId:actionId}}])('rejects incomplete consent, subject or posted authority before authentication',async value=>{const f=fixture();expect((await f.handle(request({action,operation:'confirm',confirmation:value}))).status).toBe(400);expect(f.authenticate).not.toHaveBeenCalled();expect(f.owner.confirm).not.toHaveBeenCalled();});
 it.each([{authorization:'Bearer forged'},{origin:'https://foreign.test'},{'sec-fetch-site':'cross-site'}])('rejects foreign browser admission before source access',async headers=>{const f=fixture();expect((await f.handle(request({action,operation:'confirm',confirmation},headers))).status).toBe(403);expect(f.authenticate).not.toHaveBeenCalled();});
 it('rejects GET effects',async()=>{const f=fixture();expect((await f.handle(request({action,operation:'confirm',confirmation},{},'GET'))).status).toBe(405);expect(f.authenticate).not.toHaveBeenCalled();});
 it('refuses a different review receipt rather than showing it as this confirmation',async()=>{const f=fixture();f.owner.confirm.mockResolvedValueOnce({...retired,receipt:{...retired.receipt,actionId:draftId}});expect((await f.handle(request({action,operation:'confirm',confirmation}))).status).toBe(503);expect(f.owner.confirm).toHaveBeenCalledOnce();});
 it('keeps an uncertain native outcome unavailable without retry or diagnostic leakage',async()=>{const f=fixture();f.owner.confirm.mockRejectedValueOnce(Error('PRIVATE_SQL_AND_SOURCE'));const response=await f.handle(request({action,operation:'confirm',confirmation}));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});expect(f.owner.confirm).toHaveBeenCalledOnce();});
});
