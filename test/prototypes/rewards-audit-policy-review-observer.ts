/** Disposable TEST capability only. Never imported by an application service. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {z} from 'zod';
import type {ISql,TransactionSql} from 'postgres';
import type {SessionContext,Tx} from '../../db/client';
import {pgSqlState} from '../../lib/db-error';
import type {RewardsAuditOwnerDependencies} from './rewards-audited-read-owner-factory';
import {controlledPolicyWait} from './rewards-audit-policy-controlled-wait';
import {reviewObservationNativeBody,reviewObservationAclObservation,reviewObservationRestorationObservation,reviewObservationScope,reviewObservationRoot,reviewObservationResult,runReviewObservationRefusal,type ReviewObservationAction} from './rewards-audit-policy-review-observer-contract';

const source=readFileSync('test/prototypes/rewards-audit-policy-review-observer.sql','utf8');
const functionBody=reviewObservationNativeBody(source);
type Action=ReviewObservationAction;
type Root=z.infer<typeof reviewObservationRoot>;
const snapshotSchema=z.object({schemas:z.array(z.unknown()).length(2),functions:z.array(z.unknown()).length(1),relations:z.array(z.unknown()).length(2),dependencies:z.array(z.unknown()),shared:z.array(z.unknown())}).strict();
type Snapshot=z.infer<typeof snapshotSchema>;

/** Fixed parent fence around the REAL Drizzle nested error owner. */
export async function runRewardPolicyReviewTxRefusal(tx:Tx,signal:AbortSignal,work:(nested:Tx)=>Promise<unknown>,verify:(error:unknown)=>void,poison:(error:Error)=>void){
 await runReviewObservationRefusal<Tx>(signal,{
  open:()=>tx.execute(sql`savepoint owned_test_observer_refusal`),
  rollback:()=>tx.execute(sql`rollback to savepoint owned_test_observer_refusal`),
  release:()=>tx.execute(sql`release savepoint owned_test_observer_refusal`),
 },run=>tx.transaction(run),work,verify,poison);
}

