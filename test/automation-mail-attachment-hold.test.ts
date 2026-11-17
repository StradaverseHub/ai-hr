import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({target:null as unknown,relay:vi.fn(async()=>null),transport:vi.fn()}));
vi.mock('../db/client',()=>({client:async()=>[{target:state.target}],withSystemWork:<T>(work:()=>T)=>work()}));
vi.mock('../lib/internal-auth/config',()=>({internalConfig:()=>({origin:'https://fictional-mail.invalid'}),internalIssuer:()=>''}));
vi.mock('../lib/internal-auth/active-relay',()=>({readLifecycleRelayTx:state.relay}));
vi.mock('../lib/internal-auth/store',()=>({admittedAuthSql:{},readRecord:vi.fn()}));
vi.mock('../lib/internal-auth/service',()=>({assertActiveCredential:vi.fn(),InternalAuthError:class extends Error{}}));
vi.mock('../lib/internal-auth/smtp',()=>({sendSmtp:state.transport}));
import {internalAutomationMail} from '../lib/internal-auth/automation-mail';
const request={deliveryId:'10000000-0000-4000-8000-000000000001',leaseToken:'10000000-0000-4000-8000-000000000002'};
function target(module:string,extra:Record<string,unknown>){return {id:request.deliveryId,tenantId:'10000000-0000-4000-8000-000000000003',module,subjectId:'10000000-0000-4000-8000-000000000004',payload:{version:1,module,linkPath:'/lifecycle/contracts/example',mail:{id:'fixture',to:['10000000-0000-4000-8000-000000000005'],cc:[],subject:'Fictional queued message',body:'The promised document is attached.',delivery:{version:1,sender:'noreply',...extra}}},bindings:[]};}
beforeEach(()=>{state.target=null;state.relay.mockClear();state.transport.mockClear();});
describe('shared attachment transport admission',()=>{
 for(const module of ['contract_staff','probation']){
  it(`holds ${module} files while no relay is available`,async()=>{
   state.target=target(module,{assets:[{id:'frozen-file'}]});
   expect(await internalAutomationMail(request,state.transport)).toEqual({outcome:'skipped',error:'relayUnavailable'});
   expect(state.relay).toHaveBeenCalledOnce();expect(state.transport).not.toHaveBeenCalled();
  });
  it(`holds ${module} linked documents while no relay is available`,async()=>{
   state.target=target(module,{documents:[{id:'frozen-document'}]});
   expect(await internalAutomationMail(request,state.transport)).toEqual({outcome:'skipped',error:'relayUnavailable'});
   expect(state.relay).toHaveBeenCalledOnce();expect(state.transport).not.toHaveBeenCalled();
  });
 }
 it('retains ordinary word-only delivery admission and the existing Offboarding path',async()=>{
  state.target=target('contract_staff',{assets:[],documents:[]});
  expect(await internalAutomationMail(request,state.transport)).toEqual({outcome:'skipped',error:'relayUnavailable'});
  expect(state.relay).toHaveBeenCalledOnce();expect(state.transport).not.toHaveBeenCalled();
  state.target=target('off',{assets:[{id:'native-offboarding-file'}]});
  expect(await internalAutomationMail(request,state.transport)).toEqual({outcome:'skipped',error:'relayUnavailable'});
  expect(state.relay).toHaveBeenCalledTimes(2);expect(state.transport).not.toHaveBeenCalled();
 });
});
