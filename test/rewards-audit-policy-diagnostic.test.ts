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
 const hostile=new Proxy({},{getOwnPropertyDescriptor(){throw Error('private reflective payload');}});
 await expect(diagnostics.callback('bank-actor',()=>{throw hostile;})).rejects.toBe(hostile);
 expect(diagnostics.snapshot().complete).toBe(false);expect(diagnostics.snapshot().observations.at(-1)).toEqual({kind:'callback-refused',phase:'bank-actor',sqlstate:null});
 expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/private|getter|stack|parameters|query/);
});
it('bounds observations honestly and keeps native wait booleans separate from acceptance',async()=>{
 const diagnostics=rewardsPolicyDiagnostics(),error=Error('same primary');
 diagnostics.wait({kind:'wait-unavailable',waitingPresent:true,holderPresent:true,waitingActive:true,waitingOnLock:false,ownedBlocking:false});
 for(let i=0;i<64;i++)await expect(diagnostics.callback('tenant-callback',()=>{throw error;})).rejects.toBe(error);
 const report=diagnostics.snapshot();expect(report.complete).toBe(false);expect(report.observations).toHaveLength(64);expect(report.releaseAuthorized).toBe(false);expect(Object.isFrozen(report.observations)).toBe(true);
});
