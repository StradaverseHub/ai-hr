/** Pure forwarding/privacy controls; none proves a native policy or wait. */
import {expect,it} from 'vitest';
import {rewardsPolicyDiagnostics} from './prototypes/rewards-audit-policy-diagnostic';
it('awaits the actual callback and preserves the exact successful value or original failure identity',async()=>{
 const diagnostics=rewardsPolicyDiagnostics(),value={native:'model only'};let finish!:(resolved:typeof value)=>void,settled=false;
 const pending=new Promise<typeof value>(resolve=>{finish=resolve;});const observed=diagnostics.callback('tenant-callback',()=>pending);void observed.then(()=>{settled=true;});
 await Promise.resolve();expect(settled).toBe(false);finish(value);expect(await observed).toBe(value);
 const error=Object.assign(Error('private message'),{code:'42501',query:'private SQL',parameters:['private'],stack:'private stack'});
 await expect(diagnostics.callback('bank-source',()=>Promise.reject(error))).rejects.toBe(error);
 expect(diagnostics.snapshot()).toEqual({kind:'UNINSTALLED_REWARDS_POLICY_FAILURE_DIAGNOSTIC',releaseAuthorized:false,complete:true,observations:[{kind:'callback-refused',phase:'bank-source',sqlstate:'42501'}]});
});
it('records only closed native SQLSTATE through bounded data causes without reading private or hostile properties',async()=>{
 const diagnostics=rewardsPolicyDiagnostics(),native=Object.assign(Error('private'),{code:'55000'}),outer=Error('private SQL and values',{cause:native});
 Object.defineProperty(outer,'stack',{get(){throw Error('must not inspect stack');}});
 await expect(diagnostics.callback('agent-guard',()=>{throw outer;})).rejects.toBe(outer);
 const getter={get code(){throw Error('must not inspect code getter');},get cause(){throw Error('must not inspect cause getter');}};
 await expect(diagnostics.callback('catalogue-source',()=>{throw getter;})).rejects.toBe(getter);
 const malformed={code:'PRIVATE',cause:{code:'22023'}};await expect(diagnostics.callback('catalogue-lock',()=>{throw malformed;})).rejects.toBe(malformed);
 expect(diagnostics.snapshot().observations).toEqual([{kind:'callback-refused',phase:'agent-guard',sqlstate:'55000'},{kind:'callback-refused',phase:'catalogue-source',sqlstate:null},{kind:'callback-refused',phase:'catalogue-lock',sqlstate:'22023'}]);
 for(const ending of ['\n','\r','\r\n','\u2028','\u2029']){
  const suffixed=Object.assign(Error('private suffix'),{code:'42501'+ending});
  await expect(diagnostics.callback('bank-source',()=>{throw suffixed;})).rejects.toBe(suffixed);
  expect(diagnostics.snapshot().observations.at(-1)).toEqual({kind:'callback-refused',phase:'bank-source',sqlstate:null});
 }
 const hostile=new Proxy({},{getOwnPropertyDescriptor(){throw Error('private reflective payload');}});
 await expect(diagnostics.callback('bank-actor',()=>{throw hostile;})).rejects.toBe(hostile);
 expect(diagnostics.snapshot().complete).toBe(false);expect(diagnostics.snapshot().observations.at(-1)).toEqual({kind:'callback-refused',phase:'bank-actor',sqlstate:null});
 expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/private|getter|stack|parameters|query/);
});
it('bounds observations honestly and keeps native wait booleans separate from acceptance',async()=>{
 const diagnostics=rewardsPolicyDiagnostics(),error=Error('same primary');
 diagnostics.wait({kind:'wait-unavailable',waitingPresent:true,holderPresent:true,waitingActive:true,waitingOnLock:false,ownedBlocking:false,waitingFloorWrite:false,waitingHistoryLock:false,waitingStatementOlderThanWindow:true});
 for(let i=0;i<64;i++)await expect(diagnostics.callback('tenant-callback',()=>{throw error;})).rejects.toBe(error);
 const report=diagnostics.snapshot();expect(report.complete).toBe(false);expect(report.observations).toHaveLength(64);expect(report.releaseAuthorized).toBe(false);expect(Object.isFrozen(report.observations)).toBe(true);
});

