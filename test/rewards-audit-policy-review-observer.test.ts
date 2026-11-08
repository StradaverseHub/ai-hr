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
 expect(helper).toContain('runReviewObservationRefusal<Tx>(signal,{');expect(helper).toContain('},run=>tx.transaction(run),work,verify,poison)');
 expect(helper).toContain('},run=>other.savepoint(run),nested=>nested`select reward_policy_test.read_review');
 expect(helper).toContain('release savepoint owned_test_observer_refusal');expect(helper).toContain('release savepoint owned_observer_wrong_login');
 const executeGuard=source.indexOf("IF has_function_privilege(session_user,'reward_policy_test.read_review(uuid,text)','EXECUTE')IS NOT TRUE");
 expect(executeGuard).toBeGreaterThan(source.indexOf("OR c.login_oid IS DISTINCT FROM 'ai_hr_app'::regrole::oid"));
 const directGuard=source.indexOf('IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode');
 expect(executeGuard).toBeLessThan(directGuard);expect(directGuard).toBeLessThan(source.indexOf("IF (SELECT to_jsonb(p)FROM pg_proc p WHERE p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure)"));
 expect(source).toContain("AND g.grantee=c.login_oid AND g.grantor=c.owner_oid AND g.privilege_type='EXECUTE' AND g.is_grantable=false");
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
const settledFrame=()=>({open:async()=>{},rollback:async()=>{},release:async()=>{}});
it('abort during real-open admission prevents negative work and waits for unconditional rollback before settling',async()=>{
 const abort=new AbortController(),primary=Error('owned abort');let open!:()=>void,rollback!:()=>void,entered!:()=>void,rolling!:()=>void;
 const started=new Promise<void>(done=>{entered=done;}),rollbackStarted=new Promise<void>(done=>{rolling=done;}),events:string[]=[];
 const pending=runReviewObservationRefusal(abort.signal,settledFrame(),async run=>{
  entered();await new Promise<void>(done=>{open=done;});
  try{return await run(undefined);}catch(error){events.push('rollback');rolling();await new Promise<void>(done=>{rollback=done;});throw error;}
 },async()=>{events.push('forbidden-work');},()=>{events.push('forbidden-verify');},()=>{});
 let settled=false;const outcome=pending.catch(error=>{settled=true;return error;});await started;abort.abort(primary);open();await rollbackStarted;expect(settled).toBe(false);expect(events).toEqual(['rollback']);rollback();expect(await outcome).toBe(primary);
});
it('abort after an actual expected failure blocks another refusal while rollback failure retains both identities and poisons admission',async()=>{
 const abort=new AbortController(),primary=Error('owned abort'),cleanup=Error('rollback uncertainty'),native=Object.assign(Error('actual native model'),{code:'42501'}),poisoned:Error[]=[];let work=0,verify=0,opens=0;
 const failure=await runReviewObservationRefusal(abort.signal,settledFrame(),async run=>{opens++;try{return await run(undefined);}catch{throw cleanup;}},async()=>{work++;abort.abort(primary);throw native;},()=>{verify++;},error=>poisoned.push(error)).then(()=>undefined,error=>error);
 expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toContain(primary);expect(failure.errors).toContain(cleanup);expect(poisoned).toHaveLength(1);expect(verify).toBe(0);
 await expect(runReviewObservationRefusal(abort.signal,settledFrame(),async run=>{opens++;return run(undefined);},async()=>{work++;},()=>{},()=>{})).rejects.toBe(primary);expect(opens).toBe(1);expect(work).toBe(1);
});
it('uses the nested lease and verifies the identical native error only after its actual owner settles',async()=>{
 const abort=new AbortController(),native=Object.assign(Error('private native query'),{code:'42501'}),lease=Object.freeze({kind:'nested'}),events:string[]=[],poisoned:Error[]=[];
 let restore!:()=>void,rolling!:()=>void;const rollbackStarted=new Promise<void>(done=>{rolling=done;});
 const pending=runReviewObservationRefusal<typeof lease>(abort.signal,settledFrame(),async run=>{
  events.push('open');try{return await run(lease);}catch(error){events.push('rollback');rolling();await new Promise<void>(done=>{restore=done;});events.push('settled');throw error;}
 },async actual=>{expect(actual).toBe(lease);events.push('nested-work');throw native;},error=>{expect(error).toBe(native);events.push('verify');},error=>poisoned.push(error));
 let complete=false;const observed=pending.then(()=>{complete=true;});await rollbackStarted;
 expect(complete).toBe(false);expect(events).toEqual(['open','nested-work','rollback']);restore();await observed;
 expect(events).toEqual(['open','nested-work','rollback','settled','verify']);expect(poisoned).toEqual([]);
});
it('unexpected native success is rolled back and fails without admitting verification or poisoning a settled owner',async()=>{
 const abort=new AbortController(),events:string[]=[],poisoned:Error[]=[];
 await expect(runReviewObservationRefusal(abort.signal,{open:async()=>{events.push('frame-open');},rollback:async()=>{events.push('frame-rollback');},release:async()=>{events.push('frame-release');}},async run=>{
  try{return await run(undefined);}catch(error){events.push('rollback-settled');throw error;}
 },async()=>{events.push('unexpected-return');},()=>{events.push('forbidden-verify');},error=>poisoned.push(error))).rejects.toThrow('Native test observer statement unexpectedly returned');
 expect(events).toEqual(['frame-open','unexpected-return','rollback-settled','frame-rollback','frame-release']);expect(poisoned).toEqual([]);
});
it('a different nested-owner failure preserves both identities and poisons admission instead of accepting the expected callback SQLSTATE',async()=>{
 const abort=new AbortController(),native=Object.assign(Error('native refusal'),{code:'42501'}),cleanup=Error('native rollback failed'),poisoned:Error[]=[];let verified=0;
 const failure=await runReviewObservationRefusal(abort.signal,settledFrame(),async run=>{try{return await run(undefined);}catch{throw cleanup;}},async()=>{throw native;},()=>{verified++;},error=>poisoned.push(error)).then(()=>undefined,error=>error);
 expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([native,cleanup]);expect(verified).toBe(0);expect(poisoned).toHaveLength(1);expect(poisoned[0].cause).toBeInstanceOf(AggregateError);
});
it('a swallowed, unopened or repeated nested callback cannot manufacture rollback completion or repeat native work',async()=>{
 const abort=new AbortController(),native=Object.assign(Error('native refusal'),{code:'42501'});
 for(const mode of ['swallowed','unopened','repeated']){
  let calls=0,verified=0;const poisoned:Error[]=[];
  const failure=await runReviewObservationRefusal(abort.signal,settledFrame(),async run=>{
   if(mode==='unopened')throw Error('scope unavailable');
   try{await run(undefined);}catch{}
   if(mode==='repeated')return run(undefined);
  },async()=>{calls++;throw native;},()=>{verified++;},error=>poisoned.push(error)).then(()=>undefined,error=>error);
  expect(failure).toBeDefined();expect(calls).toBe(mode==='unopened'?0:1);expect(verified).toBe(0);expect(poisoned).toHaveLength(1);
 }
});

