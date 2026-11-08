/** Fixed private owner-controller proof. No Vitest, harness, app pool or provider import. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ISql,TransactionSql} from 'postgres';
import {z} from 'zod';
export const auditDefaultSignature='app._domain_event_next(uuid,boolean)';
const file='test/prototypes/rewards-audited-read.sql',bytes=readFileSync(file),sha=createHash('sha256').update(bytes).digest('hex');
assert.equal(sha,'cad7076c1263888257084dbf5b2eef77ebb6e360dbf08ae38e2029a00a58b654');
const source=bytes.toString('utf8'),start=source.indexOf('DO $predecessors$'),end=source.indexOf('END $predecessors$;');
assert(start>=0&&end>start&&source.split('DO $predecessors$').length===2&&source.split('END $predecessors$;').length===2);
const exactReadonlyPredecessors=source.slice(start,end+'END $predecessors$;'.length);
const record=z.record(z.string(),z.unknown());
export const auditNativeFunctionSchema=z.object({signature:z.string(),definition:z.string(),body:z.string(),details:record}).strict();
export type AuditNativeFunction=z.infer<typeof auditNativeFunctionSchema>;
const snapshotSchema=z.object({row:auditNativeFunctionSchema,args:z.string(),identityArgs:z.string(),result:z.string(),defaults:z.string().nullable(),language:z.string(),owner:z.string(),acl:z.array(record),dependencies:z.array(record),sharedDependencies:z.array(record),family:z.array(record),publicFacts:record}).strict();
export type AuditNativeSnapshot=z.infer<typeof snapshotSchema>;
export async function captureAuditDefault(sql:ISql):Promise<AuditNativeSnapshot>{
 const [raw]=await sql`select jsonb_build_object('signature','app._domain_event_next(uuid,boolean)','definition',pg_get_functiondef(p.oid),'body',p.prosrc,'details',to_jsonb(p))as "row",
  pg_get_function_arguments(p.oid)as args,pg_get_function_identity_arguments(p.oid)as "identityArgs",pg_get_function_result(p.oid)as result,pg_get_expr(p.proargdefaults,0)as defaults,
  l.lanname as language,r.rolname as owner,
  coalesce((select jsonb_agg(to_jsonb(a)order by a.grantor,a.grantee,a.privilege_type,a.is_grantable)from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a),'[]'::jsonb)as acl,
  coalesce((select jsonb_agg(to_jsonb(d)order by d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype)from pg_depend d where(d.classid='pg_proc'::regclass and d.objid=p.oid)or(d.refclassid='pg_proc'::regclass and d.refobjid=p.oid)),'[]'::jsonb)as dependencies,
  coalesce((select jsonb_agg(to_jsonb(d)order by d.dbid,d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.deptype)from pg_shdepend d where d.dbid=(select oid from pg_database where datname=current_database())and d.classid='pg_proc'::regclass and d.objid=p.oid),'[]'::jsonb)as "sharedDependencies",
  (select jsonb_agg(to_jsonb(f)order by f.oid)from pg_proc f where f.pronamespace=p.pronamespace and f.proname=p.proname)as family,
  jsonb_build_object('events',(select md5(coalesce(jsonb_agg(to_jsonb(e)order by e.id),'[]'::jsonb)::text)from public.domain_event e),
   'employment',(select md5(coalesce(jsonb_agg(to_jsonb(e)order by e.id),'[]'::jsonb)::text)from public.employment e),
   'compensation',(select md5(coalesce(jsonb_agg(to_jsonb(c)order by c.id),'[]'::jsonb)::text)from public.compensation c),
   'units',(select md5(coalesce(jsonb_agg(to_jsonb(u)order by u.id),'[]'::jsonb)::text)from public.reward_unit u),
   'libraries',(select md5(coalesce(jsonb_agg(to_jsonb(v)order by v.id),'[]'::jsonb)::text)from public.reward_library_version v),
   'pat',(select md5(coalesce(jsonb_agg(to_jsonb(v)order by v.id),'[]'::jsonb)::text)from public.reward_pat_version v))as "publicFacts"
 from pg_proc p join pg_language l on l.oid=p.prolang join pg_roles r on r.oid=p.proowner where p.oid='app._domain_event_next(uuid,boolean)'::regprocedure`;
 return snapshotSchema.parse(raw);
}
/** Existing native source predicates, exact bytes, plus a fixed-purpose closed
 * family/state fence. This never creates roles, grants, objects or truth flags. */
