/** Pure original-error/source controls; no database or native proof. */
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import * as nativeErrorOwner from '../lib/db-error';
import {rewardPolicyNativeSaveObservation} from './prototypes/rewards-audit-policy-native-save-observation';
import {rewardsPolicyDiagnostics} from './prototypes/rewards-audit-policy-diagnostic';
const message='Catalogue audit decision changed before native INSERT';
const guard='catalogue-audit-decision-changed-before-native-insert';
const native=()=>Object.assign(Error(message),{code:'42501'});
const actualChain=nativeErrorOwner.pgErrorChain,actualState=nativeErrorOwner.pgSqlState;
afterEach(()=>vi.restoreAllMocks());
it('observes the actual live imported chain while the initialization-captured classifier bypasses a late classifier spy, without lexical recursion',async()=>{
 const capturedClassifier=nativeErrorOwner.pgSqlState,error=native(),calls=vi.fn(actualChain),observation=rewardPolicyNativeSaveObservation(calls,actualState);
 const lateClassifier=vi.spyOn(nativeErrorOwner,'pgSqlState');vi.spyOn(nativeErrorOwner,'pgErrorChain').mockImplementation(observation.chain);
 await observation.armed(async()=>{if(capturedClassifier(error)==='42501')expect(nativeErrorOwner.pgErrorChain(error)).toEqual(actualChain(error));});
 expect(lateClassifier).not.toHaveBeenCalled();expect(calls).toHaveBeenCalledTimes(1);expect(calls).toHaveBeenCalledWith(error);
 expect(observation.knownRefusals()).toEqual([{code:'42501',message}]);expect(observation.snapshot()).toEqual({complete:true,observations:[{sqlstate:'42501',nativeGuard:guard}]});
});
it('excludes all deliberate observer errors before and after the one actual armed save scope',async()=>{
 const observation=rewardPolicyNativeSaveObservation(actualChain,actualState),denied=Object.assign(Error('permission denied for table private payload'),{code:'42501'});
 for(let index=0;index<18;index++)observation.chain(denied);
 await observation.armed(async()=>{observation.chain(native());});
 observation.chain(denied);expect(observation.snapshot().observations).toEqual([{sqlstate:'42501',nativeGuard:guard}]);expect(JSON.stringify(observation.snapshot())).not.toContain('private');
});
it('returns the exact original chain array and forwards each original wrapper argument while deduplicating the same native cause identity',async()=>{
 const error=native(),first=Error('wrapped first',{cause:error}),second=Error('wrapped second',{cause:error}),original=actualChain(first),calls=vi.fn((_error:unknown)=>original),observation=rewardPolicyNativeSaveObservation(calls,actualState);
 await observation.armed(async()=>{expect(observation.chain(first)).toBe(original);expect(observation.chain(second)).toBe(original);});
 expect(calls.mock.calls.map(args=>args[0])).toEqual([first,second]);expect(observation.snapshot().observations).toHaveLength(1);
});
it('preserves two distinct original failures even when both have the same native SQLSTATE and message',async()=>{
 const observation=rewardPolicyNativeSaveObservation(actualChain,actualState);
 await observation.armed(async()=>{observation.chain(native());observation.chain(native());});
 expect(observation.snapshot().observations).toEqual([{sqlstate:'42501',nativeGuard:guard},{sqlstate:'42501',nativeGuard:guard}]);
});
it('returns the original work result and preserves rejection identity while always closing the observation scope',async()=>{
 const success=rewardPolicyNativeSaveObservation(actualChain,actualState),result={value:'unchanged'};expect(await success.armed(async()=>result)).toBe(result);
 const failure=rewardPolicyNativeSaveObservation(actualChain,actualState),error=native();await expect(failure.armed(async()=>{throw error;})).rejects.toBe(error);
 failure.chain(error);expect(failure.snapshot()).toEqual({complete:true,observations:[]});
 await expect(failure.armed(async()=>result)).rejects.toThrow('Exactly one owned armed Catalogue save observation required');
});
it('keeps the real owner open until its promise settles and refuses nested or concurrent scope entry without clearing it',async()=>{
 const observation=rewardPolicyNativeSaveObservation(actualChain,actualState);let finish!:()=>void;const held=new Promise<void>(done=>{finish=done;});
 const pending=observation.armed(async()=>{await held;observation.chain(native());});expect(observation.snapshot().complete).toBe(false);
 await expect(observation.armed(async()=>{})).rejects.toThrow('Exactly one owned armed Catalogue save observation required');expect(observation.snapshot().complete).toBe(false);
 finish();await pending;expect(observation.snapshot().complete).toBe(true);expect(observation.knownRefusals()).toEqual([{code:'42501',message}]);
});
it('preserves an original chain-owner throw and closes the scope without fabricating a classification',async()=>{
 const error=Error('original classifier failure'),observation=rewardPolicyNativeSaveObservation(()=>{throw error;},actualState);
 await expect(observation.armed(async()=>{observation.chain(native());})).rejects.toBe(error);expect(observation.snapshot()).toEqual({complete:true,observations:[]});
});
it('publishes only actual SQLSTATE and a source-known guard, never unknown messages, raw SQL, parameters or error objects',async()=>{
 const error=Object.assign(Error('PRIVATE SQL select * from sensitive where token=SECRET'),{code:'42501',query:'PRIVATE QUERY',parameters:['SECRET']}),observation=rewardPolicyNativeSaveObservation(actualChain,actualState);
 await observation.armed(async()=>{observation.chain(error);});expect(observation.knownRefusals()).toEqual([]);
 const diagnostic=rewardsPolicyDiagnostics();diagnostic.nativeSave(observation.snapshot());expect(diagnostic.snapshot().observations).toEqual([{kind:'native-save-classification',phase:'catalogue-native-save',sqlstate:'42501'}]);
 expect(JSON.stringify(diagnostic.snapshot())).not.toMatch(/PRIVATE|SECRET|sensitive|parameters/);
});
it('never guesses a SQLSTATE from a familiar message and fails closed on diagnostic or identity uncertainty',async()=>{
 const mismatch=rewardPolicyNativeSaveObservation(actualChain,actualState);await mismatch.armed(async()=>{mismatch.chain(Object.assign(Error(message),{code:'55000'}));});expect(mismatch.knownRefusals()).toEqual([]);expect(mismatch.snapshot().observations).toEqual([{sqlstate:'55000'}]);
 for(const mode of ['identity','classifier','invalid-code']){
  const rows=[{code:'42501',message}],error=mode==='identity'?new Proxy({}, {getOwnPropertyDescriptor(){throw Error('PRIVATE reflection');}}):native();
  const observation=rewardPolicyNativeSaveObservation(()=>rows,()=>{if(mode==='classifier')throw Error('PRIVATE classifier');return mode==='invalid-code'?'INVALID':'42501';});
  await observation.armed(async()=>{expect(observation.chain(error)).toBe(rows);});expect(observation.snapshot().complete).toBe(false);
  const diagnostic=rewardsPolicyDiagnostics();diagnostic.nativeSave(observation.snapshot());expect(diagnostic.snapshot().complete).toBe(false);expect(JSON.stringify(diagnostic.snapshot())).not.toContain('PRIVATE');
 }
});
it('bounds unique classifications and exposes immutable snapshots while incomplete evidence remains refused',async()=>{
 const observation=rewardPolicyNativeSaveObservation(actualChain,actualState);await observation.armed(async()=>{for(let index=0;index<65;index++)observation.chain(native());});
 const snapshot=observation.snapshot();expect(snapshot.complete).toBe(false);expect(snapshot.observations).toHaveLength(64);expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot.observations)).toBe(true);expect(snapshot.observations.every(Object.isFrozen)).toBe(true);
 const diagnostic=rewardsPolicyDiagnostics();diagnostic.nativeSave(snapshot);expect(diagnostic.snapshot().complete).toBe(false);
});
it('refuses a fabricated source guard or a malformed SQLSTATE without publishing its untrusted value',()=>{
 let coerced=false;const diagnostic=rewardsPolicyDiagnostics();diagnostic.nativeSave({complete:true,observations:[{sqlstate:'42501',nativeGuard:'PRIVATE FORGED GUARD' as never},{sqlstate:'PRIVATE INVALID'},{sqlstate:{toString(){coerced=true;return '42501';}} as never}]});expect(coerced).toBe(false);
 expect(diagnostic.snapshot()).toEqual({kind:'UNINSTALLED_REWARDS_POLICY_FAILURE_DIAGNOSTIC',releaseAuthorized:false,complete:false,observations:[]});
});
it('retains the actual stale-alias source seam, all24 registrations and the exact Catalogue PRE oracle while isolating armed save observation after test PRE',()=>{
 const admin=readFileSync('core/admin.ts','utf8'),errors=readFileSync('lib/db-error.ts','utf8'),cases=readFileSync('test/prototypes/rewards-audit-policy-native-cases.ts','utf8'),observer=readFileSync('test/prototypes/rewards-audit-policy-review-observer.ts','utf8');
 expect(admin).toContain('const pgErrorCode = pgSqlState;');expect(admin).toContain("return isPrivilegeError(e) && pgErrorChain(e).some");
 const classifier=errors.slice(errors.indexOf('export function pgSqlState('),errors.indexOf('/** True when'));
 expect(classifier).toContain('return pgErrorChain(e).find');expect(classifier).not.toContain('nativeErrorOwner');
 expect(cases).toContain("vi.spyOn(nativeErrorOwner,'pgErrorChain').mockImplementation(nativeSave.chain)");expect(cases).not.toContain("vi.spyOn(nativeErrorOwner,'pgSqlState')");
 const catalogue=cases.slice(cases.indexOf('async function catalogueFirstFloorRace('),cases.indexOf('nativeIt(18,'));
 expect(catalogue.indexOf("const actualPre=await diagnostics.callback('catalogue-test-pre'")).toBeLessThan(catalogue.indexOf("if(actualPre.phase==='armed')"));
 expect(catalogue).toContain('context.signal.throwIfAborted();\n       // Open only AFTER');expect(catalogue.indexOf('context.signal.throwIfAborted();\n       // Open only AFTER')).toBeLessThan(catalogue.indexOf('return nativeSave.armed(()=>actualBulk(...args));'));
 expect(catalogue).toContain("expect(nativeRefusals).toContainEqual({code:'42501',message:'Catalogue audit decision changed before native INSERT'})");
 expect(catalogue).toContain('return actualBulk(...args);');expect(catalogue).toContain('errors.mockRestore()');expect(catalogue).toContain('diagnostics.nativeSave(nativeSave.snapshot())');
 expect(Array.from(cases.matchAll(/nativeIt\((\d+),/g),match=>Number(match[1]))).toEqual(Array.from({length:24},(_,index)=>index));
 expect(observer).toContain("sql`select catalogue_native_phase,catalogue_audit_preimage from app.assistant_own_leave_review where id=${reviewId}::uuid`");
 expect(readFileSync('.github/ci/rewards-native-sources.mjs','utf8')).toContain('\"test/prototypes/rewards-audit-policy-native-save-observation.ts\"');
 const guards=readFileSync('test/prototypes/rewards-audit-policy-native-guards.ts','utf8'),migration=readFileSync('db/migrations/0864_assistant_catalogue_effect_closure.sql','utf8');
 expect(guards).toContain("code:'catalogue-audit-decision-changed-before-native-insert',message:'Catalogue audit decision changed before native INSERT',sqlstates:Object.freeze(['42501'])");expect(migration).toContain("RAISE EXCEPTION 'Catalogue audit decision changed before native INSERT' USING ERRCODE='42501'");
});