it('restores the actual parent frame only after the nested owner settles, then waits for release before verification',async()=>{
 const abort=new AbortController(),native=Object.assign(Error('native refusal'),{code:'42501'}),events:string[]=[],poisoned:Error[]=[];
 let finishOwner!:()=>void,ownerReady!:()=>void,finishRollback!:()=>void,rollbackReady!:()=>void,finishRelease!:()=>void,releaseReady!:()=>void;
 const owning=new Promise<void>(done=>{ownerReady=done;}),rolling=new Promise<void>(done=>{rollbackReady=done;}),releasing=new Promise<void>(done=>{releaseReady=done;});
 const pending=runReviewObservationRefusal(abort.signal,{
  open:async()=>{events.push('frame-open');},
  rollback:async()=>{events.push('frame-rollback');rollbackReady();await new Promise<void>(done=>{finishRollback=done;});},
  release:async()=>{events.push('frame-release');releaseReady();await new Promise<void>(done=>{finishRelease=done;});},
 },async run=>{try{return await run(undefined);}catch(error){events.push('owner-rollback');ownerReady();await new Promise<void>(done=>{finishOwner=done;});events.push('owner-settled');throw error;}},async()=>{events.push('work');throw native;},error=>{expect(error).toBe(native);events.push('verify');},error=>poisoned.push(error));
 let settled=false;const outcome=pending.then(()=>{settled=true;});await owning;expect(events).toEqual(['frame-open','work','owner-rollback']);expect(settled).toBe(false);
 finishOwner();await rolling;expect(events.at(-2)).toBe('owner-settled');expect(settled).toBe(false);finishRollback();await releasing;expect(settled).toBe(false);expect(events).not.toContain('verify');finishRelease();await outcome;
 expect(events).toEqual(['frame-open','work','owner-rollback','owner-settled','frame-rollback','frame-release','verify']);expect(poisoned).toEqual([]);
});
it('abort during parent open still waits for open, mandatory rollback and release without admitting a nested owner',async()=>{
 const abort=new AbortController(),primary=Error('abort during fence open'),events:string[]=[],poisoned:Error[]=[];let open!:()=>void,started!:()=>void;
 const ready=new Promise<void>(done=>{started=done;});
 const pending=runReviewObservationRefusal(abort.signal,{open:async()=>{started();await new Promise<void>(done=>{open=done;});events.push('opened');},rollback:async()=>{events.push('rollback');},release:async()=>{events.push('release');}},async()=>{events.push('forbidden-owner');},async()=>{events.push('forbidden-work');},()=>{events.push('forbidden-verify');},error=>poisoned.push(error));
 let settled=false;const outcome=pending.catch(error=>{settled=true;return error;});await ready;abort.abort(primary);expect(settled).toBe(false);open();expect(await outcome).toBe(primary);expect(events).toEqual(['opened','rollback','release']);expect(poisoned).toEqual([]);
});
it('uncertain open always attempts parent rollback and poisons even when the subsequent frame cleanup settles',async()=>{
 const abort=new AbortController(),openFailure=Error('open acknowledgement unavailable'),events:string[]=[],poisoned:Error[]=[];
 await expect(runReviewObservationRefusal(abort.signal,{open:async()=>{throw openFailure;},rollback:async()=>{events.push('rollback');},release:async()=>{events.push('release');}},async()=>{events.push('forbidden-owner');},async()=>{},()=>{events.push('forbidden-verify');},error=>poisoned.push(error))).rejects.toBe(openFailure);
 expect(events).toEqual(['rollback','release']);expect(poisoned).toHaveLength(1);expect(poisoned[0].cause).toBe(openFailure);
});
it('rollback or release uncertainty retains original native failure and poisons; a failed rollback never releases work',async()=>{
 for(const stage of ['rollback','release']as const){
  const abort=new AbortController(),native=Object.assign(Error('native refusal'),{code:'42501'}),cleanup=Error('uncertain '+stage),events:string[]=[],poisoned:Error[]=[];
  const failure=await runReviewObservationRefusal(abort.signal,{open:async()=>{},rollback:async()=>{events.push('rollback');if(stage==='rollback')throw cleanup;},release:async()=>{events.push('release');throw cleanup;}},async run=>run(undefined),async()=>{throw native;},()=>{events.push('forbidden-verify');},error=>poisoned.push(error)).then(()=>undefined,error=>error);
  expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([native,cleanup]);expect(events).toEqual(stage==='rollback'?['rollback']:['rollback','release']);expect(poisoned).toHaveLength(1);
 }
});
it('abort during parent rollback cannot skip release or settle early and never verifies an expected native denial',async()=>{
 const abort=new AbortController(),primary=Error('abort during frame cleanup'),native=Object.assign(Error('native refusal'),{code:'42501'}),events:string[]=[],poisoned:Error[]=[];
 let rollback!:()=>void,rolling!:()=>void,release!:()=>void,releasing!:()=>void;const began=new Promise<void>(done=>{rolling=done;}),released=new Promise<void>(done=>{releasing=done;});
 const pending=runReviewObservationRefusal(abort.signal,{open:async()=>{},rollback:async()=>{events.push('rollback');rolling();await new Promise<void>(done=>{rollback=done;});},release:async()=>{events.push('release');releasing();await new Promise<void>(done=>{release=done;});}},async run=>run(undefined),async()=>{throw native;},()=>{events.push('forbidden-verify');},error=>poisoned.push(error));
 let settled=false;const outcome=pending.catch(error=>{settled=true;return error;});await began;abort.abort(primary);rollback();await released;expect(settled).toBe(false);release();expect(await outcome).toBe(primary);expect(events).toEqual(['rollback','release']);expect(poisoned).toEqual([]);
});
import {reviewObservationAclObservation} from './prototypes/rewards-audit-policy-review-observer-contract';
it('records only closed native ACL booleans with exact source-owned phases and real-root shape, never private payload or permission authority',()=>{
 const root={pid:123,started:'2026-11-08 00:00:00.123456+00',xid:'123',login:'ai_hr_app',database:'fictional-owned-db'},row={kind:'UNINSTALLED_REWARDS_OBSERVER_ACL_OBSERVATION',releaseAuthorized:false,action:reviewObservationActions[0],stage:'app-first-effective',allowed:true,root};
 expect(reviewObservationAclObservation.parse(row)).toEqual(row);
 for(const stage of ['owner-before-revoke','owner-after-commit','app-first-effective','app-direct','app-after-effective'])for(const allowed of [true,false])expect(reviewObservationAclObservation.parse({...row,stage,allowed}).allowed).toBe(allowed);
 for(const changed of [{...row,allowed:'false'},{...row,stage:'cache-proven'},{...row,releaseAuthorized:true},{...row,privateSql:'forbidden'},{...row,root:{...root,login:'owner'}}])expect(()=>reviewObservationAclObservation.parse(changed)).toThrow();
 const helper=readFileSync('test/prototypes/rewards-audit-policy-review-observer.ts','utf8');
 expect(helper).toContain("observe('app-first-effective',first.allowed,actualRoot)");expect(helper).toContain("observe('app-direct',direct.allowed,actualRoot);expect(direct.allowed).toBe(false)");expect(helper).not.toContain('expect(first.allowed).toBe(false)');expect(helper).not.toContain('expect(after.allowed).toBe(false)');
});
it('preserves distinct native, abort, frame and poisoning failures by identity while deduplicating the same callback-owner failure',async()=>{
 const abort=new AbortController(),native=Object.assign(Error('native refusal'),{code:'42501'}),primary=Error('owned abort'),cleanup=Error('frame rollback failed'),poisonFailure=Error('poison hook failed');let releases=0;
 const failure=await runReviewObservationRefusal(abort.signal,{open:async()=>{},rollback:async()=>{abort.abort(primary);throw cleanup;},release:async()=>{releases++;}},async run=>run(undefined),async()=>{throw native;},()=>{throw Error('forbidden verification');},()=>{throw poisonFailure;}).then(()=>undefined,error=>error);
 expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([native,primary,cleanup,poisonFailure]);expect(failure.errors.filter((error:unknown)=>error===native)).toHaveLength(1);expect(releases).toBe(0);
});


