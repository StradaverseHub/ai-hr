/** Pure original-error/source controls; no database or native proof. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
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
 const capturedClassifier=nativeErrorOwner.pgSqlState,error=native(),calls=vi.fn(actualChain),observation=rewardPolicyNativeSaveObservation(calls);
 const lateClassifier=vi.spyOn(nativeErrorOwner,'pgSqlState');vi.spyOn(nativeErrorOwner,'pgErrorChain').mockImplementation(observation.chain);
 await observation.armed(async()=>{if(capturedClassifier(error)==='42501')expect(nativeErrorOwner.pgErrorChain(error)).toEqual(actualChain(error));});
 expect(lateClassifier).not.toHaveBeenCalled();expect(calls).toHaveBeenCalledTimes(1);expect(calls).toHaveBeenCalledWith(error);
 expect(observation.knownRefusals()).toEqual([{code:'42501',message}]);expect(observation.snapshot()).toEqual({complete:true,observations:[{sqlstate:'42501',nativeGuard:guard}]});
});
it('excludes all deliberate observer errors before and after the one actual armed save scope',async()=>{
 const observation=rewardPolicyNativeSaveObservation(actualChain),denied=Object.assign(Error('permission denied for table private payload'),{code:'42501'});
 for(let index=0;index<18;index++)observation.chain(denied);
 await observation.armed(async()=>{observation.chain(native());});
 observation.chain(denied);expect(observation.snapshot().observations).toEqual([{sqlstate:'42501',nativeGuard:guard}]);expect(JSON.stringify(observation.snapshot())).not.toContain('private');
});
it('returns the exact original chain array and forwards each original wrapper argument while deduplicating the same native cause identity',async()=>{
 const error=native(),first=Error('wrapped first',{cause:error}),second=Error('wrapped second',{cause:error}),original=actualChain(first),calls=vi.fn((_error:unknown)=>original),observation=rewardPolicyNativeSaveObservation(calls);
 await observation.armed(async()=>{expect(observation.chain(first)).toBe(original);expect(observation.chain(second)).toBe(original);});
 expect(calls.mock.calls.map(args=>args[0])).toEqual([first,second]);expect(observation.snapshot().observations).toHaveLength(1);
});
it('preserves two distinct original failures even when both have the same native SQLSTATE and message',async()=>{
 const observation=rewardPolicyNativeSaveObservation(actualChain);
 await observation.armed(async()=>{observation.chain(native());observation.chain(native());});
 expect(observation.snapshot().observations).toEqual([{sqlstate:'42501',nativeGuard:guard},{sqlstate:'42501',nativeGuard:guard}]);
});
it('returns the original work result and preserves rejection identity while always closing the observation scope',async()=>{
 const success=rewardPolicyNativeSaveObservation(actualChain),result={value:'unchanged'};expect(await success.armed(async()=>result)).toBe(result);
 const failure=rewardPolicyNativeSaveObservation(actualChain),error=native();await expect(failure.armed(async()=>{throw error;})).rejects.toBe(error);
 failure.chain(error);expect(failure.snapshot()).toEqual({complete:true,observations:[]});
 await expect(failure.armed(async()=>result)).rejects.toThrow('Exactly one owned armed Catalogue save observation required');
});
it('keeps the real owner open until its promise settles and refuses nested or concurrent scope entry without clearing it',async()=>{
 const observation=rewardPolicyNativeSaveObservation(actualChain);let finish!:()=>void;const held=new Promise<void>(done=>{finish=done;});
 const pending=observation.armed(async()=>{await held;observation.chain(native());});expect(observation.snapshot().complete).toBe(false);
 await expect(observation.armed(async()=>{})).rejects.toThrow('Exactly one owned armed Catalogue save observation required');expect(observation.snapshot().complete).toBe(false);
 finish();await pending;expect(observation.snapshot().complete).toBe(true);expect(observation.knownRefusals()).toEqual([{code:'42501',message}]);
});
it('preserves an original chain-owner throw and closes the scope without fabricating a classification',async()=>{
 const error=Error('original classifier failure'),observation=rewardPolicyNativeSaveObservation(()=>{throw error;});
 await expect(observation.armed(async()=>{observation.chain(native());})).rejects.toBe(error);expect(observation.snapshot()).toEqual({complete:true,observations:[]});
});
it('publishes only actual SQLSTATE and a source-known guard, never unknown messages, raw SQL, parameters or error objects',async()=>{
 const error=Object.assign(Error('PRIVATE SQL select * from sensitive where token=SECRET'),{code:'42501',query:'PRIVATE QUERY',parameters:['SECRET']}),observation=rewardPolicyNativeSaveObservation(actualChain);
 await observation.armed(async()=>{observation.chain(error);});expect(observation.knownRefusals()).toEqual([]);
 const diagnostic=rewardsPolicyDiagnostics();diagnostic.nativeSave(observation.snapshot());expect(diagnostic.snapshot().observations).toEqual([{kind:'native-save-classification',phase:'catalogue-native-save',sqlstate:'42501'}]);
 expect(JSON.stringify(diagnostic.snapshot())).not.toMatch(/PRIVATE|SECRET|sensitive|parameters/);
});
it('never guesses a SQLSTATE from a familiar message and refuses an opaque original identity without changing the chain result',async()=>{
 const mismatch=rewardPolicyNativeSaveObservation(actualChain);await mismatch.armed(async()=>{mismatch.chain(Object.assign(Error(message),{code:'55000'}));});expect(mismatch.knownRefusals()).toEqual([]);expect(mismatch.snapshot().observations).toEqual([{sqlstate:'55000'}]);
 const rows=actualChain(native()),opaque=Object.create(null),observation=rewardPolicyNativeSaveObservation(()=>rows);
 await observation.armed(async()=>{expect(observation.chain(opaque)).toBe(rows);});expect(observation.snapshot().complete).toBe(false);
 const diagnostic=rewardsPolicyDiagnostics();diagnostic.nativeSave(observation.snapshot());expect(diagnostic.snapshot().complete).toBe(false);
});
it('bounds unique classifications and exposes immutable snapshots while incomplete evidence remains refused',async()=>{
 const observation=rewardPolicyNativeSaveObservation(actualChain);await observation.armed(async()=>{for(let index=0;index<65;index++)observation.chain(native());});
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
 const classifierStart=errors.indexOf('export function pgSqlState('),classifier=errors.slice(classifierStart,errors.indexOf('\n}',classifierStart)+2);
 expect(classifier).toBe("export function pgSqlState(e: unknown): string | undefined {\n  return pgErrorChain(e).find((l) => /^[0-9A-Z]{5}$/.test(l.code ?? ''))?.code;\n}");
 const helper=readFileSync('test/prototypes/rewards-audit-policy-native-save-observation.ts','utf8');expect(helper).toContain("const selected=original.find((l) => /^[0-9A-Z]{5}$/.test(l.code ?? ''));");expect(helper).not.toContain('actualState(');expect(helper).not.toContain('pgSqlState(error)');expect(classifier).not.toContain('nativeErrorOwner');
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

// Fixed RED counterexample for the exact frozen6d defect. It deliberately uses
// the real library twice, as the complete6d helper preimage requires. Never an
// alternate production owner, dynamic evaluator or passing native witness.
function old6dTwoRead(error:unknown){const original=actualChain(error);try{actualState(error);}catch{}return original;}
it('uses the real library message getter baseline once while the frozen6d two-read course poisons an otherwise retained result',async()=>{
 const inverse=JSON.parse(readFileSync('test/prototypes/rewards-catalogue-single-read-observation-inverse.json','utf8')),prior=Buffer.from(inverse.files['test/prototypes/rewards-audit-policy-native-save-observation.ts'].originalBase64,'base64');
 expect(createHash('sha256').update(prior).digest('hex')).toBe('e7a1d0b7a52cc203658dd4a6f3b164a73f246658394fb69e6f05d6ae359268f2');expect(prior.toString()).toContain('const original=actualChain(error);');expect(prior.toString()).toContain('const sqlstate=actualState(error)??null;');
 const make=()=>{let reads=0,poisoned=false;const poison=Error('owned getter poison'),error=native();Object.defineProperty(error,'message',{configurable:true,get(){reads++;if(reads>2){poisoned=true;throw poison;}return message;}});return{error,reads:()=>reads,poisoned:()=>poisoned};};
 const baseline=make(),expected=actualChain(baseline.error);expect(baseline.reads()).toBe(2);
 const fixed=make(),observation=rewardPolicyNativeSaveObservation(actualChain),returned=await observation.armed(async()=>observation.chain(fixed.error));expect(returned).toEqual(expected);expect(fixed.reads()).toBe(baseline.reads());expect(fixed.poisoned()).toBe(false);expect(observation.snapshot().complete).toBe(true);expect(observation.knownRefusals()).toEqual([{code:'42501',message}]);
 const old=make();expect(old6dTwoRead(old.error)).toEqual(expected);expect(old.reads()).toBe(3);expect(old.poisoned()).toBe(true);
});
it('does not reread a real native code getter and refuses its accessor identity even when the original chain observed a valid SQLSTATE',async()=>{
 const make=()=>{let reads=0,poisoned=false;const error=Error(message);Object.defineProperty(error,'code',{get(){reads++;if(reads>2){poisoned=true;throw Error('code getter poison');}return '42501';}});return{error,reads:()=>reads,poisoned:()=>poisoned};};
 const baseline=make(),expected=actualChain(baseline.error);expect(baseline.reads()).toBe(2);
 const fixed=make(),observation=rewardPolicyNativeSaveObservation(actualChain);expect(await observation.armed(async()=>observation.chain(fixed.error))).toEqual(expected);expect(fixed.reads()).toBe(2);expect(fixed.poisoned()).toBe(false);expect(observation.snapshot()).toEqual({complete:false,observations:[]});expect(observation.knownRefusals()).toEqual([]);
 const old=make();expect(old6dTwoRead(old.error)).toEqual(expected);expect(old.reads()).toBe(3);expect(old.poisoned()).toBe(true);
});
it('does not reinvoke an original cause accessor to attest a deeper native identity',async()=>{
 const make=()=>{let reads=0,poisoned=false;const error=Error('wrapped native error'),cause=native();Object.defineProperty(error,'cause',{get(){reads++;if(reads>1){poisoned=true;throw Error('cause getter poison');}return cause;}});return{error,reads:()=>reads,poisoned:()=>poisoned};};
 const baseline=make(),expected=actualChain(baseline.error);expect(baseline.reads()).toBe(1);
 const fixed=make(),observation=rewardPolicyNativeSaveObservation(actualChain);expect(await observation.armed(async()=>observation.chain(fixed.error))).toEqual(expected);expect(fixed.reads()).toBe(1);expect(fixed.poisoned()).toBe(false);expect(observation.snapshot()).toEqual({complete:false,observations:[]});
 const old=make();expect(old6dTwoRead(old.error)).toEqual(expected);expect(old.reads()).toBe(2);expect(old.poisoned()).toBe(true);
});
it('lets the real owner perform its original root or nested Proxy reads but adds no get, descriptor or prototype trap',async()=>{
 for(const nested of [false,true]){
  const make=(limit=Infinity)=>{const reads:string[]=[];let metadataTraps=0,poisoned=false;const proxy=new Proxy(native(),{get(target,key,receiver){reads.push(String(key));if(reads.length>limit){poisoned=true;throw Error('proxy getter poison');}return Reflect.get(target,key,receiver);},getOwnPropertyDescriptor(){metadataTraps++;throw Error('proxy descriptor trap');},getPrototypeOf(){metadataTraps++;throw Error('proxy prototype trap');}});return{error:nested?Error('outer',{cause:proxy}):proxy,reads,metadataTraps:()=>metadataTraps,poisoned:()=>poisoned};};
  const baseline=make(),expected=actualChain(baseline.error);expect(baseline.metadataTraps()).toBe(0);expect(baseline.reads.length).toBeGreaterThan(0);
  const fixed=make(baseline.reads.length),observation=rewardPolicyNativeSaveObservation(actualChain);expect(await observation.armed(async()=>observation.chain(fixed.error))).toEqual(expected);expect(fixed.reads).toEqual(baseline.reads);expect(fixed.metadataTraps()).toBe(0);expect(fixed.poisoned()).toBe(false);expect(observation.snapshot()).toEqual({complete:false,observations:[]});
  const old=make(baseline.reads.length);expect(old6dTwoRead(old.error)).toEqual(expected);expect(old.reads.length).toBeGreaterThan(baseline.reads.length);expect(old.poisoned()).toBe(true);
 }
});
it('selects exactly the first valid five-character SQLSTATE already returned by the real library, with no code inferred from the message',async()=>{
 const cases=[
  [{code:'ECONNREFUSED',cause:{code:'42P01',message:'opaque domain refusal'}},'42P01'],
  [{code:'42501',message,cause:{code:'55000',message:'later'}},'42501'],
  [{code:'short',message,cause:{code:'55000',message}},'55000'],
  [{code:42501,cause:{code:'00000',message:'later'}},'00000'],
 ]as const;
 for(const[error,expected]of cases){const chain=actualChain(error),original=vi.fn((_error:unknown)=>chain),observation=rewardPolicyNativeSaveObservation(original);expect(actualState(error)).toBe(expected);expect(await observation.armed(async()=>observation.chain(error))).toBe(chain);expect(original).toHaveBeenCalledTimes(1);expect(original).toHaveBeenCalledWith(error);expect(observation.snapshot().complete).toBe(true);expect(observation.snapshot().observations[0].sqlstate).toBe(expected);if(expected!=='42501')expect(observation.knownRefusals()).toEqual([]);}
});
it('refuses inherited native code and absent own cause identity without invoking a prototype getter or inventing native authority',async()=>{
 let reads=0;const inherited=Object.create({get code(){reads++;if(reads>2)throw Error('inherited getter reread');return '42501';}});Object.defineProperty(inherited,'message',{value:message});const expected=actualChain(inherited);expect(reads).toBe(2);reads=0;
 const observation=rewardPolicyNativeSaveObservation(actualChain);expect(await observation.armed(async()=>observation.chain(inherited))).toEqual(expected);expect(reads).toBe(2);expect(observation.snapshot()).toEqual({complete:false,observations:[]});
 const cause=native(),opaque=Object.create({cause}),nested=rewardPolicyNativeSaveObservation(actualChain);const original=actualChain(opaque);expect(await nested.armed(async()=>nested.chain(opaque))).toEqual(original);expect(nested.snapshot()).toEqual({complete:false,observations:[]});
});
