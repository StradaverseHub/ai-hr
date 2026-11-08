/** Disposable TEST capability only. Never imported by an application service. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {z} from 'zod';
import type {ISql,TransactionSql} from 'postgres';
import type {SessionContext,Tx} from '../../db/client';
import {pgSqlState} from '../../lib/db-error';
import type {RewardsAuditOwnerDependencies} from './rewards-audited-read-owner-factory';
import {controlledPolicyWait} from './rewards-audit-policy-controlled-wait';
import {reviewObservationNativeBody,reviewObservationScope,reviewObservationRoot,reviewObservationResult,type ReviewObservationAction} from './rewards-audit-policy-review-observer-contract';

const source=readFileSync('test/prototypes/rewards-audit-policy-review-observer.sql','utf8');
const functionBody=reviewObservationNativeBody(source);
type Action=ReviewObservationAction;
type Root=z.infer<typeof reviewObservationRoot>;
const snapshotSchema=z.object({schemas:z.array(z.unknown()).length(2),functions:z.array(z.unknown()).length(1),relations:z.array(z.unknown()).length(2),dependencies:z.array(z.unknown()),shared:z.array(z.unknown())}).strict();
type Snapshot=z.infer<typeof snapshotSchema>;

export async function createRewardPolicyReviewObserver(owner:RewardsAuditOwnerDependencies['owner'],database:string,poison:(error:Error)=>void){
 let expected:Snapshot|undefined,closed=false,installationObserved=false;
 const bindings=new Map<string,Root>(),proved=new Set<Action>();
 async function namespaces(){const [row]=await owner.client`select to_regnamespace('reward_policy_test')is not null as exposed,to_regnamespace('reward_policy_test_private')is not null as private`;return row;}
 async function business(tx:ISql){const [row]=await tx`select reward_audit_private.relation_metadata('app.assistant_own_leave_review'::regclass)as value`;return row.value;}
 const originalBusiness=await business(owner.client);
 async function image(tx:ISql):Promise<Snapshot>{
  const [row]=await tx`select
   (select jsonb_agg(to_jsonb(n)order by n.nspname)from pg_namespace n where n.nspname in('reward_policy_test','reward_policy_test_private'))as schemas,
   (select jsonb_agg(to_jsonb(p)order by p.oid)from pg_proc p where p.pronamespace in('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace))as functions,
   (select jsonb_agg(jsonb_build_object('name',r.oid::regclass::text,'details',reward_audit_private.relation_metadata(r.oid))order by r.oid)from pg_class r where r.relnamespace in('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace)and r.relkind not in('i','I'))as relations,
   (select coalesce(jsonb_agg(to_jsonb(d)order by d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype),'[]'::jsonb)from pg_depend d where(d.classid='pg_proc'::regclass and d.objid='reward_policy_test.read_review(uuid,text)'::regprocedure)or(d.refclassid='pg_proc'::regclass and d.refobjid='reward_policy_test.read_review(uuid,text)'::regprocedure))as dependencies,
   (select coalesce(jsonb_agg(to_jsonb(d)order by d.dbid,d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.deptype),'[]'::jsonb)from pg_shdepend d where d.dbid=(select oid from pg_database where datname=current_database())and d.classid='pg_proc'::regclass and d.objid='reward_policy_test.read_review(uuid,text)'::regprocedure)as shared`;
  return snapshotSchema.parse(row);
 }
 async function install(tx:TransactionSql){
  await tx`select set_config('aihr.reward_policy_observer.database',${database},true)`;
  await tx.unsafe(source);
  const [native]=await tx`select p.prosrc as body,p.prosecdef as definer,p.provolatile as volatility,p.proconfig as settings,
   p.proargnames as names,pg_get_function_result(p.oid)as result,p.proowner=(select relowner from pg_class where oid='public.domain_event'::regclass)as native_owner
   from pg_proc p where p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure`;
  expect(native).toEqual({body:functionBody,definer:true,volatility:'s',settings:['search_path=pg_catalog, pg_temp'],names:['p_review','p_action'],result:'jsonb',native_owner:true});
  const [acl]=await tx`select
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
  await tx`insert into reward_policy_test_private.config values(true,current_database(),current_user::regrole::oid,'ai_hr_app'::regrole::oid,false,
   (select to_jsonb(p)from pg_proc p where p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure),
   (select to_jsonb(p)from pg_proc p where p.oid='reward_audit_private.relation_metadata(oid)'::regprocedure),
   (select jsonb_agg(to_jsonb(n)order by n.nspname)from pg_namespace n where n.nspname in('reward_policy_test','reward_policy_test_private')),
   (select jsonb_agg(jsonb_build_object('name',r.oid::regclass::text,'details',reward_audit_private.relation_metadata(r.oid))order by r.oid)from pg_class r where r.relnamespace in('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace)and r.relkind not in('i','I'))) `;
  await tx`update reward_policy_test_private.config set enabled=true`;
  expect(await business(tx)).toEqual(originalBusiness);return image(tx);
 }
 async function assertImage(){if(closed||!expected)throw Error('Owned test observer is closed');expect(await image(owner.client)).toEqual(expected);expect(await business(owner.client)).toEqual(originalBusiness);}
 async function clear(){
  await assertImage();
  const [row]=await owner.client`select not exists(select 1 from reward_policy_test_private.binding b join pg_stat_activity a on a.pid=b.backend_pid and a.backend_start=b.backend_started_at and a.datname=${database} join pg_locks l on l.pid=a.pid where l.locktype='transactionid'and l.granted and l.mode='ExclusiveLock'and l.transactionid=b.root_xid::xid)as settled`;
  expect(row.settled,'actual native observed root transactions must settle before fixture reset').toBe(true);
  await owner.client`delete from reward_policy_test_private.binding`;bindings.clear();
 }
 async function close(){
  const actual=await namespaces();
  if(actual.exposed===false&&actual.private===false){if(installationObserved&&!closed)throw Error('Owned test observer disappeared before cleanup');closed=true;return;}
  if(!expected)throw Error('Unknown test observer installation; retained');
  await clear();
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
   await tx`savepoint owned_observer_constructor`;
   await install(tx);await tx`rollback to savepoint owned_observer_constructor`;await tx`release savepoint owned_observer_constructor`;
   const [absent]=await tx`select to_regnamespace('reward_policy_test')is null and to_regnamespace('reward_policy_test_private')is null as absent`;
   expect(absent.absent).toBe(true);expect(await business(tx)).toEqual(originalBusiness);
   expected=await install(tx); // complete native intent BEFORE possible COMMIT
  });
  await assertImage();installationObserved=true;
 }catch(error){await controlledPolicyWait(poison).run(async()=>{throw error;},close);throw error;}
 async function bind(tx:Tx,ctx:SessionContext,reviewId:string,action:Action,signal:AbortSignal){
  signal.throwIfAborted();await assertImage();signal.throwIfAborted();
  const scope=reviewObservationScope.parse({tenantId:ctx.tenantId,userId:ctx.userId,reviewId,action});
  const [raw]=await tx.execute(sql`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,pg_current_xact_id()::text as xid,session_user::text as login,current_database()as database`);
  const root=reviewObservationRoot.parse(raw);expect(root.database).toBe(database);signal.throwIfAborted();
  const [actual]=await owner.client`select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.pid=${root.pid} and a.backend_start=${root.started}::text::timestamptz and a.datname=${database}and a.usename='ai_hr_app'and l.locktype='transactionid'and l.granted and l.mode='ExclusiveLock'and l.transactionid=${root.xid}::text::xid8::xid)as actual,
   exists(select 1 from app.assistant_own_leave_review where id=${scope.reviewId}::uuid and tenant_id=${scope.tenantId}::uuid and user_id=${scope.userId}::uuid and action_kind=${scope.action}and state='awaiting_confirmation')as review`;
  expect(actual).toEqual({actual:true,review:true});signal.throwIfAborted();
  const prior=bindings.get(reviewId);if(prior)expect(root).toEqual(prior);
  else{
   await owner.client`insert into reward_policy_test_private.binding values(${scope.reviewId}::uuid,${scope.tenantId}::uuid,${scope.userId}::uuid,${scope.action},'ai_hr_app'::regrole::oid,${root.pid},${root.started}::text::timestamptz,${root.xid}::text::xid8)`;
   bindings.set(reviewId,root);
  }
  signal.throwIfAborted();return root;
 }
 async function read(tx:Tx,reviewId:string,action:Action){const [row]=await tx.execute(sql`select reward_policy_test.read_review(${reviewId}::uuid,${action}::text)as value`);return reviewObservationResult.parse(row?.value);}
 async function refused(tx:Tx,work:()=>Promise<unknown>,code='42501'){
  await tx.execute(sql`savepoint owned_test_observer_refusal`);
  await controlledPolicyWait(poison).run(async()=>{
   let error:unknown;try{await work();}catch(caught){error=caught;}
   expect(error,'the actual native statement must refuse').toBeDefined();expect(pgSqlState(error)).toBe(code);
  },async()=>{await tx.execute(sql`rollback to savepoint owned_test_observer_refusal`);await tx.execute(sql`release savepoint owned_test_observer_refusal`);});
 }
 async function privateDenied(tx:Tx,reviewId:string,action:Action){
  await refused(tx,()=>tx.execute(action==='employees.bank.maintain'
   ?sql`select bank_audit_preimage from app.assistant_own_leave_review where id=${reviewId}::uuid`
   :sql`select catalogue_native_phase,catalogue_audit_preimage from app.assistant_own_leave_review where id=${reviewId}::uuid`));
 }
 async function prove(tx:Tx,ctx:SessionContext,reviewId:string,action:Action,root:Root,foreign:Readonly<{tenantId:string;userId:string}>,signal:AbortSignal){
  signal.throwIfAborted();
  const foreignScope=z.object({tenantId:z.guid(),userId:z.guid()}).strict().parse(foreign);
  expect(foreignScope.tenantId).not.toBe(ctx.tenantId);expect(foreignScope.userId).not.toBe(ctx.userId);
  const [realForeign]=await owner.client`select exists(select 1 from public.app_user where id=${foreignScope.userId}::uuid and tenant_id=${foreignScope.tenantId}::uuid and archived_at is null)as actual`;
  expect(realForeign.actual).toBe(true);
  await refused(tx,()=>read(tx,randomUUID(),action));
  await refused(tx,()=>read(tx,reviewId,action==='employees.bank.maintain'?'org.position.archive':'employees.bank.maintain'));
  await refused(tx,()=>tx.execute(sql`select reward_policy_test.read_review(null,${action}::text)`));
  await refused(tx,()=>tx.execute(sql`select reward_policy_test.read_review(${'not-a-uuid'}::uuid,${action}::text)`),'22P02');
  await refused(tx,async()=>{await tx.execute(sql`select set_config('app.user_id',${foreignScope.userId},true)`);return read(tx,reviewId,action);});
  await refused(tx,async()=>{
   await tx.execute(sql`select set_config('app.tenant_id',${foreignScope.tenantId},true),set_config('app.user_id',${foreignScope.userId},true)`);
   const [actual]=await tx.execute(sql`select app.principal_snapshot_current()as current`);expect(actual.current).toBe(true);return read(tx,reviewId,action);
  });
  await refused(tx,async()=>{await tx.execute(sql`set local role ai_hr_app`);return read(tx,reviewId,action);});
  const restoreBinding=async()=>{
   expect(await owner.client`update reward_policy_test_private.binding set backend_pid=${root.pid},backend_started_at=${root.started}::text::timestamptz,root_xid=${root.xid}::text::xid8 where review_id=${reviewId}::uuid returning review_id`).toHaveLength(1);
  };
  // Each mismatch is a REAL other native backend identity, never a caller packet.
  for(const field of ['pid','start','xid']as const){
   signal.throwIfAborted();await controlledPolicyWait(poison).run(async()=>{
    const changed=field==='pid'?await owner.client`update reward_policy_test_private.binding set backend_pid=pg_backend_pid()where review_id=${reviewId}::uuid returning backend_pid<>${root.pid}as distinct_identity`
     :field==='start'?await owner.client`update reward_policy_test_private.binding set backend_started_at=(select backend_start from pg_stat_activity where pid=pg_backend_pid())where review_id=${reviewId}::uuid returning backend_started_at<>${root.started}::text::timestamptz as distinct_identity`
     :await owner.client`update reward_policy_test_private.binding set root_xid=pg_current_xact_id()where review_id=${reviewId}::uuid returning root_xid<>${root.xid}::text::xid8 as distinct_identity`;
    expect(Array.from(changed)).toEqual([{distinct_identity:true}]);signal.throwIfAborted();await refused(tx,()=>read(tx,reviewId,action));
   },restoreBinding);
  }
  signal.throwIfAborted();await controlledPolicyWait(poison).run(async()=>{
   await owner.client`revoke execute on function reward_policy_test.read_review(uuid,text)from ai_hr_app`;
   signal.throwIfAborted();await refused(tx,()=>read(tx,reviewId,action));
  },async()=>{await owner.client`grant execute on function reward_policy_test.read_review(uuid,text)to ai_hr_app`;await assertImage();});
  signal.throwIfAborted();await controlledPolicyWait(poison).run(async()=>{
   await owner.client`alter function reward_policy_test.read_review(uuid,text)cost 101`;
   signal.throwIfAborted();await refused(tx,()=>read(tx,reviewId,action),'55000');
  },async()=>{await owner.client`alter function reward_policy_test.read_review(uuid,text)cost 100`;await assertImage();});
  await owner.client.begin(async other=>{
   await other`savepoint owned_observer_wrong_login`;
   await controlledPolicyWait(poison).run(async()=>{
    let error:unknown;try{await other`select reward_policy_test.read_review(${reviewId}::uuid,${action}::text)`;}catch(caught){error=caught;}
    expect(error).toBeDefined();expect(pgSqlState(error)).toBe('42501');
   },async()=>{await other`rollback to savepoint owned_observer_wrong_login`;await other`release savepoint owned_observer_wrong_login`;});
  });
  signal.throwIfAborted();await assertImage();await privateDenied(tx,reviewId,action);await read(tx,reviewId,action);proved.add(action);
 }
 return{clear,close,assertImage,
  async observe(tx:Tx,ctx:SessionContext,reviewId:string,action:Action,signal:AbortSignal,foreign?:Readonly<{tenantId:string;userId:string}>){
   signal.throwIfAborted();await privateDenied(tx,reviewId,action);signal.throwIfAborted();
   const root=await bind(tx,ctx,reviewId,action,signal);signal.throwIfAborted();
   if(foreign&&!proved.has(action))await prove(tx,ctx,reviewId,action,root,foreign,signal);
   signal.throwIfAborted();const value=await read(tx,reviewId,action);
   signal.throwIfAborted();await privateDenied(tx,reviewId,action);signal.throwIfAborted();return value;
  },
 };
}