// Parse actual tagged templates without importing/executing the native observer.
import ts from 'typescript';
function observerSqlBoundaries(text:string){
 const file=ts.createSourceFile('observer.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const diagnostics=(file as ts.SourceFile&{parseDiagnostics:readonly ts.Diagnostic[]}).parseDiagnostics;
 if(diagnostics.length)throw Error('Observer TypeScript syntax required');
 const boundaries:{tag:string;before:string;after:string;start:number;beforeEnd:number}[]=[],tags:string[]=[];
 const visit=(node:ts.Node)=>{
  if(ts.isTaggedTemplateExpression(node)){
   const tag=node.tag.getText(file);tags.push(tag);
   if(!['sql','owner.client','tx','nested','other'].includes(tag))throw Error('Unknown observer SQL tag');
   if(ts.isTemplateExpression(node.template)){
    let before=node.template.head.text,beforeEnd=node.template.head.end-2;
    for(const span of node.template.templateSpans){
     boundaries.push({tag,before,after:span.literal.text,start:span.literal.getStart(file)+1,beforeEnd});
     before=span.literal.text;beforeEnd=span.literal.end-2;
    }
   }
  }
  ts.forEachChild(node,visit);
 };
 visit(file);
 const joined=/[A-Za-z0-9_$\u0080-\uFFFF]/;
 const bad=boundaries.filter(row=>joined.test(Array.from(row.before).at(-1)??'')||joined.test(Array.from(row.after)[0]??''));
 return{tags,boundaries,bad};
}
it('checks both sides of every scalar interpolation in the actual observer SQL templates, including committed ACL proof queries',()=>{
 const helper=readFileSync('test/prototypes/rewards-audit-policy-review-observer.ts','utf8'),actual=observerSqlBoundaries(helper);
 expect(new Set(actual.tags)).toEqual(new Set(['sql','owner.client','tx','nested','other']));
 expect(actual.tags).toHaveLength(53);expect(actual.boundaries).toHaveLength(47);expect(actual.bad).toEqual([]);
 // Exact two-boundary predecessor mutation is red even though TypeScript parses.
 const previous=helper.replace('${root.pid} and b.backend_started_at','${root.pid}and b.backend_started_at').replace('::xid8 and a.datname=${database} and a.usename', '::xid8 and a.datname=${database}and a.usename');
 expect(previous).not.toBe(helper);expect(observerSqlBoundaries(previous).bad).toHaveLength(2);
});
it('detects newly joined SQL identifiers at every actual interpolation rather than trusting the repaired literals alone',()=>{
 const helper=readFileSync('test/prototypes/rewards-audit-policy-review-observer.ts','utf8'),actual=observerSqlBoundaries(helper);
 expect(actual.boundaries).toHaveLength(47);
 for(const boundary of actual.boundaries){
  // Insert at actual AST literal edges: casts and closing punctuation are retained.
  const joinedAfter=helper.slice(0,boundary.start)+'and'+helper.slice(boundary.start);
  const joinedBefore=helper.slice(0,boundary.beforeEnd)+'where'+helper.slice(boundary.beforeEnd);
  expect(observerSqlBoundaries(joinedAfter).bad.length).toBeGreaterThan(0);
  expect(observerSqlBoundaries(joinedBefore).bad.length).toBeGreaterThan(0);
 }
 for(const text of ['sql`select 1and${value}::uuid`','owner.client`select id=${value}and true`'])expect(observerSqlBoundaries(text).bad).toHaveLength(1);
 expect(()=>observerSqlBoundaries('unexpected`select ${value}`')).toThrow('Unknown observer SQL tag');
 expect(()=>observerSqlBoundaries('sql`select ${value}')).toThrow('Observer TypeScript syntax required');
 expect(observerSqlBoundaries("sql`select id=${value}::uuid,(${other})` ").bad).toEqual([]);
});

import {reviewObservationRestorationObservation} from './prototypes/rewards-audit-policy-review-observer-contract';
it('keeps app restoration observations separate from native authority and never reflects private function profiles',()=>{
 const root={pid:123,started:'2026-11-08 00:00:00.123456+00',xid:'123',login:'ai_hr_app',database:'fictional-owned-db'};
 const row={kind:'UNINSTALLED_REWARDS_OBSERVER_RESTORATION_OBSERVATION',releaseAuthorized:false,action:reviewObservationActions[0],mutation:'execute',stage:'first-effective',allowed:false,root};
 for(const mutation of ['execute','cost'])for(const stage of ['first-effective','current-profile','fresh-effective','positive-read'])for(const allowed of [true,false])expect(reviewObservationRestorationObservation.parse({...row,mutation,stage,allowed})).toEqual({...row,mutation,stage,allowed});
 for(const changed of [{...row,profile:{private:'payload'}},{...row,releaseAuthorized:true},{...row,allowed:'true'},{...row,mutation:'flush'},{...row,stage:'cache-proven'},{...row,root:{...root,xid:'123\n'}}])expect(()=>reviewObservationRestorationObservation.parse(changed)).toThrow();
 expect(JSON.stringify(reviewObservationRestorationObservation.parse(row))).not.toContain('profile');
});