export async function admitAuditCanonicalization(sql:ISql,database:string,login:string){
 const [identity]=await sql`select current_database()as database,inet_server_addr()='127.0.0.1'::inet as loopback,current_user::text as role,session_user::text as login,
  current_user=session_user and current_user::regrole::oid=(select relowner from pg_class where oid='public.domain_event'::regclass)as native,
  current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock,current_setting('transaction_read_only')as readonly`;
 assert.deepEqual(identity,{database,loopback:true,role:login,login,native:true,statement:'20s',lock:'300ms',readonly:'off'});
 await sql.unsafe(exactReadonlyPredecessors);
 await sql`do $fixed_default_owner$ begin
  if(select count(*)from pg_proc where pronamespace='app'::regnamespace and proname='_domain_event_next')<>1
   or exists(select 1 from pg_namespace where nspname in('reward_audit_read','reward_audit_projection','reward_audit_private','reward_audit_policy_private'))
   or exists(select 1 from pg_roles where rolname in('ai_hr_reward_audit_read','ai_hr_reward_audit_projector'))
   or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='app._domain_event_next(uuid,boolean)'::regprocedure and(a.grantor<>p.proowner or a.grantee<>p.proowner or a.privilege_type<>'EXECUTE' or a.is_grantable))
  then raise exception 'Exact uninstalled native default owner required' using errcode='55000';end if;
 end $fixed_default_owner$`;
 const raw=await captureAuditDefault(sql);
 assert.equal(raw.defaults,'false');assert.equal(raw.args,'p_tenant uuid, p_try boolean DEFAULT false');assert.equal(raw.identityArgs,'p_tenant uuid, p_try boolean');assert.equal(raw.result,'jsonb');assert.equal(raw.language,'plpgsql');assert.equal(raw.owner,login);assert.equal(raw.family.length,1);
 return raw;
}
/** Difference classification retains COMPLETE rows. It never rewrites or omits
 * a default tree, OID, location or unknown field from an acceptance comparison. */
export function assertAuditCanonicalTransition(original:AuditNativeSnapshot,canonical:AuditNativeSnapshot){
 assert.equal(original.row.signature,auditDefaultSignature);assert.equal(canonical.row.signature,auditDefaultSignature);
 assert.deepEqual(original.family,[original.row.details]);assert.deepEqual(canonical.family,[canonical.row.details]);
 assert.equal(canonical.row.definition,original.row.definition);assert.equal(canonical.row.body,original.row.body);
 const keys=new Set([...Object.keys(original.row.details),...Object.keys(canonical.row.details)]),changed=[...keys].filter(key=>!isDeepStrictEqual(original.row.details[key],canonical.row.details[key]));
 assert(changed.every(key=>key==='proargdefaults'),'Unexpected native canonical postimage field');
 const expected={...original,row:{...original.row,details:canonical.row.details},family:[canonical.row.details]};
 assert.deepEqual(canonical,expected);assert.equal(canonical.defaults,'false');
}
/** Same actual OID, declaration bytes and catalog parser. The expected image is
 * usable only AFTER rollback has proven the complete original/dependency state. */
export async function referenceAuditCanonicalization(tx:TransactionSql,original:AuditNativeSnapshot){
 await tx`savepoint native_default_reference`;
 let result:AuditNativeSnapshot|undefined,primary:{error:unknown}|undefined,restore:{error:unknown}|undefined;
 try{await tx.unsafe(original.row.definition);result=await captureAuditDefault(tx);assertAuditCanonicalTransition(original,result);}
 catch(error){primary={error};}
 try{await tx`rollback to savepoint native_default_reference`;await tx`release savepoint native_default_reference`;assert.deepEqual(await captureAuditDefault(tx),original);}
 catch(error){restore={error};}
 if(primary&&restore)throw new AggregateError([primary.error,restore.error],'Native reference and rollback custody both failed',{cause:primary.error});if(primary)throw primary.error;if(restore)throw restore.error;
 assert(result);return result;
}
export async function applyExactAuditCanonicalization(tx:TransactionSql,original:AuditNativeSnapshot,canonical:AuditNativeSnapshot){
 assert.deepEqual(await captureAuditDefault(tx),original);assertAuditCanonicalTransition(original,canonical);
 await tx.unsafe(original.row.definition);assert.deepEqual(await captureAuditDefault(tx),canonical);
}
