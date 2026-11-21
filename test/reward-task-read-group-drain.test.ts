import {expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {createBackgroundReadAdmission} from '../db/background-read-admission';
import {pendingRewardTasks} from '../packs/rewards/service';

const io=vi.hoisted(()=>({tenant:vi.fn()}));
vi.mock('../core/module-gate',async original=>({...await original<typeof import('../core/module-gate')>(),withRewardsTenant:io.tenant}));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function query<T>(result:Promise<T>){const value={from:()=>value,where:()=>value,innerJoin:()=>value,leftJoin:()=>value,orderBy:()=>value,limit:()=>value,then:result.then.bind(result)};return value;}

it('holds the real Rewards task provider through returned-unit and subsequent decision IO after the approval owner fails',async()=>{
 const approval=deferred<never[]>(),returned=deferred<{id:string;kind:string;name:string;cycle:string;toSeat:string}[]>();
 const decision=deferred<{action:string;fromStage:string;toStage:string;reason:string;actorId:string;actorName:null;createdAt:Date}[]>();
 const at=new Date('2026-11-07T00:00:00Z');let decisionEntered=false;
 const select=vi.fn().mockReturnValueOnce(query(Promise.resolve([
  {id:'approval',companyId:'company',status:'bg',createdAt:at},
  {id:'returned',companyId:'company',status:'draft',createdAt:at},
 ]))).mockReturnValueOnce(query(approval.promise)).mockReturnValueOnce(query(returned.promise)).mockImplementationOnce(()=>{decisionEntered=true;return query(decision.promise);});
 io.tenant.mockImplementation(async(_ctx:unknown,read:(tx:unknown)=>unknown)=>read({execute:async()=>[],select}));
 const gate=createBackgroundReadAdmission({capacity:1,maxWaiting:2,waitMs:1000});
 const ctx={tenantId:'fictional-tenant'} as SessionContext,original=new Error('approval owner failed');
 let finished=false,nextEntered=false;
 const first=gate.run(ctx.tenantId,()=>pendingRewardTasks(ctx,undefined));
 const observed=first.then(()=>{finished=true;return null;},error=>{finished=true;return error;});
 const next=gate.run('another-tenant',async()=>{nextEntered=true;});
 await vi.waitFor(()=>expect(select).toHaveBeenCalledTimes(3));approval.reject(original);
 await Promise.resolve();expect(finished).toBe(false);expect(nextEntered).toBe(false);
 returned.resolve([{id:'returned',kind:'annual',name:'Fictional returned review',cycle:'2026',toSeat:'bu'}]);
 await vi.waitFor(()=>expect(decisionEntered).toBe(true));
 expect(finished).toBe(false);expect(gate.snapshot()).toMatchObject({active:1,waiting:1});
 decision.resolve([{action:'return',fromStage:'bg',toStage:'draft',reason:'Fictional reason',actorId:'actor',actorName:null,createdAt:at}]);
 expect(await observed).toBe(original);await next;expect(nextEntered).toBe(true);
 expect(gate.snapshot()).toMatchObject({active:0,waiting:0});
});
