import {it,expect,vi} from 'vitest';
import {createModuleActionBrowserHandler} from '../lib/assistant-actions/module-action-http';
import {OffboardingStepUndo as C} from '../lib/assistant-actions/offboarding-step-undo-contract';
const id='00000000-0000-4000-8000-000000000001',origin='https://fictional.test';
const request=(body:unknown,extra={})=>new Request(origin+'/api/assistant/module-actions',{method:'POST',headers:{origin,'content-type':'application/json',...extra},body:JSON.stringify(body)});
it('routes one strict human undo confirmation only to its dedicated authenticated owner',async()=>{
 const receipt={kind:'completed',receipt:{action:C.action,contractVersion:1,actionId:id,state:'completed',receipt:{caseId:id,stepKey:'resign_submit',status:'in_progress',stepEventId:id,reopeningEventId:null}}};
 const packet={action:C.action,operation:'confirm',confirmation:{action:C.action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64)}};
 const fixed={choices:vi.fn(),list:vi.fn(),prepare:vi.fn(),reopen:vi.fn(),confirm:vi.fn(async()=>receipt),discard:vi.fn()};
 const owners={authenticate:vi.fn(async()=>({session:true})),list:vi.fn(),prepare:vi.fn(),reopen:vi.fn(),confirm:vi.fn(),discard:vi.fn(),offboardingStepUndo:fixed};
 const handle=createModuleActionBrowserHandler(owners,{publicOrigin:origin});const response=await handle(request(packet));expect(response.status).toBe(200);expect(await response.json()).toEqual(receipt);expect(fixed.confirm).toHaveBeenCalledExactlyOnceWith({session:true},packet.confirmation);expect(owners.confirm).not.toHaveBeenCalled();expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect((await handle(request({...packet,actor:id}))).status).toBe(400);expect(fixed.confirm).toHaveBeenCalledOnce();
 expect((await handle(request(packet,{origin:'https://hostile.test'}))).status).toBe(403);expect(fixed.confirm).toHaveBeenCalledOnce();
 fixed.confirm.mockResolvedValueOnce({...receipt,receipt:{...receipt.receipt,actionId:'00000000-0000-4000-8000-000000000002'}});expect((await handle(request(packet))).status).toBe(503);
});
