/** Disposable hosted owner only. Never imported by the dedicated reader/projector. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {z} from 'zod';
import {expect} from 'vitest';
import {rewardsAuditOwnerConfiguration} from './rewards-audit-fixture-context';
import type {Sql} from 'postgres';
import {pgSqlState} from '../../lib/db-error';
const predecessorSchema=z.object({kind:z.literal('UNINSTALLED_REWARDS_NATIVE_CANONICAL_PREDECESSORS'),base:z.literal('06be9fc60097edb870f2c7d9f4d30887ba6fd6d9'),functions:z.array(z.object({signature:z.string(),owner:z.enum(['native','ai_hr_reward_setup_reader']),source:z.string(),bodyMd5:z.string().regex(/^[a-f0-9]{32}$/),language:z.enum(['sql','plpgsql']),securityDefiner:z.literal(true),volatility:z.enum(['s','v']),config:z.string()}).strict()).length(9)}).strict();
const predecessors=predecessorSchema.parse(JSON.parse(readFileSync('test/prototypes/rewards-audited-read-predecessors.json','utf8')));
const nativeResults:Readonly<Record<string,{result:string;names:string[]|null}>>={
 'app.reward_setup_allowed(uuid,text)':{result:'boolean',names:['wanted_company','wanted_operation']},
 'app.reward_library_used_by(uuid)':{result:'TABLE(plan text, company text, year integer)',names:['wanted_version','plan','company','year']},
 'app.reward_library_locked(uuid)':{result:'boolean',names:['wanted_version']},
 'app.reward_setup_companies(integer)':{result:'TABLE(id uuid, name text, "parentId" uuid, "parentName" text)',names:['wanted_year','id','name','parentId','parentName']},
 'app.reward_private_pat_history(uuid,integer)':{result:'SETOF jsonb',names:['wanted_company','wanted_year']},
 'app.reward_company_structure(uuid,date)':{result:'jsonb',names:['wanted_company','wanted_date']},
 'app.principal_snapshot_current()':{result:'boolean',names:null},
 'app.domain_event_chain_tg()':{result:'trigger',names:null},
 'app._domain_event_next(uuid,boolean)':{result:'jsonb',names:['p_tenant','p_try']},
};
type FunctionRecord={signature:string;details:unknown;acl:unknown};
export type RewardsAuditOwnerDependencies={owner:{client:Sql};migrateTestDb:()=>Promise<void>;closeAll:()=>Promise<void>};
export async function createRewardsAuditFixtureOwner({owner,migrateTestDb,closeAll}:RewardsAuditOwnerDependencies){
 const {database,namespace,pool,migration}=rewardsAuditOwnerConfiguration();
 await migrateTestDb();expect((await owner.client`select current_database()as database,inet_server_addr()='127.0.0.1'::inet as loopback`)[0]).toEqual({database,loopback:true});
 const roles=['ai_hr_reward_audit_read','ai_hr_reward_audit_projector']as const;
 expect(await owner.client`select 1 from pg_roles where rolname=any(${[...roles]}::text[])`).toHaveLength(0);
 const credentials=roles.map(role=>{const url=new URL(migration);url.username=role;url.password=randomUUID();return url;});
 const created:string[]=[],sockets=new Set<ReturnType<typeof postgres>>();let installed=false,originals:FunctionRecord[]=[],policies:{oid:number;details:unknown}[]=[];
 try{
  // UUID passwords and the two fixed reviewed identifiers only. The roles have
  // no membership, owner/app credentials, admin flags or app-schema USAGE.
  for(const [i,role]of roles.entries()){await owner.client.unsafe('CREATE ROLE '+role+" LOGIN PASSWORD '"+credentials[i].password+"' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION");created.push(role);}
  const source=readFileSync('test/prototypes/rewards-audited-read.sql','utf8'),[guardBefore]=await owner.client`select to_jsonb(p)as details from pg_proc p where p.oid='app.domain_event_chain_tg()'::regprocedure`,unexpected=Error('Hostile predecessor was unexpectedly accepted');
  // Run the ACTUAL native installer guard, not a JavaScript mirror. Even if it
  // regresses to acceptance, this controlled transaction always rolls back.
  const refused=await owner.client.begin(async tx=>{
   await tx`select set_config('aihr.reward_audit_fixture.database',${database},true),set_config('aihr.reward_audit_fixture.namespace',${namespace},true),set_config('aihr.reward_audit_fixture.pool_id',${pool},true)`;
   await tx`alter function app.domain_event_chain_tg()cost 101`;await tx.unsafe(source);throw unexpected;
  }).then(()=>null,(error:unknown)=>error);
  expect(pgSqlState(refused)).toBe('55000');expect(refused instanceof Error?refused.message:'').toContain('app.domain_event_chain_tg()');
  expect((await owner.client`select to_jsonb(p)as details from pg_proc p where p.oid='app.domain_event_chain_tg()'::regprocedure`)[0]).toEqual(guardBefore);
  expect((await owner.client`select to_regnamespace('reward_audit_read')as reader,to_regnamespace('reward_audit_projection')as projector,to_regnamespace('reward_audit_private')as private`)[0]).toEqual({reader:null,projector:null,private:null});
  await owner.client.begin(async tx=>{
   const [native]=await tx`select relowner::regrole::text as owner from pg_class where oid='public.domain_event'::regclass`;
   expect((await tx`select t.tgfoid::regprocedure::text as function,t.tgtype,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred from pg_trigger t where t.tgrelid='public.domain_event'::regclass and t.tgname='domain_event_chain_tg'`)[0]).toEqual({function:'app.domain_event_chain_tg()',tgtype:7,tgenabled:'O',tgisinternal:false,tgdeferrable:false,tginitdeferred:false});
   for(const expected of predecessors.functions){
    const result=nativeResults[expected.signature];if(!result)throw Error('Unknown pinned native predecessor');
    const [actual]=await tx`select md5(p.prosrc)as body,p.proowner::regrole::text as owner,l.lanname as language,p.prosecdef,p.provolatile,p.proconfig,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,
     pg_get_function_result(p.oid)as result,p.proargnames as names,p.procost as cost,p.prorows as rows,p.provariadic::int as variadic,p.prosupport::oid::int as support,p.probin,p.protrftypes,pg_get_expr(p.proargdefaults,0)as defaults,to_jsonb(p)as details
     from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${expected.signature}::regprocedure`;
    expect(actual).toMatchObject({body:expected.bodyMd5,owner:expected.owner==='native'?native.owner:expected.owner,language:expected.language,prosecdef:true,provolatile:expected.volatility,proconfig:[expected.config],proisstrict:false,proleakproof:false,proparallel:'u',prokind:'f',...result,cost:100,rows:result.result.startsWith('TABLE(')||result.result.startsWith('SETOF ')?1000:0,variadic:0,support:0,probin:null,protrftypes:null,defaults:expected.signature==='app._domain_event_next(uuid,boolean)'?'false':null});
    if(expected.owner!=='native')expect((await tx`select count(*)::int as n from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid=${expected.signature}::regprocedure and(a.grantee=0 or a.is_grantable)`)[0].n).toBe(0);
    const [acl]=await tx`select coalesce(jsonb_agg(jsonb_build_object('grantor',a.grantor,'grantee',a.grantee,'privilege',a.privilege_type,'grantable',a.is_grantable)order by a.grantor,a.grantee,a.privilege_type),'[]'::jsonb)as value from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid=${expected.signature}::regprocedure`;
    originals.push({signature:expected.signature,details:actual.details,acl:acl.value});
   }
   const [context]=await tx`select 'app.current_tenant_id()'as signature,to_jsonb(p)as details from pg_proc p where p.oid='app.current_tenant_id()'::regprocedure`;
   expect((await tx`select md5(p.prosrc)as body,p.proowner::regrole::text as owner,p.prosecdef,p.provolatile,p.proconfig from pg_proc p where p.oid='app.current_tenant_id()'::regprocedure`)[0]).toEqual({body:'b69de56599d1d372c0a775eccd111aef',owner:native.owner,prosecdef:false,provolatile:'s',proconfig:null});
   const [contextAcl]=await tx`select coalesce(jsonb_agg(jsonb_build_object('grantor',a.grantor,'grantee',a.grantee,'privilege',a.privilege_type,'grantable',a.is_grantable)order by a.grantor,a.grantee,a.privilege_type),'[]'::jsonb)as value from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='app.current_tenant_id()'::regprocedure`;originals.push({signature:context.signature,details:context.details,acl:contextAcl.value});
   for(const signature of ['app.current_user_id()','app.domain_event_hash(text,uuid,bigint,text,uuid,text,text,uuid,uuid,jsonb)']){
    const [record]=await tx`select to_jsonb(p)as details,coalesce((select jsonb_agg(jsonb_build_object('grantor',a.grantor,'grantee',a.grantee,'privilege',a.privilege_type,'grantable',a.is_grantable)order by a.grantor,a.grantee,a.privilege_type)from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a),'[]'::jsonb)as acl from pg_proc p where p.oid=${signature}::regprocedure`;originals.push({signature,details:record.details,acl:record.acl});
   }
   await tx`select set_config('aihr.reward_audit_fixture.database',${database},true),set_config('aihr.reward_audit_fixture.namespace',${namespace},true),set_config('aihr.reward_audit_fixture.pool_id',${pool},true)`;
   await tx.unsafe(source);
   // Native RLS needs only the two additional predicate grants. All other
   // predecessor metadata stays exact; unrelated grants are not rewritten.
   for(const original of originals){
    const [actual]=await tx`select to_jsonb(p)as details from pg_proc p where p.oid=${original.signature}::regprocedure`;
    const prior=z.record(z.string(),z.unknown()).parse(original.details),current=z.record(z.string(),z.unknown()).parse(actual.details);
    const {proacl:beforeAcl,...before}=prior,{proacl:afterAcl,...after}=current;expect(after).toEqual(before);
    if(!['app.reward_setup_allowed(uuid,text)','app.current_tenant_id()'].includes(original.signature))expect(afterAcl).toEqual(beforeAcl);
    const [acl]=await tx`select coalesce(jsonb_agg(jsonb_build_object('grantor',a.grantor,'grantee',a.grantee,'privilege',a.privilege_type,'grantable',a.is_grantable)order by a.grantor,a.grantee,a.privilege_type)filter(where a.grantee<>'ai_hr_reward_audit_read'::regrole::oid),'[]'::jsonb)as retained,
     coalesce(bool_and(a.privilege_type='EXECUTE'and not a.is_grantable and a.grantor=p.proowner)filter(where a.grantee='ai_hr_reward_audit_read'::regrole::oid),true)as narrow
     from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid=${original.signature}::regprocedure`;
    expect(acl.retained).toEqual(original.acl);expect(acl.narrow).toBe(true);
    await tx`insert into reward_audit_private.function_contract(signature,details)select p.oid,to_jsonb(p)from pg_proc p where p.oid=${original.signature}::regprocedure`;
   }
   policies=Array.from(await tx`select p.oid,to_jsonb(p)as details from pg_policy p where p.polname in('reward_audit_library_purpose','reward_audit_library_version_purpose')`);
   expect(policies).toHaveLength(2);
   await tx`update reward_audit_private.authority set enabled=true`;
   await tx`select reward_audit_private.assert_profile()`;
  });installed=true;
 }catch(error){
  for(const role of created.reverse()){await owner.client.unsafe('DROP OWNED BY '+role);await owner.client.unsafe('DROP ROLE '+role);}throw error;
 }
 return{
  database,
  readerUrl:credentials[0].toString(),projectorUrl:credentials[1].toString(),
  connect(kind:'reader'|'projector'){
   const connection=postgres(credentials[kind==='reader'?0:1].toString(),{max:1,connection:{statement_timeout:20000,lock_timeout:300}});sockets.add(connection);return connection;
  },
  async finishCase(){const owned=Array.from(sockets);sockets.clear();await Promise.all(owned.map(socket=>socket.end({timeout:0})));},
  async reset(){await owner.client`select reward_audit_private.assert_profile()`;await owner.client`truncate reward_audit_private.admission,reward_audit_private.receipt,reward_audit_private.projection`;},
  async close(){
   const owned=Array.from(sockets);sockets.clear();await Promise.all(owned.map(socket=>socket.end({timeout:0})));
   try{
    if(installed){
     // Refuse cleanup of uncertain/drifted objects. Every hostile test restores
     // its change first; a foreign object is not disposable fixture ownership.
     await owner.client`select reward_audit_private.assert_profile()`;
     for(const policy of policies)expect((await owner.client`select to_jsonb(p)as details from pg_policy p where oid=${policy.oid}::oid`)[0].details).toEqual(policy.details);
     await owner.client`drop policy reward_audit_library_version_purpose on public.reward_library_version`;await owner.client`drop policy reward_audit_library_purpose on public.reward_library`;
     await owner.client`drop schema reward_audit_read cascade`;await owner.client`drop schema reward_audit_projection cascade`;await owner.client`drop schema reward_audit_private cascade`;installed=false;
    }
    for(const role of created.reverse()){await owner.client.unsafe('DROP OWNED BY '+role);await owner.client.unsafe('DROP ROLE '+role);}
    for(const original of originals)expect((await owner.client`select to_jsonb(p)as details from pg_proc p where p.oid=${original.signature}::regprocedure`)[0].details).toEqual(original.details);
   }finally{await closeAll();}
  },
 };
}
export type RewardsAuditFixtureOwner=Awaited<ReturnType<typeof createRewardsAuditFixtureOwner>>;