import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {rewardPolicyObservedCallback,rewardPolicyObservedParse} from './prototypes/rewards-audit-policy-observation-context';
it('observes a frozen initialization-time callback through the current owner while forwarding actual arguments and results',async()=>{
 let current:ReturnType<typeof rewardsPolicyDiagnostics>|undefined;
 const value=Object.freeze({private:'never serialized'}),error=Object.freeze({code:'42501',private:'never serialized'}),calls:unknown[][]=[];
 const actual=Object.freeze(async(...args:unknown[])=>{calls.push(args);if(args[0]===error)throw error;return value;});
 // Capture ONCE before there is a case owner, as the real review-store factory does.
 const captured=Object.freeze((...args:unknown[])=>rewardPolicyObservedCallback(()=>current,'bank-interval',()=>actual(...args)));
 expect(await captured(value,17)).toBe(value);const first=rewardsPolicyDiagnostics();current=first;
 expect(await captured(value,23)).toBe(value);await expect(captured(error,31)).rejects.toBe(error);await first.drain();
 expect(calls).toEqual([[value,17],[value,23],[error,31]]);
 expect(first.snapshot().observations).toEqual([{kind:'callback-returned',phase:'bank-interval'},{kind:'callback-refused',phase:'bank-interval',sqlstate:'42501'}]);
 current=undefined;expect(await captured(value,41)).toBe(value);expect(first.snapshot().observations).toHaveLength(2);
 const second=rewardsPolicyDiagnostics();current=second;expect(await captured(value,43)).toBe(value);await second.drain();expect(second.snapshot().observations).toEqual([{kind:'callback-returned',phase:'bank-interval'}]);
});
it('decorates only parse without mutating the schema and preserves receiver, all arguments and synchronous return/error identity',()=>{
 const diagnostics=rewardsPolicyDiagnostics(),value=Object.freeze({private:'native model value'}),failure=Object.freeze({code:'22023',private:'sensitive'});let calls=0,reads=0;
 const actual={field:value,get untouched(){reads++;return value;},parse(this:{field:typeof value},...args:unknown[]){calls++;expect(this).toBe(actual);expect(args[1]).toBe(value);if(args[0]===failure)throw failure;return this.field;}};
 const original=actual.parse,wrapped=rewardPolicyObservedParse(actual,()=>diagnostics,'bank-stored-parse');
 expect(actual.parse).toBe(original);expect(wrapped.field).toBe(value);expect(reads).toBe(0);expect(wrapped.untouched).toBe(value);expect(reads).toBe(1);
 expect(wrapped.parse(17,value)).toBe(value);let caught:unknown;try{wrapped.parse(failure,value);}catch(error){caught=error;}expect(caught).toBe(failure);expect(calls).toBe(2);expect(actual.parse).toBe(original);
 expect(diagnostics.snapshot().observations).toEqual([{kind:'callback-returned',phase:'bank-stored-parse'},{kind:'callback-refused',phase:'bank-stored-parse',sqlstate:'22023'}]);expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/sensitive|private|native model/);
 const hostile={get parse(){throw failure;}},forwarded=rewardPolicyObservedParse(hostile,()=>diagnostics,'bank-stored-parse');let getterFailure:unknown;try{void forwarded.parse;}catch(error){getterFailure=error;}expect(getterFailure).toBe(failure);expect(diagnostics.snapshot().observations).toHaveLength(2);
});
it('forwards the actual Zod parse including options and genuine refusal without wrapping human schemas',()=>{
 const diagnostics=rewardsPolicyDiagnostics(),actual=z.object({id:z.string()}).strict(),human=z.object({human:z.boolean()}).strict(),original=actual.parse,humanParse=human.parse;
 const wrapped=rewardPolicyObservedParse(actual,()=>diagnostics,'catalogue-metadata-parse'),input={id:'fictional'};
 expect(wrapped.parse(input,{reportInput:false})).toEqual(actual.parse(input,{reportInput:false}));expect(actual.parse).toBe(original);expect(human.parse).toBe(humanParse);
 expect(()=>wrapped.parse({id:17},{reportInput:false})).toThrow(z.ZodError);expect(human.parse({human:true})).toEqual({human:true});
 expect(diagnostics.snapshot().observations).toEqual([{kind:'callback-returned',phase:'catalogue-metadata-parse'},{kind:'callback-refused',phase:'catalogue-metadata-parse',sqlstate:null}]);
});
it('drains deferred actual callbacks including nested late work before the observation owner can reset',async()=>{
 const diagnostics=rewardsPolicyDiagnostics();let outerRelease!:()=>void,innerRelease!:()=>void,innerStarted!:()=>void,drained=false;
 const outer=new Promise<void>(done=>{outerRelease=done;}),inner=new Promise<void>(done=>{innerRelease=done;}),started=new Promise<void>(done=>{innerStarted=done;}),error=Object.freeze({code:'42501'});
 const callback=diagnostics.callback('bank-source',async()=>{await outer;const nested=diagnostics.callback('agent-guard',async()=>{innerStarted();await inner;throw error;});await nested;});
 // Consume immediately, as the real controlled owner does; no orphan rejection.
 const result=callback.then(()=>undefined,failure=>failure),drain=diagnostics.drain().then(()=>{drained=true;});
 await Promise.resolve();expect(drained).toBe(false);outerRelease();await started;expect(drained).toBe(false);innerRelease();expect(await result).toBe(error);await drain;expect(drained).toBe(true);
 expect(diagnostics.snapshot().observations).toEqual([{kind:'callback-refused',phase:'agent-guard',sqlstate:'42501'},{kind:'callback-refused',phase:'bank-source',sqlstate:'42501'}]);
});
it('keeps submitted source steps separate from strict native booleans and rejects nonclosed diagnostic input',()=>{
 const diagnostics=rewardsPolicyDiagnostics(),wait={kind:'wait-unavailable',waitingPresent:true,holderPresent:true,waitingActive:true,waitingOnLock:false,ownedBlocking:false,waitingFloorWrite:true,waitingHistoryLock:false,waitingStatementOlderThanWindow:true} as const;
 diagnostics.step('writer-insert-submitted');diagnostics.wait(wait);
 expect(diagnostics.snapshot().observations).toEqual([{kind:'source-callback-step',phase:'writer-insert-submitted'},wait]);expect(diagnostics.snapshot().releaseAuthorized).toBe(false);
 const extra={...wait,privateQuery:'forbidden'};expect(()=>diagnostics.wait(extra)).toThrow('Closed owned wait observation required');
 expect(()=>Reflect.apply(diagnostics.step,undefined,['private phase'])).toThrow('Closed source observation step required');
 expect(()=>Reflect.apply(diagnostics.sync,undefined,['private phase',()=>17])).toThrow('Unknown owned Rewards diagnostic phase');
 expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/private phase|privateQuery|forbidden/);
});
it('binds the actual preimport delegates, two schema owners and canonical native History derivation without a timing change',()=>{
 const source=readFileSync(new URL('./prototypes/rewards-audit-policy-native-cases.ts',import.meta.url),'utf8'),controller=readFileSync(new URL('./prototypes/rewards-audit-policy-controller.ts',import.meta.url),'utf8');
 expect(source.match(/vi\.mock\(/g)).toHaveLength(4);expect(source.match(/await importOriginal</g)).toHaveLength(4);
 for(const name of ['withAgentActionGuard','assertBankMaintenanceActorTx','withBankMaintenanceIntervalTx','prepareBankMaintenanceSourceTx','lockPositionArchiveSourceTx','preparePositionArchiveTx'])expect(source).toContain('actual.'+name+'(');
 expect(source.match(/rewardPolicyObservedParse\(spec\.(metadata|stored)/g)).toHaveLength(4);expect(source).toContain("if(spec.action==='employees.bank.maintain')");expect(source).toContain("if(spec.action==='org.position.archive')");expect(source).toContain('return actual.createReviewCustody(spec);');expect(source).not.toMatch(/rewardPolicyObservedParse\(spec\.human|vi\.spyOn\((agentGuardOwner|bankSourceOwner|catalogueSourceOwner)/);
 expect(source).toContain('const until=Date.now()+200;');expect(source).toContain('await observed.drain();spy.mockRestore();');
 expect(controller).toContain("hashtext('audit-chain:'||${tenant}::uuid::text)::bigint");expect(controller).toContain("clock_timestamp()-query_start>=interval '200 milliseconds'");expect(controller).toContain('backend_start=${waiting.started}::text::timestamptz and datname=${database}');expect(controller).not.toMatch(/select[^\n]*query\s*[, ]/i);
});
