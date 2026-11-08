/** Pure contract/source controls only; not a native capability proof. */
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {reviewObservationActions,reviewObservationNativeBody,reviewObservationRoot,reviewObservationScope,reviewObservationResult} from './prototypes/rewards-audit-policy-review-observer-contract';
const source=readFileSync('test/prototypes/rewards-audit-policy-review-observer.sql','utf8');
const id='00000000-0000-4000-8000-000000000001';
it('binds the complete fixed native function body and refuses duplicate or missing dollar boundaries',()=>{
 const expected=source.slice(source.indexOf(' AS $body$')+' AS $body$'.length,source.indexOf('$body$;'));
 expect(reviewObservationNativeBody(source)).toBe(expected);
 for(const changed of [source+source,source.replace('END $body$;','END $other$;'),source.replace('LANGUAGE plpgsql STABLE SECURITY DEFINER','LANGUAGE plpgsql VOLATILE SECURITY DEFINER')])expect(()=>reviewObservationNativeBody(changed)).toThrow('Exact test observer source required');
});
it('keeps actual root identity closed and refuses malformed numeric or suffix-carrying native claims',()=>{
 const root={pid:123,started:'2026-11-08 00:00:00.123456+00',xid:'123',login:'ai_hr_app',database:'fictional-owned-db'};
 expect(reviewObservationRoot.parse(root)).toEqual(root);
 for(const xid of ['0','-1','1.0','01','1e2','123\n','123\r','123\r\n','123\u2028','123\u2029','123456789012345678901'])expect(()=>reviewObservationRoot.parse({...root,xid})).toThrow();
 for(const changed of [{...root,pid:1},{...root,pid:123.5},{...root,login:'owner'},{...root,database:''},{...root,authority:true}])expect(()=>reviewObservationRoot.parse(changed)).toThrow();
});
it('accepts only the two exact source-owned actions and explicit UUID scope, without turning a packet into admission',()=>{
 const scope={tenantId:id,userId:id,reviewId:id,action:reviewObservationActions[0]};
 for(const action of reviewObservationActions)expect(reviewObservationScope.parse({...scope,action}).action).toBe(action);
 for(const changed of [{...scope,action:'unknown'},{...scope,action:scope.action+'\n'},{...scope,tenantId:''},{...scope,userId:null},{...scope,reviewId:'private-text'},{...scope,root:'forged'}])expect(()=>reviewObservationScope.parse(changed)).toThrow();
});
it('retains null preview metadata and complete native PRE while rejecting added HR fields and invented phases',()=>{
 expect(reviewObservationResult.parse({phase:null,pre:null})).toEqual({phase:null,pre:null});
 for(const phase of ['armed','written','recorded','completed'])expect(reviewObservationResult.parse({phase,pre:{armed:false,priorSeq:null,priorHash:null}})).toEqual({phase,pre:{armed:false,priorSeq:null,priorHash:null}});
 for(const changed of [{phase:'prepared',pre:null},{phase:'armed',pre:{armed:false}},{phase:null,pre:null,employee:'private'},{phase:'armed',pre:{armed:false,priorSeq:null,priorHash:null,bankAccount:'private'}}])expect(()=>reviewObservationResult.parse(changed)).toThrow();
});
it('keeps the port outside app business SQL, denies raw private reads on both sides, and preserves all native cases',()=>{
 const helper=readFileSync('test/prototypes/rewards-audit-policy-review-observer.ts','utf8'),cases=readFileSync('test/prototypes/rewards-audit-policy-native-cases.ts','utf8');
 expect(source).toContain('STABLE SECURITY DEFINER');expect(source).not.toMatch(/\bEXECUTE\s+(?:format|p_)/i);
 expect(source).toContain('x.backend_started_at=(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid())AND x.root_xid=pg_current_xact_id()');
 expect(helper).toContain('await privateDenied(tx,reviewId,action,signal)');expect(helper.match(/await privateDenied\(tx,reviewId,action,signal\)/g)).toHaveLength(3);
 expect(helper).toContain('await tx`rollback to savepoint owned_observer_constructor`');
 expect(helper).toContain('revoke execute on function reward_policy_test.read_review(uuid,text)from ai_hr_app');
 expect(helper).toContain('runReviewObservationRefusal<Tx>(signal,run=>tx.transaction(run)');
 expect(helper).toContain('runReviewObservationRefusal<TransactionSql>(signal,run=>other.savepoint(run)');
 expect(helper).not.toContain('savepoint owned_test_observer_refusal');expect(helper).not.toContain('savepoint owned_observer_wrong_login');
 const executeGuard=source.indexOf("IF has_function_privilege(session_user,'reward_policy_test.read_review(uuid,text)','EXECUTE')IS NOT TRUE");
 expect(executeGuard).toBeGreaterThan(source.indexOf("OR c.login_oid IS DISTINCT FROM 'ai_hr_app'::regrole::oid"));
 expect(executeGuard).toBeLessThan(source.indexOf("IF (SELECT to_jsonb(p)FROM pg_proc p WHERE p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure)"));
 const calls=Array.from(cases.matchAll(/nativeIt\((\d+),/g),match=>Number(match[1]));expect(calls).toEqual(Array.from({length:24},(_,index)=>index));
 expect(cases).toContain('expect(actualPre.pre).toEqual({armed:false,priorSeq:null,priorHash:null})');
});

import {rewardsPolicyDiagnostics} from './prototypes/rewards-audit-policy-diagnostic';
it('separates test PRE observation failures from canonical owners while preserving the actual deferred/error identity and private-data boundary',async()=>{
 const diagnostic=rewardsPolicyDiagnostics(),native=Object.assign(Error('private SQL payload'),{code:'42501'}),value={phase:null,pre:null};
 let release!:(result:typeof value)=>void,settled=false;
 const pending=diagnostic.callback('bank-test-pre',()=>new Promise<typeof value>(done=>{release=done;}));void pending.then(()=>{settled=true;});
 await Promise.resolve();expect(settled).toBe(false);release(value);expect(await pending).toBe(value);
 await expect(diagnostic.callback('catalogue-test-pre',()=>Promise.reject(native))).rejects.toBe(native);await diagnostic.drain();
 expect(diagnostic.snapshot()).toEqual({kind:'UNINSTALLED_REWARDS_POLICY_FAILURE_DIAGNOSTIC',releaseAuthorized:false,complete:true,observations:[{kind:'callback-returned',phase:'bank-test-pre'},{kind:'callback-refused',phase:'catalogue-test-pre',sqlstate:'42501'}]});
 expect(JSON.stringify(diagnostic.snapshot())).not.toContain('private');
});

import {runReviewObservationRefusal} from './prototypes/rewards-audit-policy-review-observer-contract';
it('abort during real-open admission prevents negative work and waits for unconditional rollback before settling',async()=>{
 const abort=new AbortController(),primary=Error('owned abort');let open!:()=>void,rollback!:()=>void,entered!:()=>void,rolling!:()=>void;
 const started=new Promise<void>(done=>{entered=done;}),rollbackStarted=new Promise<void>(done=>{rolling=done;}),events:string[]=[];
 const pending=runReviewObservationRefusal(abort.signal,async run=>{
  entered();await new Promise<void>(done=>{open=done;});
  try{return await run(undefined);}catch(error){events.push('rollback');rolling();await new Promise<void>(done=>{rollback=done;});throw error;}
 },async()=>{events.push('forbidden-work');},()=>{events.push('forbidden-verify');},()=>{});
 let settled=false;const outcome=pending.catch(error=>{settled=true;return error;});await started;abort.abort(primary);open();await rollbackStarted;expect(settled).toBe(false);expect(events).toEqual(['rollback']);rollback();expect(await outcome).toBe(primary);
});
it('abort after an actual expected failure blocks another refusal while rollback failure retains both identities and poisons admission',async()=>{
 const abort=new AbortController(),primary=Error('owned abort'),cleanup=Error('rollback uncertainty'),native=Object.assign(Error('actual native model'),{code:'42501'}),poisoned:Error[]=[];let work=0,verify=0,opens=0;
 const failure=await runReviewObservationRefusal(abort.signal,async run=>{opens++;try{return await run(undefined);}catch{throw cleanup;}},async()=>{work++;abort.abort(primary);throw native;},()=>{verify++;},error=>poisoned.push(error)).then(()=>undefined,error=>error);
 expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toContain(primary);expect(failure.errors).toContain(cleanup);expect(poisoned).toHaveLength(1);expect(verify).toBe(0);
 await expect(runReviewObservationRefusal(abort.signal,async run=>{opens++;return run(undefined);},async()=>{work++;},()=>{},()=>{})).rejects.toBe(primary);expect(opens).toBe(1);expect(work).toBe(1);
});
it('uses the nested lease and verifies the identical native error only after its actual owner settles',async()=>{
 const abort=new AbortController(),native=Object.assign(Error('private native query'),{code:'42501'}),lease=Object.freeze({kind:'nested'}),events:string[]=[],poisoned:Error[]=[];
 let restore!:()=>void,rolling!:()=>void;const rollbackStarted=new Promise<void>(done=>{rolling=done;});
 const pending=runReviewObservationRefusal<typeof lease>(abort.signal,async run=>{
  events.push('open');try{return await run(lease);}catch(error){events.push('rollback');rolling();await new Promise<void>(done=>{restore=done;});events.push('settled');throw error;}
 },async actual=>{expect(actual).toBe(lease);events.push('nested-work');throw native;},error=>{expect(error).toBe(native);events.push('verify');},error=>poisoned.push(error));
 let complete=false;const observed=pending.then(()=>{complete=true;});await rollbackStarted;
 expect(complete).toBe(false);expect(events).toEqual(['open','nested-work','rollback']);restore();await observed;
 expect(events).toEqual(['open','nested-work','rollback','settled','verify']);expect(poisoned).toEqual([]);
});
it('unexpected native success is rolled back and fails without admitting verification or poisoning a settled owner',async()=>{
 const abort=new AbortController(),events:string[]=[],poisoned:Error[]=[];
 await expect(runReviewObservationRefusal(abort.signal,async run=>{
  try{return await run(undefined);}catch(error){events.push('rollback-settled');throw error;}
 },async()=>{events.push('unexpected-return');},()=>{events.push('forbidden-verify');},error=>poisoned.push(error))).rejects.toThrow('Native test observer statement unexpectedly returned');
 expect(events).toEqual(['unexpected-return','rollback-settled']);expect(poisoned).toEqual([]);
});
it('a different nested-owner failure preserves both identities and poisons admission instead of accepting the expected callback SQLSTATE',async()=>{
 const abort=new AbortController(),native=Object.assign(Error('native refusal'),{code:'42501'}),cleanup=Error('native rollback failed'),poisoned:Error[]=[];let verified=0;
 const failure=await runReviewObservationRefusal(abort.signal,async run=>{try{return await run(undefined);}catch{throw cleanup;}},async()=>{throw native;},()=>{verified++;},error=>poisoned.push(error)).then(()=>undefined,error=>error);
 expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([native,cleanup]);expect(verified).toBe(0);expect(poisoned).toHaveLength(1);expect(poisoned[0].cause).toBeInstanceOf(AggregateError);
});
it('a swallowed, unopened or repeated nested callback cannot manufacture rollback completion or repeat native work',async()=>{
 const abort=new AbortController(),native=Object.assign(Error('native refusal'),{code:'42501'});
 for(const mode of ['swallowed','unopened','repeated']){
  let calls=0,verified=0;const poisoned:Error[]=[];
  const failure=await runReviewObservationRefusal(abort.signal,async run=>{
   if(mode==='unopened')throw Error('scope unavailable');
   try{await run(undefined);}catch{}
   if(mode==='repeated')return run(undefined);
  },async()=>{calls++;throw native;},()=>{verified++;},error=>poisoned.push(error)).then(()=>undefined,error=>error);
  expect(failure).toBeDefined();expect(calls).toBe(mode==='unopened'?0:1);expect(verified).toBe(0);expect(poisoned).toHaveLength(1);
 }
});
