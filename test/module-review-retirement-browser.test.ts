/** Authored UNRUN: protocol separation only; actual login ownership is separately tested in SQL. */
import {describe,expect,it,vi} from 'vitest';
import {createModuleActionBrowserHandler} from '../lib/assistant-actions/module-action-http';
import {createOwnLeaveBrowserHandler} from '../lib/assistant-actions/own-leave-http';

const id='76ead19c-f56b-46be-8cab-c3250438d637',session={selected:'actual server session'};
const cases=[
 {action:'notifications.email_preferences.save',owner:'notification'},
 {action:'ess.profile.request',owner:'profile'},
 {action:'claims.draft.save',owner:'claims'},
 {action:'claims.submit',owner:'claimSubmission'},
 {action:'performance.review.acknowledge',owner:'performance'},
 {action:'performance.onehr.plan.acknowledge',owner:'performance'},
 {action:'system_testing.execution.save',owner:'testing'},
] as const;
function request(value:unknown){return new Request('https://fixture.test/api/assistant/module-actions',{method:'POST',headers:{origin:'https://fixture.test','content-type':'application/json'},body:JSON.stringify(value)});}
function fixture(){
 const authenticate=vi.fn(async()=>session),prepare=vi.fn(async()=>({})),confirm=vi.fn(async()=>({})),reopen=vi.fn(async()=>({}));
 const discard=vi.fn(async(_session:unknown,value:unknown)=>{const p=value as {action:string;actionId:string;contractVersion:number};return{kind:'retired',receipt:{action:p.action,actionId:p.actionId,contractVersion:p.contractVersion,state:'discarded'}};});
 const plain={list:vi.fn(async()=>({})),prepare,confirm,reopen,discard};
 const handle=createModuleActionBrowserHandler({...plain,authenticate,profile:plain,claims:{...plain,readDraft:vi.fn()},claimSubmission:plain,performance:plain,testing:{...plain,readExecution:vi.fn()}},{publicOrigin:'https://fixture.test'});
 return{handle,authenticate,prepare,confirm,reopen,discard};
}
describe.each(cases)('$action privacy retirement transport',({action,owner})=>{
 const confirmation={action,contractVersion:1,actionId:id};
 const packet=(operation:'discard'|'confirm',value:unknown=confirmation)=>({...(owner==='notification'?{}:{action}),operation,confirmation:value});
 it('routes metadata-only cleanup to discard without preparing, reopening or confirming',async()=>{
  const f=fixture(),response=await f.handle(request(packet('discard')));
  expect(response.status).toBe(200);expect(await response.json()).toEqual({kind:'retired',receipt:{...confirmation,state:'discarded'}});
  expect(f.discard).toHaveBeenCalledTimes(1);expect(f.discard).toHaveBeenCalledWith(session,confirmation);
  expect(f.prepare).not.toHaveBeenCalled();expect(f.confirm).not.toHaveBeenCalled();expect(f.reopen).not.toHaveBeenCalled();
 });
 it('still requires the exact review token for confirmation and rejects posted privacy/authority fields',async()=>{
  for(const body of [packet('confirm'),packet('discard',{...confirmation,actorId:id}),packet('discard',{...confirmation,body:'private text'}),packet('discard',{...confirmation,employmentId:id})]){
   const f=fixture();expect((await f.handle(request(body))).status).toBe(400);expect(f.authenticate).not.toHaveBeenCalled();expect(f.discard).not.toHaveBeenCalled();expect(f.confirm).not.toHaveBeenCalled();
  }
 });
 it('retains the old closed discard envelope for an already open browser without treating its digest as effect authority',async()=>{
  const f=fixture(),old={...confirmation,reviewedDigest:'a'.repeat(64)};expect((await f.handle(request(packet('discard',old)))).status).toBe(200);expect(f.discard).toHaveBeenCalledTimes(1);expect(f.discard).toHaveBeenCalledWith(session,old);expect(f.confirm).not.toHaveBeenCalled();
 });
});
it('permits Own Leave metadata cleanup but never a digest-free Leave confirmation',async()=>{
 const discard=vi.fn(async()=>({kind:'retired',receipt:{actionId:id,contractVersion:1,state:'discarded'}})),confirm=vi.fn(async()=>({})),authenticate=vi.fn(async()=>session);
 const handle=createOwnLeaveBrowserHandler({authenticate,list:vi.fn(),prepare:vi.fn(),reopen:vi.fn(),confirm,discard},{publicOrigin:'https://fixture.test'}),confirmation={actionId:id,contractVersion:1};
 expect((await handle(request({operation:'discard',confirmation}))).status).toBe(200);expect(discard).toHaveBeenCalledTimes(1);expect(discard).toHaveBeenCalledWith(session,confirmation);
 authenticate.mockClear();expect((await handle(request({operation:'confirm',confirmation}))).status).toBe(400);expect(authenticate).not.toHaveBeenCalled();expect(confirm).not.toHaveBeenCalled();
});
