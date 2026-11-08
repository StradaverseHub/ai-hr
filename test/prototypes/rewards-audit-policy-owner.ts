/** Hosted disposable owner composition only; never imported by a reader/process. */
import {readFileSync} from 'node:fs';
import postgres,{type ISql,type TransactionSql} from 'postgres';
import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import {z} from 'zod';
import {establishAuditCanonicalCustody} from './rewards-audit-default-custody';
import type {AuditDefaultControl} from './rewards-audit-default-controller-process';
import {controlledPolicyWait} from './rewards-audit-policy-controlled-wait';
import {rewardsAuditCanonicalTruthContract,rewardsAuditPolicyReplacementBodies} from './rewards-audit-policy-contract';
import {createRewardsAuditFixtureOwner,type RewardsAuditOwnerDependencies} from './rewards-audited-read-owner-factory';
const canonicalPath='core/audit-chain-arming.ts',source=readFileSync('test/prototypes/rewards-audited-read.sql','utf8');
if(createHash('sha256').update(source).digest('hex')!=='cad7076c1263888257084dbf5b2eef77ebb6e360dbf08ae38e2029a00a58b654')throw Error('Exact qualified315 prototype SQL required');
const closure=z.object({kind:z.literal('UNINSTALLED_REWARDS_POLICY_NATIVE_PRE_CLOSURE'),base:z.literal('315467b94d49011ba367a54c46a4eaa2e90b8a8a'),functions:z.array(z.object({signature:z.string(),source:z.string(),bodyMd5:z.string(),bodySha256:z.string(),body:z.string(),header:z.string(),language:z.literal('plpgsql'),volatility:z.literal('v'),securityDefiner:z.literal(true)}).strict()).length(11)}).strict().parse(JSON.parse(readFileSync('test/prototypes/rewards-audit-policy-predecessors.json','utf8')));
const rowSchema=z.object({signature:z.string(),definition:z.string(),body:z.string(),details:z.record(z.string(),z.unknown())}).strict();
type FunctionRow=z.infer<typeof rowSchema>;
function one(text:string,from:string,to:string){if(text.split(from).length!==2)throw Error('Exact single native replacement boundary required: '+from.slice(0,90));return text.replace(from,to);}
async function definition(owner:RewardsAuditOwnerDependencies['owner'],signature:string):Promise<FunctionRow>{const [row]=await owner.client`select ${signature}::text as signature,pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)as details from pg_proc p where p.oid=${signature}::regprocedure`;return rowSchema.parse(row);}
export async function rewardsAuditPolicyFixtureOwner(dependencies:RewardsAuditOwnerDependencies,poison:(error:Error)=>void,control:AuditDefaultControl&Readonly<{evidenceDirectory:string}>){
 const {owner}=dependencies;
 // The existing owner builds the exact canonical DB and proves its original
 // guards/ACL/RLS. This extension may never bypass its special-reader guard.
 await establishAuditCanonicalCustody(dependencies,control,poison);
 const base=await createRewardsAuditFixtureOwner(dependencies),originals:FunctionRow[]=[],changed:FunctionRow[]=[];
 const sockets=new Set<ReturnType<typeof postgres>>();
 async function finishSockets(){const owned=Array.from(sockets);sockets.clear();await Promise.all(owned.map(socket=>socket.end({timeout:0})));await base.finishCase();}
 type FunctionImage={row:FunctionRow;dependencies:unknown;sharedDependencies:unknown};
 const imageSchema=z.object({row:rowSchema,dependencies:z.array(z.record(z.string(),z.unknown())),sharedDependencies:z.array(z.record(z.string(),z.unknown()))}).strict();
 const replacementOwners=new Set([...rewardsAuditPolicyReplacementBodies().keys(),'reward_audit_policy_private.probe_checkpoint(uuid)']);
 async function image(tx:ISql,signature:string):Promise<FunctionImage>{
  if(!replacementOwners.has(signature))throw Error('Unowned native postimage target refused');
  const [raw]=await tx`select jsonb_build_object('signature',${signature}::text,'definition',pg_get_functiondef(p.oid),'body',p.prosrc,'details',to_jsonb(p))as "row",
   coalesce((select jsonb_agg(to_jsonb(d)order by d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype)from pg_depend d where(d.classid='pg_proc'::regclass and d.objid=p.oid)or(d.refclassid='pg_proc'::regclass and d.refobjid=p.oid)),'[]'::jsonb)as dependencies,
   coalesce((select jsonb_agg(to_jsonb(d)order by d.dbid,d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.deptype)from pg_shdepend d where d.dbid=(select oid from pg_database where datname=current_database())and d.classid='pg_proc'::regclass and d.objid=p.oid),'[]'::jsonb)as "sharedDependencies"
   from pg_proc p where p.oid=${signature}::regprocedure`;
  return imageSchema.parse(raw);
 }
 const originalImages=new Map<string,FunctionImage>();
 async function reference(tx:TransactionSql,prior:FunctionImage,body:string){
  const declaration=one(prior.row.definition,prior.row.body,body);await tx`savepoint owned_native_postimage`;
  let result:FunctionImage|undefined;
  await controlledPolicyWait(poison).run(async()=>{
   await tx.unsafe(declaration);result=await image(tx,prior.row.signature);
   // Canonicalized default baseline makes every complete field predictable.
   // Keep proargdefaults, ABI, ACL, support and both dependency ledgers exact.
   expect(result).toEqual({...prior,row:{...prior.row,definition:declaration,body,details:{...prior.row.details,prosrc:body}}});
  },async()=>{await tx`rollback to savepoint owned_native_postimage`;await tx`release savepoint owned_native_postimage`;expect(await image(tx,prior.row.signature)).toEqual(prior);});
  if(!result)throw Error('Rolled-back native replacement postimage absent');return result;
 }
 async function apply(tx:TransactionSql,prior:FunctionImage,next:FunctionImage){
  expect(await image(tx,prior.row.signature)).toEqual(prior);await tx.unsafe(next.row.definition);expect(await image(tx,prior.row.signature)).toEqual(next);
 }
 let probeIntent:{fixed:FunctionImage;next?:FunctionImage}|undefined;
 let installed=false,counterexampleIntent:{fixed:FunctionImage;next?:FunctionImage}|undefined;
 async function replaceNext(expected:FunctionImage,body:string,intent:{next?:FunctionImage}){
  const signature='app._domain_event_next(uuid,boolean)';expect(expected.row.signature).toBe(signature);
  return owner.client.begin(async tx=>{
   await tx`select reward_audit_policy_private.assert_profile()`;
   const next=await reference(tx,expected,body);intent.next=next; // native intent BEFORE possible COMMIT
   await apply(tx,expected,next);
   for(const schema of ['reward_audit_private','reward_audit_policy_private']){
    const query='update '+schema+'.function_contract set details=$1::text::jsonb where signature=$2::regprocedure and details=$3::text::jsonb returning signature';
    expect(await tx.unsafe(query,[JSON.stringify(next.row.details),signature,JSON.stringify(expected.row.details)])).toHaveLength(1);
   }
   await tx`select reward_audit_policy_private.assert_profile()`;return next;
  });
 }
 async function replaceProbeCheckpoint(expected:FunctionImage,body:string,intent:{next?:FunctionImage}){
  return owner.client.begin(async tx=>{
   await tx`select reward_audit_policy_private.assert_profile()`;
   const next=await reference(tx,expected,body);intent.next=next;await apply(tx,expected,next);
   expect(await tx`update reward_audit_policy_private.function_contract set details=${JSON.stringify(next.row.details)}::text::jsonb where signature=${expected.row.signature}::regprocedure and details=${JSON.stringify(expected.row.details)}::text::jsonb returning signature`).toHaveLength(1);
   await tx`select reward_audit_policy_private.assert_profile()`;return next;
  });
 }
 async function restoreIntent(intent:{fixed:FunctionImage;next?:FunctionImage},kind:'next'|'probe'){
  const current=await image(owner.client,intent.fixed.row.signature);
  if(current.row.body===intent.fixed.row.body){expect(current).toEqual(intent.fixed);return;}
  if(!intent.next)throw Error('Unproven native instrumentation postimage; restoration refused');expect(current).toEqual(intent.next);
  const restore={};if(kind==='next')await replaceNext(current,intent.fixed.row.body,restore);else await replaceProbeCheckpoint(current,intent.fixed.row.body,restore);
  expect(await image(owner.client,intent.fixed.row.signature)).toEqual(intent.fixed);
 }
 async function restoreProbeCheckpoint(){if(!probeIntent)return;await restoreIntent(probeIntent,'probe');probeIntent=undefined;}
 async function restoreCounterexample(){if(!counterexampleIntent)return;await restoreIntent(counterexampleIntent,'next');counterexampleIntent=undefined;}
 try{
  const bindings=rewardsAuditPolicyReplacementBodies();
  for(const expected of closure.functions){const actual=await definition(owner,expected.signature);expect(actual.body).toBe(expected.body);expect(createHash('md5').update(actual.body).digest('hex')).toBe(expected.bodyMd5);originals.push(actual);}
  for(const signature of bindings.keys())if(!originals.some(row=>row.signature===signature))originals.push(await definition(owner,signature));
  for(const signature of ['reward_audit_private.relation_metadata(oid)','reward_audit_private.assert_profile()','reward_audit_private.require_receipt()','reward_audit_private.immutable()'])originals.push(await definition(owner,signature));
  for(const expected of closure.functions){
   const actual=originals.find(row=>row.signature===expected.signature);if(!actual)throw Error('Canonical PRE closure absent');
   const args=expected.header.slice(expected.header.indexOf('(')+1,expected.header.indexOf(')')).split(',').map(arg=>arg.trim()).filter(Boolean),names=args.map(arg=>arg.split(/\s+/)[0]);
   const result=/RETURNS (\w+)/.exec(expected.header)?.[1];if(!result)throw Error('Explicit native result owner absent');
   expect(actual.details).toMatchObject({prosecdef:true,provolatile:'v',proisstrict:false,proleakproof:false,proparallel:'u',prokind:'f',procost:100,prorows:0,
    proconfig:['search_path=pg_catalog, public, pg_temp'],proargnames:names.length?names:null,pronargs:args.length,pronargdefaults:args.filter(arg=>/\bDEFAULT\b/.test(arg)).length,
    proallargtypes:null,proargmodes:null,prosqlbody:null,probin:null,protrftypes:null});
   const defaults=expected.signature==='app._domain_event_next(uuid,boolean)'?'false':expected.signature==='app._assistant_catalogue_native_phase(uuid,text,tid,uuid)'?'NULL::tid, NULL::uuid':null;
   expect((await owner.client`select l.lanname as language,pg_get_function_result(p.oid)as result,p.provariadic::int as variadic,p.prosupport::oid::int as support,pg_get_expr(p.proargdefaults,0)as defaults,
    p.proowner=(select relowner from pg_class where oid='public.domain_event'::regclass)as native_owner from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${expected.signature}::regprocedure`)[0]).toEqual({language:'plpgsql',result,variadic:0,support:0,defaults,native_owner:true});
   if(expected.signature!=='app.domain_event_chain_tg()'){
    const appAllowed=expected.signature==='app.assistant_bank_review_arm(uuid)';
    expect((await owner.client`select count(*)::int as n from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid=${expected.signature}::regprocedure
     and(a.privilege_type<>'EXECUTE'or a.is_grantable or a.grantor<>p.proowner or a.grantee<>p.proowner and(not ${appAllowed} or a.grantee<>'ai_hr_app'::regrole::oid))`)[0].n).toBe(0);
   }
  }
  await owner.client.begin(async tx=>{
   await tx`set local statement_timeout='20s'`;await tx`set local lock_timeout='300ms'`;
   await tx`select set_config('aihr.reward_policy_fixture.database',${base.database},true)`;
   await tx.unsafe(readFileSync('test/prototypes/rewards-audit-policy.sql','utf8'));
   const truth=rewardsAuditCanonicalTruthContract(),canonicalSource=createHash('sha256').update(readFileSync(canonicalPath)).digest('hex');
   for(const row of truth)await tx`insert into reward_audit_policy_private.truth values(${row.setting_code},${row.has_history},${row.env_armed},${row.armed},${row.refused_disarm},${row.reason})`;
   await tx`insert into reward_audit_policy_private.config values(true,current_database(),current_user::regrole::oid,1,${canonicalSource},false,${JSON.stringify(truth)}::text::jsonb,false)`;
   for(const [signature,body]of bindings){
    const old=originals.find(row=>row.signature===signature);if(!old)throw Error('Exact native replacement owner absent');
    const prior=await image(tx,signature);expect(prior.row).toEqual(old);originalImages.set(signature,prior);
    const next=await reference(tx,prior,body);await apply(tx,prior,next);changed.push(next.row);
    const sealed=await tx`update reward_audit_private.function_contract c set details=to_jsonb(p)from pg_proc p where p.oid=c.signature and p.oid=${signature}::regprocedure and c.details=${JSON.stringify(old.details)}::text::jsonb returning c.signature`;
    expect(sealed).toHaveLength(1);
   }
   await tx`insert into reward_audit_private.function_contract select p.oid,to_jsonb(p)from pg_proc p where p.oid='reward_audit_read.reconcile_receipt(uuid)'::regprocedure`;
   for(const original of originals)await tx`insert into reward_audit_policy_private.function_contract select p.oid,to_jsonb(p)from pg_proc p where p.oid=${original.signature}::regprocedure`;
   await tx`insert into reward_audit_policy_private.function_contract select p.oid,to_jsonb(p)from pg_proc p where p.pronamespace='reward_audit_policy_private'::regnamespace or p.oid='reward_audit_read.reconcile_receipt(uuid)'::regprocedure`;
   await tx`insert into reward_audit_policy_private.relation_contract select c.oid,reward_audit_private.relation_metadata(c.oid)from pg_class c where c.relnamespace='reward_audit_policy_private'::regnamespace or c.oid in('reward_audit_private.receipt'::regclass,'reward_audit_private.admission'::regclass)`;
   await tx`insert into reward_audit_policy_private.trigger_contract select t.oid,to_jsonb(t)from pg_trigger t where t.tgrelid in(select object_oid from reward_audit_policy_private.relation_contract)`;
   await tx`update reward_audit_policy_private.config set enabled=true`;await tx`select reward_audit_policy_private.assert_profile()`;
  });installed=true;
 }catch(error){await controlledPolicyWait(poison).run(async()=>{throw error;},()=>base.close());throw error;}
 return{
  ...base,
  connect(kind:'reader'|'projector'){const connection=postgres(kind==='reader'?base.readerUrl:base.projectorUrl,{max:1,connect_timeout:2,connection:{statement_timeout:20000,lock_timeout:300}});sockets.add(connection);return connection;},
  finishCase:finishSockets,
  /** Native synchronization only: never simulates a unique conflict or result. */
  async withProbeBarrier(tenant:string,work:(key:string)=>Promise<void>){
   const tenantId=z.guid().parse(tenant),signature='reward_audit_policy_private.probe_checkpoint(uuid)',fixed=await definition(owner,signature);
   expect(fixed.body).toBe('\nBEGIN RETURN;END\n');expect(fixed.details.prosecdef).toBe(false);
   expect((await owner.client`select count(*)::int as n from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid=${signature}::regprocedure and(a.grantee<>p.proowner or a.grantor<>p.proowner or a.is_grantable or a.privilege_type<>'EXECUTE')`)[0].n).toBe(0);
   const [row]=await owner.client`select hashtextextended(${'rewards-policy-probe:'+base.database+':'+tenantId},0)::text as key`;const key=z.string().regex(/^-?[0-9]{1,19}$/).parse(row.key);
   const body="\nBEGIN IF p_tenant='"+tenantId+"'::uuid THEN PERFORM pg_advisory_xact_lock('"+key+"'::bigint);END IF;END\n";
   const intent:{fixed:FunctionImage;next?:FunctionImage}={fixed:await image(owner.client,signature)};probeIntent=intent; // full native intent before COMMIT
   await controlledPolicyWait(poison).run(async()=>{await replaceProbeCheckpoint(intent.fixed,body,intent);await work(key);},restoreProbeCheckpoint);
  },
  /** Controlled unsafe proposal counterexample, never an installed/accepted variant. */
  async withFreshFloorCounterexample(work:()=>Promise<void>){
   const signature='app._domain_event_next(uuid,boolean)',fixed=changed.find(row=>row.signature===signature);if(!fixed)throw Error('Owned fixed audit frame absent');
   const fresh=one(fixed.body,'native_floor:=reward_audit_policy_private.floor_for_xact(p_tenant);','PERFORM reward_audit_policy_private.assert_floor_profile();native_floor:=reward_audit_policy_private.durable_floor(p_tenant);');
   const intent:{fixed:FunctionImage;next?:FunctionImage}={fixed:await image(owner.client,signature)};expect(intent.fixed.row).toEqual(fixed);counterexampleIntent=intent;
   await controlledPolicyWait(poison).run(async()=>{await replaceNext(intent.fixed,fresh,intent);await work();},restoreCounterexample);
  },
  /** Private owner fixture configuration, not installed startup provenance or an API. */
  async protectedFixtureFallback(value:boolean){await owner.client`select reward_audit_policy_private.assert_profile()`;await owner.client`update reward_audit_policy_private.config set fallback_armed=${value}`;},
  async reset(){if(counterexampleIntent||probeIntent){const error=Error('Unsettled native policy instrumentation; successor refused');poison(error);throw error;}await owner.client`select reward_audit_policy_private.assert_profile()`;await owner.client`truncate reward_audit_policy_private.observation,reward_audit_policy_private.floor_frame,reward_audit_policy_private.floor_marker`;await base.reset();await owner.client`update reward_audit_policy_private.config set fallback_armed=false`;},
  async close(){
   await finishSockets();
   if(installed){
    await restoreCounterexample();await restoreProbeCheckpoint();
    await owner.client.begin(async tx=>{
     await tx`set local statement_timeout='2s'`;await tx`set local lock_timeout='300ms'`;await tx`select reward_audit_policy_private.assert_profile()`;
     for(const current of changed){
      const old=originals.find(row=>row.signature===current.signature);if(!old)throw Error('Native restore preimage absent');
      const prior=originalImages.get(current.signature);if(!prior)throw Error('Complete native restore preimage absent');
      const actual=await image(tx,current.signature);expect(actual.row).toEqual(current);
      const restore=await reference(tx,actual,old.body);expect(restore).toEqual(prior);await apply(tx,actual,restore);
      expect(await tx`update reward_audit_private.function_contract c set details=${JSON.stringify(old.details)}::text::jsonb where c.signature=${old.signature}::regprocedure and c.details=${JSON.stringify(current.details)}::text::jsonb returning c.signature`).toHaveLength(1);
     }
     expect(await tx`delete from reward_audit_private.function_contract where signature='reward_audit_read.reconcile_receipt(uuid)'::regprocedure returning signature`).toHaveLength(1);
     await tx`drop function reward_audit_read.reconcile_receipt(uuid)`;
     await tx`drop schema reward_audit_policy_private cascade`;await tx`select reward_audit_private.assert_profile()`;
    });installed=false;
    for(const original of originals)expect((await definition(owner,original.signature)).details).toEqual(original.details);
   }
   await base.close();
  },
 };
}
export type RewardsAuditPolicyFixtureOwner=Awaited<ReturnType<typeof rewardsAuditPolicyFixtureOwner>>;