export async function createRewardPolicyReviewObserver(owner:RewardsAuditOwnerDependencies['owner'],database:string,poison:(error:Error)=>void,constructorSignal:AbortSignal){
 let expected:Snapshot|undefined,closed=false,installationObserved=false;
 const bindings=new Map<string,Root>(),proved=new Set<Action>();
 let mutation:{kind:'execute'|'cost';next?:Snapshot}|undefined;
 async function namespaces(){const [row]=await owner.client`select to_regnamespace('reward_policy_test')is not null as exposed,to_regnamespace('reward_policy_test_private')is not null as private`;return row;}
 async function business(tx:ISql,signal?:AbortSignal){signal?.throwIfAborted();const [row]=await tx`select reward_audit_private.relation_metadata('app.assistant_own_leave_review'::regclass)as value`;return row.value;}
 const originalBusiness=await business(owner.client);
 async function image(tx:ISql,signal?:AbortSignal):Promise<Snapshot>{
  signal?.throwIfAborted();const [row]=await tx`select
   (select jsonb_agg(to_jsonb(n)order by n.nspname)from pg_namespace n where n.nspname in('reward_policy_test','reward_policy_test_private'))as schemas,
   (select jsonb_agg(to_jsonb(p)order by p.oid)from pg_proc p where p.pronamespace in('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace))as functions,
   (select jsonb_agg(jsonb_build_object('name',r.oid::regclass::text,'details',reward_audit_private.relation_metadata(r.oid))order by r.oid)from pg_class r where r.relnamespace in('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace)and r.relkind not in('i','I'))as relations,
   (select coalesce(jsonb_agg(to_jsonb(d)order by d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype),'[]'::jsonb)from pg_depend d where(d.classid='pg_proc'::regclass and d.objid='reward_policy_test.read_review(uuid,text)'::regprocedure)or(d.refclassid='pg_proc'::regclass and d.refobjid='reward_policy_test.read_review(uuid,text)'::regprocedure))as dependencies,
   (select coalesce(jsonb_agg(to_jsonb(d)order by d.dbid,d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.deptype),'[]'::jsonb)from pg_shdepend d where d.dbid=(select oid from pg_database where datname=current_database())and d.classid='pg_proc'::regclass and d.objid='reward_policy_test.read_review(uuid,text)'::regprocedure)as shared`;
  return snapshotSchema.parse(row);
 }
 async function install(tx:TransactionSql,signal:AbortSignal){
  signal.throwIfAborted();await tx`select set_config('aihr.reward_policy_observer.database',${database},true)`;
  signal.throwIfAborted();await tx.unsafe(source);
  signal.throwIfAborted();const [native]=await tx`select p.prosrc as body,p.prosecdef as definer,p.provolatile as volatility,p.proconfig as settings,
   p.proargnames as names,pg_get_function_result(p.oid)as result,p.proowner=(select relowner from pg_class where oid='public.domain_event'::regclass)as native_owner
   from pg_proc p where p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure`;
  expect(native).toEqual({body:functionBody,definer:true,volatility:'s',settings:['search_path=pg_catalog, pg_temp'],names:['p_review','p_action'],result:'jsonb',native_owner:true});
  signal.throwIfAborted();const [acl]=await tx`select
   has_schema_privilege('ai_hr_app','reward_policy_test','USAGE')as schema_usage,
   has_schema_privilege('ai_hr_app','reward_policy_test_private','USAGE')as private_usage,
   has_function_privilege('ai_hr_app','reward_policy_test.read_review(uuid,text)','EXECUTE')as execute,
   not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))g where p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure and(g.privilege_type<>'EXECUTE'or g.is_grantable or g.grantor<>p.proowner or g.grantee not in(p.proowner,'ai_hr_app'::regrole::oid)))as exact_acl,
   not exists(select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))g where n.nspname in('reward_policy_test','reward_policy_test_private')and(g.grantor<>n.nspowner or g.is_grantable or g.grantee<>n.nspowner and not(n.nspname='reward_policy_test'and g.grantee='ai_hr_app'::regrole::oid and g.privilege_type='USAGE')))as exact_schemas,
   not exists(select 1 from pg_class r cross join lateral aclexplode(coalesce(r.relacl,acldefault('r',r.relowner)))g where r.relnamespace='reward_policy_test_private'::regnamespace and(g.grantee<>r.relowner or g.grantor<>r.relowner))and not exists(select 1 from pg_attribute a join pg_class r on r.oid=a.attrelid where r.relnamespace='reward_policy_test_private'::regnamespace and a.attacl is not null)as owner_only_tables,
   not has_schema_privilege('ai_hr_reward_audit_read','reward_policy_test','USAGE')and not has_schema_privilege('ai_hr_reward_audit_projector','reward_policy_test','USAGE')and not has_function_privilege('ai_hr_reward_audit_read','reward_policy_test.read_review(uuid,text)','EXECUTE')and not has_function_privilege('ai_hr_reward_audit_projector','reward_policy_test.read_review(uuid,text)','EXECUTE')as dedicated_roles_denied,
   not exists(select 1 from pg_class r where r.relnamespace='reward_policy_test_private'::regnamespace and(has_table_privilege('ai_hr_app',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')or has_any_column_privilege('ai_hr_app',r.oid,'SELECT,INSERT,UPDATE,REFERENCES')))as private_tables_denied,
   not has_column_privilege('ai_hr_app','app.assistant_own_leave_review','bank_audit_preimage','SELECT')and not has_column_privilege('ai_hr_app','app.assistant_own_leave_review','catalogue_audit_preimage','SELECT')and not has_column_privilege('ai_hr_app','app.assistant_own_leave_review','catalogue_native_phase','SELECT')as original_private_columns_denied`;
  expect(acl).toEqual({schema_usage:true,private_usage:false,execute:true,exact_acl:true,exact_schemas:true,owner_only_tables:true,dedicated_roles_denied:true,private_tables_denied:true,original_private_columns_denied:true});
  signal.throwIfAborted();await tx`insert into reward_policy_test_private.config values(true,current_database(),current_user::regrole::oid,'ai_hr_app'::regrole::oid,false,
   (select to_jsonb(p)from pg_proc p where p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure),
   (select to_jsonb(p)from pg_proc p where p.oid='reward_audit_private.relation_metadata(oid)'::regprocedure),
   (select jsonb_agg(to_jsonb(n)order by n.nspname)from pg_namespace n where n.nspname in('reward_policy_test','reward_policy_test_private')),
   (select jsonb_agg(jsonb_build_object('name',r.oid::regclass::text,'details',reward_audit_private.relation_metadata(r.oid))order by r.oid)from pg_class r where r.relnamespace in('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace)and r.relkind not in('i','I'))) `;
  signal.throwIfAborted();await tx`update reward_policy_test_private.config set enabled=true`;
  expect(await business(tx,signal)).toEqual(originalBusiness);return image(tx,signal);
 }
 async function assertImage(){if(closed||!expected)throw Error('Owned test observer is closed');expect(await image(owner.client)).toEqual(expected);expect(await business(owner.client)).toEqual(originalBusiness);}
 async function clear(){
  await assertImage();
  const [row]=await owner.client`with roots as(select backend_pid as pid,backend_started_at as started,root_xid as xid from reward_policy_test_private.binding union select r.pid,r.started::timestamptz,r.xid::xid8 from jsonb_to_recordset(${JSON.stringify([...bindings.values()])}::text::jsonb)as r(pid integer,started text,xid text))select not exists(select 1 from roots b join pg_stat_activity a on a.pid=b.pid and a.backend_start=b.started and a.datname=${database} join pg_locks l on l.pid=a.pid where l.locktype='transactionid'and l.granted and l.mode='ExclusiveLock'and l.transactionid=b.xid::xid)as settled`;
  expect(row.settled,'actual native observed root transactions must settle before fixture reset').toBe(true);
  await owner.client`delete from reward_policy_test_private.binding`;bindings.clear();
 }
 async function close(){
  const actual=await namespaces();
  if(actual.exposed===false&&actual.private===false){if(installationObserved&&!closed)throw Error('Owned test observer disappeared before cleanup');closed=true;return;}
  if(!expected)throw Error('Unknown test observer installation; retained');
  await restoreMutation();await clear();
  await owner.client.begin(async tx=>{
   expect(await image(tx)).toEqual(expected);expect(await business(tx)).toEqual(originalBusiness);
   await tx`drop function reward_policy_test.read_review(uuid,text)`;
   await tx`drop table reward_policy_test_private.binding,reward_policy_test_private.config`;
   await tx`drop schema reward_policy_test,reward_policy_test_private`;
   expect(await business(tx)).toEqual(originalBusiness);
  });
  expect(await namespaces()).toEqual({exposed:false,private:false});closed=true;
 }
 try{
  expect(await namespaces()).toEqual({exposed:false,private:false});
  await owner.client.begin(async tx=>{
   constructorSignal.throwIfAborted();await tx`savepoint owned_observer_constructor`;
   await controlledPolicyWait(poison).run(async()=>{await install(tx,constructorSignal);},async()=>{await tx`rollback to savepoint owned_observer_constructor`;await tx`release savepoint owned_observer_constructor`;});
   constructorSignal.throwIfAborted();
   const [absent]=await tx`select to_regnamespace('reward_policy_test')is null and to_regnamespace('reward_policy_test_private')is null as absent`;
   expect(absent.absent).toBe(true);expect(await business(tx,constructorSignal)).toEqual(originalBusiness);
   expected=await install(tx,constructorSignal); // complete native intent BEFORE possible COMMIT
  });
  constructorSignal.throwIfAborted();await assertImage();constructorSignal.throwIfAborted();installationObserved=true;
 }catch(error){await controlledPolicyWait(poison).run(async()=>{throw error;},close);throw error;}
 async function startMutation(kind:'execute'|'cost',signal:AbortSignal){
  signal.throwIfAborted();await assertImage();signal.throwIfAborted();
  if(mutation)throw Error('Previous native observer mutation has not restored');
  const intent:{kind:'execute'|'cost';next?:Snapshot}={kind};mutation=intent;
  await owner.client.begin(async tx=>{
   expect(await image(tx,signal)).toEqual(expected);signal.throwIfAborted();
   if(kind==='execute')await tx`revoke execute on function reward_policy_test.read_review(uuid,text)from ai_hr_app`;
   else await tx`alter function reward_policy_test.read_review(uuid,text)cost 101`;
   signal.throwIfAborted();intent.next=await image(tx,signal); // full native intent BEFORE possible COMMIT
   signal.throwIfAborted();
  });
 }
 async function restoreMutation(){
  const intent=mutation;if(!intent)return;
  if(!expected)throw Error('Native observer restore preimage absent');
  const actual=await image(owner.client);
  if(isDeepStrictEqual(actual,expected)){mutation=undefined;return;}
  if(!intent.next)throw Error('Unknown observer mutation postimage; retained');
  expect(actual).toEqual(intent.next);
  await owner.client.begin(async tx=>{
   expect(await image(tx)).toEqual(intent.next);
   if(intent.kind==='execute')await tx`grant execute on function reward_policy_test.read_review(uuid,text)to ai_hr_app`;
   else await tx`alter function reward_policy_test.read_review(uuid,text)cost 100`;
   expect(await image(tx)).toEqual(expected);
  });
  await assertImage();mutation=undefined;
 }
 async function bind(tx:Tx,ctx:SessionContext,reviewId:string,action:Action,signal:AbortSignal){
  signal.throwIfAborted();await assertImage();signal.throwIfAborted();
  const scope=reviewObservationScope.parse({tenantId:ctx.tenantId,userId:ctx.userId,reviewId,action});
  const [raw]=await tx.execute(sql`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,pg_current_xact_id()::text as xid,session_user::text as login,current_database()as database`);
  const root=reviewObservationRoot.parse(raw);expect(root.database).toBe(database);signal.throwIfAborted();
  const [actual]=await owner.client`select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.pid=${root.pid} and a.backend_start=${root.started}::text::timestamptz and a.datname=${database} and a.usename='ai_hr_app'and l.locktype='transactionid'and l.granted and l.mode='ExclusiveLock'and l.transactionid=${root.xid}::text::xid8::xid)as actual,
   exists(select 1 from app.assistant_own_leave_review where id=${scope.reviewId}::uuid and tenant_id=${scope.tenantId}::uuid and user_id=${scope.userId}::uuid and action_kind=${scope.action} and state='awaiting_confirmation')as review`;
  expect(actual).toEqual({actual:true,review:true});signal.throwIfAborted();
  const prior=bindings.get(reviewId);if(prior)expect(root).toEqual(prior);
  else{
   await owner.client`insert into reward_policy_test_private.binding values(${scope.reviewId}::uuid,${scope.tenantId}::uuid,${scope.userId}::uuid,${scope.action},'ai_hr_app'::regrole::oid,${root.pid},${root.started}::text::timestamptz,${root.xid}::text::xid8)`;
   bindings.set(reviewId,root);
  }
  signal.throwIfAborted();return root;
 }
 async function read(tx:Tx,reviewId:string,action:Action,signal:AbortSignal){signal.throwIfAborted();const [row]=await tx.execute(sql`select reward_policy_test.read_review(${reviewId}::uuid,${action}::text)as value`);signal.throwIfAborted();return reviewObservationResult.parse(row?.value);}
 async function restoredAppBaseline(tx:Tx,reviewId:string,action:Action,root:Root,kind:'execute'|'cost',signal:AbortSignal){
  signal.throwIfAborted();await assertImage();signal.throwIfAborted();
  if(mutation||!expected)throw Error('Native observer mutation restoration has not settled');
  const observe=(stage:z.infer<typeof reviewObservationRestorationObservation>['stage'],allowed:boolean)=>{
   console.info(JSON.stringify(reviewObservationRestorationObservation.parse({kind:'UNINSTALLED_REWARDS_OBSERVER_RESTORATION_OBSERVATION',releaseAuthorized:false,action,mutation:kind,stage,allowed,root})));
  };
  // Retain the FIRST same-app effective sample. It is observation, not a claim
  // about when the backend applies catalogue invalidation from owner COMMIT.
  const [first]=await tx.execute(sql`select has_function_privilege(session_user,'reward_policy_test.read_review(uuid,text)','EXECUTE')as allowed`);
  signal.throwIfAborted();
  const [current]=await tx.execute(sql`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,pg_current_xact_id()::text as xid,session_user::text as login,current_database()as database,
   (select to_jsonb(p)from pg_proc p where p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure)as profile`);
  signal.throwIfAborted();const {profile,...identity}=current;expect(reviewObservationRoot.parse(identity)).toEqual(root);
  observe('first-effective',z.boolean().parse(first.allowed));expect(profile).toEqual(expected.functions[0]);observe('current-profile',true);
  const [fresh]=await tx.execute(sql`select has_function_privilege(session_user,'reward_policy_test.read_review(uuid,text)','EXECUTE')as allowed`);
  signal.throwIfAborted();observe('fresh-effective',z.boolean().parse(fresh.allowed));expect(fresh.allowed).toBe(true);
  // Actual unchanged SECURITY DEFINER observer validates its complete native
  // profile, principal/root binding and private PRE shape. Never grant raw data
  // privileges, flush a cache or change an expected refusal to reach this point.
  await read(tx,reviewId,action,signal);signal.throwIfAborted();observe('positive-read',true);
 }
 async function refused(tx:Tx,signal:AbortSignal,work:(nested:Tx)=>Promise<unknown>,code='42501'){
  await runRewardPolicyReviewTxRefusal(tx,signal,work,error=>{
   expect(error,'the actual native statement must refuse').toBeDefined();expect(pgSqlState(error)).toBe(code);
  },poison);
 }
 async function privateDenied(tx:Tx,reviewId:string,action:Action,signal:AbortSignal){
  await refused(tx,signal,nested=>nested.execute(action==='employees.bank.maintain'
   ?sql`select bank_audit_preimage from app.assistant_own_leave_review where id=${reviewId}::uuid`
   :sql`select catalogue_native_phase,catalogue_audit_preimage from app.assistant_own_leave_review where id=${reviewId}::uuid`));
 }
 async function prove(tx:Tx,ctx:SessionContext,reviewId:string,action:Action,root:Root,foreign:Readonly<{tenantId:string;userId:string}>,signal:AbortSignal){
  signal.throwIfAborted();
  const foreignScope=z.object({tenantId:z.guid(),userId:z.guid()}).strict().parse(foreign);
  expect(foreignScope.tenantId).not.toBe(ctx.tenantId);expect(foreignScope.userId).not.toBe(ctx.userId);
  const [realForeign]=await owner.client`select exists(select 1 from public.app_user where id=${foreignScope.userId}::uuid and tenant_id=${foreignScope.tenantId}::uuid and archived_at is null)as actual`;
  expect(realForeign.actual).toBe(true);
  await refused(tx,signal,nested=>read(nested,randomUUID(),action,signal));
  await refused(tx,signal,nested=>read(nested,reviewId,action==='employees.bank.maintain'?'org.position.archive':'employees.bank.maintain',signal));
  await refused(tx,signal,nested=>nested.execute(sql`select reward_policy_test.read_review(null,${action}::text)`));
  await refused(tx,signal,nested=>nested.execute(sql`select reward_policy_test.read_review(${'not-a-uuid'}::uuid,${action}::text)`),'22P02');
  await refused(tx,signal,async nested=>{await nested.execute(sql`select set_config('app.user_id',${foreignScope.userId},true)`);signal.throwIfAborted();return read(nested,reviewId,action,signal);});
  await refused(tx,signal,async nested=>{
   await nested.execute(sql`select set_config('app.tenant_id',${foreignScope.tenantId},true),set_config('app.user_id',${foreignScope.userId},true)`);signal.throwIfAborted();
   const [actual]=await nested.execute(sql`select app.principal_snapshot_current()as current`);signal.throwIfAborted();expect(actual.current).toBe(true);return read(nested,reviewId,action,signal);
  });
  await refused(tx,signal,async nested=>{await nested.execute(sql`set local role ai_hr_app`);signal.throwIfAborted();return read(nested,reviewId,action,signal);});
  const restoreBinding=async()=>{
   expect(await owner.client`update reward_policy_test_private.binding set backend_pid=${root.pid},backend_started_at=${root.started}::text::timestamptz,root_xid=${root.xid}::text::xid8 where review_id=${reviewId}::uuid returning review_id`).toHaveLength(1);
  };
  // Each mismatch is a REAL other native backend identity, never a caller packet.
  for(const field of ['pid','start','xid']as const){
   signal.throwIfAborted();await controlledPolicyWait(poison).run(async()=>{
    const changed=field==='pid'?await owner.client`update reward_policy_test_private.binding set backend_pid=pg_backend_pid()where review_id=${reviewId}::uuid returning backend_pid<>${root.pid} as distinct_identity`
     :field==='start'?await owner.client`update reward_policy_test_private.binding set backend_started_at=(select backend_start from pg_stat_activity where pid=pg_backend_pid())where review_id=${reviewId}::uuid returning backend_started_at<>${root.started}::text::timestamptz as distinct_identity`
     :await owner.client`update reward_policy_test_private.binding set root_xid=pg_current_xact_id()where review_id=${reviewId}::uuid returning root_xid<>${root.xid}::text::xid8 as distinct_identity`;
    expect(Array.from(changed)).toEqual([{distinct_identity:true}]);signal.throwIfAborted();await refused(tx,signal,nested=>read(nested,reviewId,action,signal));
   },restoreBinding);
  }
  signal.throwIfAborted();await controlledPolicyWait(poison).run(async()=>{
   const observe=(stage:z.infer<typeof reviewObservationAclObservation>['stage'],allowed:unknown,actualRoot:Root)=>{
    const row=reviewObservationAclObservation.parse({kind:'UNINSTALLED_REWARDS_OBSERVER_ACL_OBSERVATION',releaseAuthorized:false,action,stage,allowed,root:actualRoot});
    expect(actualRoot).toEqual(root);console.info(JSON.stringify(row));
   };
   const ownerDirect=async(stage:'owner-before-revoke'|'owner-after-commit')=>{
    signal.throwIfAborted();const [row]=await owner.client`select
     exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))g
      where p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure and g.grantee='ai_hr_app'::regrole::oid
      and g.grantor=p.proowner and g.privilege_type='EXECUTE'and g.is_grantable=false)as allowed,
     exists(select 1 from reward_policy_test_private.binding b join pg_stat_activity a on a.pid=b.backend_pid and a.backend_start=b.backend_started_at
      join pg_locks l on l.pid=a.pid and l.locktype='transactionid'and l.granted and l.mode='ExclusiveLock'and l.transactionid=b.root_xid::xid
      where b.review_id=${reviewId}::uuid and b.backend_pid=${root.pid} and b.backend_started_at=${root.started}::text::timestamptz
      and b.root_xid=${root.xid}::text::xid8 and a.datname=${database} and a.usename='ai_hr_app')as bound`;
    signal.throwIfAborted();expect(row.bound).toBe(true);observe(stage,row.allowed,root);return row.allowed;
   };
   expect(await ownerDirect('owner-before-revoke')).toBe(true);
   await startMutation('execute',signal);signal.throwIfAborted();
   expect(await ownerDirect('owner-after-commit')).toBe(false);
   // FIRST app-side statement after owner COMMIT: no added catalog/root query
   // can refresh backend metadata before this actual effective-privilege sample.
   const [first]=await tx.execute(sql`select has_function_privilege(session_user,'reward_policy_test.read_review(uuid,text)','EXECUTE')as allowed`);
   signal.throwIfAborted();
   const [raw]=await tx.execute(sql`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,pg_current_xact_id()::text as xid,session_user::text as login,current_database()as database`);
   signal.throwIfAborted();const actualRoot=reviewObservationRoot.parse(raw);expect(actualRoot).toEqual(root);observe('app-first-effective',first.allowed,actualRoot);
   const [direct]=await tx.execute(sql`select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))g
    where p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure and g.grantee='ai_hr_app'::regrole::oid
    and g.grantor=p.proowner and g.privilege_type='EXECUTE'and g.is_grantable=false)as allowed`);
   signal.throwIfAborted();observe('app-direct',direct.allowed,actualRoot);expect(direct.allowed).toBe(false);
   const [after]=await tx.execute(sql`select has_function_privilege(session_user,'reward_policy_test.read_review(uuid,text)','EXECUTE')as allowed`);
   signal.throwIfAborted();observe('app-after-effective',after.allowed,actualRoot);
   await refused(tx,signal,nested=>read(nested,reviewId,action,signal));
  },restoreMutation);
  await restoredAppBaseline(tx,reviewId,action,root,'execute',signal);
  signal.throwIfAborted();await controlledPolicyWait(poison).run(async()=>{
   await startMutation('cost',signal);signal.throwIfAborted();await refused(tx,signal,nested=>read(nested,reviewId,action,signal),'55000');
  },restoreMutation);
  await restoredAppBaseline(tx,reviewId,action,root,'cost',signal);
  signal.throwIfAborted();
  await owner.client.begin(async other=>{
   await runReviewObservationRefusal<TransactionSql>(signal,{
    open:()=>other`savepoint owned_observer_wrong_login`,
    rollback:()=>other`rollback to savepoint owned_observer_wrong_login`,
    release:()=>other`release savepoint owned_observer_wrong_login`,
   },run=>other.savepoint(run),nested=>nested`select reward_policy_test.read_review(${reviewId}::uuid,${action}::text)`,error=>{
    expect(error).toBeDefined();expect(pgSqlState(error)).toBe('42501');
   },poison);
  });
  signal.throwIfAborted();await assertImage();await privateDenied(tx,reviewId,action,signal);await read(tx,reviewId,action,signal);proved.add(action);
 }
 return{clear,close,assertImage,
  async observe(tx:Tx,ctx:SessionContext,reviewId:string,action:Action,signal:AbortSignal,foreign?:Readonly<{tenantId:string;userId:string}>){
   signal.throwIfAborted();await privateDenied(tx,reviewId,action,signal);signal.throwIfAborted();
   const root=await bind(tx,ctx,reviewId,action,signal);signal.throwIfAborted();
   if(foreign&&!proved.has(action))await prove(tx,ctx,reviewId,action,root,foreign,signal);
   signal.throwIfAborted();const value=await read(tx,reviewId,action,signal);
   signal.throwIfAborted();await privateDenied(tx,reviewId,action,signal);signal.throwIfAborted();return value;
  },
 };
}
