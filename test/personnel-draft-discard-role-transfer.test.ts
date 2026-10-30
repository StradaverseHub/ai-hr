/** Hosted development fixture; no installation authority.
 * This proves restricted-LOGIN preflight/ownership transfer only. Minimal function bodies and RLS
 * fixtures are not native deletion/custody proof. No migration role provisioning occurs in this test. */
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {describe,expect,it} from 'vitest';
import {
 assertDisposableDraftDiscardFixture,assertDraftDiscardRoleCatalog,readDraftDiscardRoleCatalog,
 DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT,isDraftDiscardFixtureDatabasePath,type DraftDiscardCatalogSql,type RoleCatalog,
} from './helpers/personnel-draft-discard-ci-role-fixture';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function actualMigrationBlocks(){
 const file='db/migrations/0752_assistant_employee_draft_discard_custody.sql';
 const path=join(process.cwd(),file);expect(lstatSync(path).isFile()).toBe(true);
 const journalText=readFileSync('db/migrations/meta/_journal.json','utf8');
 const journal=JSON.parse(journalText) as {entries:{idx:number;when:number;tag:string}[]};
 const tag='0752_assistant_employee_draft_discard_custody';
 expect(journal.entries.filter(entry=>entry.tag===tag)).toHaveLength(1);
 expect(journal.entries.filter(entry=>entry.idx===731)).toEqual([expect.objectContaining({idx:731,when:1793330000089,tag})]);
 const source=readFileSync(path,'utf8');
 const block=(tag:string)=>{
  const matches=[...source.matchAll(new RegExp('^DO \\$'+tag+'\\$[\\s\\S]*?^END \\$'+tag+'\\$;','gm'))];
  expect(matches,`Expected one actual ${tag} DO block in the assigned source`).toHaveLength(1);
  return matches[0][0];
 };
 const preflight=block('preflight'),transfer=block('transfer');
 expect(transfer).toContain('ALTER FUNCTION app._draft_discard_source_snapshot(uuid,uuid) OWNER TO ai_hr_draft_discard_port');
 expect(transfer).toContain('ALTER FUNCTION app.native_employee_draft_discard_delete(uuid) OWNER TO ai_hr_draft_discard_port');
 return{file,journalIndex:731,journalWhen:1793330000089,journalTag:tag,journalHash:hash(journalText),sourceHash:hash(source),preflight,transfer,preflightHash:hash(preflight),transferHash:hash(transfer)};
}
function connection(adminUrl:string,database:string,user:string){
 const url=new URL(adminUrl);url.pathname='/'+database;url.username=user;
 return postgres(url.toString(),{max:1,onnotice:()=>{},connect_timeout:5});
}
async function sqlstate(work:Promise<unknown>,expected:string){
 try{await work;throw Error('Expected PostgreSQL permission refusal.');}
 catch(error){expect((error as {code?:unknown}).code).toBe(expected);}
}
async function loginState(sql:DraftDiscardCatalogSql){
 const [row]=await sql.unsafe<{session:string;current:string;priorRole:string;super:boolean;createDb:boolean;createRole:boolean;bypassRls:boolean;inheritsChild:boolean;setsChild:boolean}[]>(`
  select session_user::text as session,current_user::text as current,current_setting('role') as "priorRole",
   r.rolsuper as super,r.rolcreatedb as "createDb",r.rolcreaterole as "createRole",r.rolbypassrls as "bypassRls",
   pg_has_role(current_user,'ai_hr_draft_discard_port','USAGE') as "inheritsChild",
   pg_has_role(current_user,'ai_hr_draft_discard_port','SET') as "setsChild"
  from pg_roles r where r.rolname=current_user`);
 return row;
}

async function ownershipSnapshot(sql:DraftDiscardCatalogSql){
 const schema=await sql.unsafe<{owner:string;acl:string[]|null;childCreate:boolean;appCreate:boolean}[]>(`
  select pg_get_userbyid(n.nspowner)::text as owner,n.nspacl::text[] as acl,
   has_schema_privilege('ai_hr_draft_discard_port',n.oid,'CREATE') as "childCreate",
   has_schema_privilege('ai_hr_app',n.oid,'CREATE') as "appCreate"
  from pg_namespace n where n.nspname='app'`);
 const functions=await sql.unsafe<{identity:string;owner:string;acl:string[]|null}[]>(`
  select p.oid::regprocedure::text as identity,pg_get_userbyid(p.proowner)::text as owner,p.proacl::text[] as acl
  from pg_proc p where p.oid in('app._draft_discard_source_snapshot(uuid,uuid)'::regprocedure,
   'app.native_employee_draft_discard_delete(uuid)'::regprocedure) order by p.oid::regprocedure::text`);
 return{login:await loginState(sql),schema:Array.from(schema),functions:Array.from(functions)};
}
/** Catalog-only negatives. These objects never execute ALTER ROLE/GRANT, so sibling workers' shared
 * cluster principals are unaffected. Extra incident edges also reject direct/transitive alternate paths. */
function exactRoleCatalog():RoleCatalog{
 const roles=['ai_hr_app','ai_hr_owner','ai_hr_draft_discard_port'].map((name,index)=>({
  oid:100+index,name,login:name!=='ai_hr_draft_discard_port',inherit:true,super:false,createDb:false,
  createRole:false,replication:false,bypassRls:false,connectionLimit:-1,validUntil:null,
 }));
 return{roles,edges:[
  {role:'ai_hr_app',member:'ai_hr_draft_discard_port',grantor:'postgres',inherit:true,set:false,admin:false},
  {role:'ai_hr_draft_discard_port',member:'ai_hr_owner',grantor:'postgres',inherit:false,set:true,admin:false},
 ]};
}
describe('pure disposable role fixture refusal before any role write',()=>{
 it('accepts only the exact compatible graph and permits genuinely absent new fixture roles',()=>{
  expect(()=>assertDraftDiscardRoleCatalog(exactRoleCatalog())).not.toThrow();
  const fresh=exactRoleCatalog();fresh.roles=fresh.roles.filter(role=>role.name==='ai_hr_app');fresh.edges=[];
  expect(()=>assertDraftDiscardRoleCatalog(fresh,true)).not.toThrow();
  expect(()=>assertDraftDiscardRoleCatalog(fresh)).toThrow();
 });
 for(const name of ['ai_hr_app','ai_hr_owner','ai_hr_draft_discard_port']){
  for(const attribute of ['super','createDb','createRole','replication','bypassRls'] as const)
   it(`refuses existing ${name} with unsafe ${attribute} without repairing its attributes`,()=>{
    const catalog=exactRoleCatalog();catalog.roles.find(role=>role.name===name)![attribute]=true;
    const before=structuredClone(catalog);expect(()=>assertDraftDiscardRoleCatalog(catalog,true)).toThrow();expect(catalog).toEqual(before);
   });
  it(`refuses unexpected LOGIN/INHERIT/connection/expiry attributes for ${name}`,()=>{
   for(const mutation of ['login','inherit','connectionLimit','validUntil']){
    const catalog=exactRoleCatalog(),role=catalog.roles.find(role=>role.name===name)!;
    if(mutation==='login')role.login=!role.login;if(mutation==='inherit')role.inherit=false;
    if(mutation==='connectionLimit')role.connectionLimit=1;if(mutation==='validUntil')role.validUntil='2000-01-01 00:00:00+00';
    expect(()=>assertDraftDiscardRoleCatalog(catalog,true),mutation).toThrow();
   }
  });
 }
 const mutations:{name:string;mutate:(catalog:RoleCatalog)=>void}[]=[
  {name:'app can directly SET/inherit child',mutate:c=>{c.edges.push({role:'ai_hr_draft_discard_port',member:'ai_hr_app',grantor:'postgres',inherit:true,set:true,admin:false});}},
  {name:'app reaches child through a bridge',mutate:c=>{c.edges.push({role:'bridge',member:'ai_hr_app',grantor:'postgres',inherit:true,set:true,admin:false},{role:'ai_hr_draft_discard_port',member:'bridge',grantor:'postgres',inherit:true,set:true,admin:false});}},
  {name:'child reaches owner through a bridge',mutate:c=>{c.edges.push({role:'bridge',member:'ai_hr_draft_discard_port',grantor:'postgres',inherit:true,set:true,admin:false},{role:'ai_hr_owner',member:'bridge',grantor:'postgres',inherit:true,set:true,admin:false});}},
  {name:'child directly reaches the ledger owner',mutate:c=>{c.edges.push({role:'ai_hr_owner',member:'ai_hr_draft_discard_port',grantor:'postgres',inherit:true,set:true,admin:false});}},
  {name:'owner inherits child instead of SET-only',mutate:c=>{c.edges[1].inherit=true;}},
  {name:'owner cannot SET child',mutate:c=>{c.edges[1].set=false;}},
  {name:'child can SET app',mutate:c=>{c.edges[0].set=true;}},
  {name:'child cannot inherit app',mutate:c=>{c.edges[0].inherit=false;}},
  {name:'child has app ADMIN option',mutate:c=>{c.edges[0].admin=true;}},
  {name:'owner has child ADMIN option',mutate:c=>{c.edges[1].admin=true;}},
  {name:'an unrelated role reaches the owner',mutate:c=>{c.edges.push({role:'ai_hr_owner',member:'outsider',grantor:'postgres',inherit:false,set:true,admin:false});}},
  {name:'a required edge is absent',mutate:c=>{c.edges.pop();}},
  {name:'a duplicate alternate grantor edge exists',mutate:c=>{c.edges.push({...c.edges[0],grantor:'outsider'});}},
 ];
 it.each(mutations)('refuses $name without repairing the existing graph',({mutate})=>{
  const catalog=exactRoleCatalog();mutate(catalog);const before=structuredClone(catalog);
  expect(()=>assertDraftDiscardRoleCatalog(catalog,true)).toThrow();expect(catalog).toEqual(before);
 });
});

// Pure names only: canonical test/db-names.ts uses WORKER_BASE + namespaceSuffix + poolId.
it('accepts the exact canonical aifocus names and refuses the previously invented worker ordering',()=>{
 for(const path of ['/ai_hr_test','/ai_hr_test_tpl_aifocus','/ai_hr_test_w_aifocus1','/ai_hr_test_w_aifocus12'])
  expect(isDraftDiscardFixtureDatabasePath(path),path).toBe(true);
 for(const path of ['/ai_hr_test_w1_aifocus','/ai_hr_test_w_aifocus0','/ai_hr_test_w_aifocus01','/ai_hr_test_w_aifocus','/ai_hr_test_tpl','/ai_hr_test_w_other1','/postgres','/ai_hr_dev'])
  expect(isDraftDiscardFixtureDatabasePath(path),path).toBe(false);
});

it('runs the actual domain preflight and ownership transfers as a restricted authenticated owner, never postgres SET ROLE',async()=>{
 const migrationUrl=process.env.TEST_MIGRATION_DATABASE_URL;
 if(!migrationUrl)throw Error('Missing disposable migration connection.');
 const parsed=new URL(migrationUrl);parsed.pathname='/postgres';const adminUrl=parsed.toString();
 assertDisposableDraftDiscardFixture(adminUrl);
 const blocks=actualMigrationBlocks();
 const database=`aihr_dd_transfer_${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT}_${randomUUID().slice(0,8)}`;
 if(!/^aihr_dd_transfer_[1-9][0-9]*_[1-9][0-9]*_[0-9a-f]{8}$/.test(database)||database.length>63)throw Error('Invalid owned rehearsal database name.');
 const admin=connection(adminUrl,'postgres','postgres');
 let created=false,owner:ReturnType<typeof connection>|undefined,app:ReturnType<typeof connection>|undefined;
 try{
  const [server]=await admin<{version:number;versionText:string;session:string;current:string}[]>`select current_setting('server_version_num')::int as version,version() as "versionText",session_user::text as session,current_user::text as current`;
  expect(server).toMatchObject({session:'postgres',current:'postgres'});expect(server.version).toBeGreaterThanOrEqual(160000);expect(server.version).toBeLessThan(170000);
  // The separately approved pre-template helper must already have provisioned exact roles/edges.
  // A missing/incompatible graph fails instead of repairing roles from an individual test.
  const catalog=await readDraftDiscardRoleCatalog(admin);assertDraftDiscardRoleCatalog(catalog);
  await admin.unsafe(`CREATE DATABASE "${database}" OWNER ai_hr_owner TEMPLATE template0`);created=true;
  await admin.unsafe(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
  await admin.unsafe(`GRANT CONNECT ON DATABASE "${database}" TO ai_hr_app`);
  owner=connection(adminUrl,database,'ai_hr_owner');app=connection(adminUrl,database,'ai_hr_app');
  const initial=await loginState(owner);
  expect(initial).toEqual({session:'ai_hr_owner',current:'ai_hr_owner',priorRole:'none',super:false,createDb:false,createRole:false,bypassRls:false,inheritsChild:false,setsChild:true});
  // An actual denied role-creation statement, not a mock of rolsuper or a postgres SET ROLE session.
  await sqlstate(owner.unsafe(`CREATE ROLE "aihr_dd_forbidden_${randomUUID().replaceAll('-','')}" NOLOGIN`),'42501');
  await owner.unsafe('CREATE SCHEMA app AUTHORIZATION ai_hr_owner');
  await owner.unsafe('REVOKE ALL ON SCHEMA app FROM PUBLIC');
  await owner.unsafe('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await owner.unsafe('GRANT USAGE ON SCHEMA public TO ai_hr_app');
  await owner.unsafe('GRANT USAGE ON SCHEMA app TO ai_hr_app,ai_hr_draft_discard_port');
  await owner.unsafe('CREATE TABLE public.employee_draft(id uuid PRIMARY KEY)');
  await owner.unsafe('CREATE TABLE app.assistant_own_leave_review(id uuid PRIMARY KEY)');
  await owner.unsafe('CREATE TABLE app.assistant_own_leave_review_content(action_id uuid PRIMARY KEY)');
  for(const table of ['public.employee_draft','app.assistant_own_leave_review','app.assistant_own_leave_review_content'])await owner.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await owner.unsafe('GRANT SELECT,DELETE ON public.employee_draft TO ai_hr_app');
  await owner.unsafe('CREATE POLICY ownership_rehearsal_deny ON public.employee_draft TO ai_hr_app USING(false) WITH CHECK(false)');
  // Deliberately inert placeholders with EXACT function identities. No rows are read/deleted/stamped.
  await owner.unsafe("CREATE FUNCTION app._draft_discard_source_snapshot(uuid,uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT '{}'::jsonb $$");
  await owner.unsafe('CREATE FUNCTION app.native_employee_draft_discard_delete(uuid) RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT $1 WHERE false $$');
  await owner.unsafe('REVOKE ALL ON FUNCTION app._draft_discard_source_snapshot(uuid,uuid) FROM PUBLIC,ai_hr_app');
  await owner.unsafe('REVOKE ALL ON FUNCTION app.native_employee_draft_discard_delete(uuid) FROM PUBLIC,ai_hr_app');
  // A healthy restricted-owner preflight must first succeed, so the negative cases cannot pass
  // merely because an unrelated prerequisite was already broken.
  await owner.begin(async tx=>{await tx.unsafe(blocks.preflight);});
  const beforeFailure=await ownershipSnapshot(owner);
  expect(beforeFailure.functions).toHaveLength(2);expect(beforeFailure.schema).toHaveLength(1);
  expect(beforeFailure.schema[0]).toMatchObject({childCreate:false,appCreate:false});
  // Database-local schema ACL only. No shared cluster role attribute/membership is mutated.
  for(const grantee of ['ai_hr_app','ai_hr_draft_discard_port','PUBLIC']){
   await sqlstate(owner.begin(async tx=>{
    await tx.unsafe('GRANT CREATE ON SCHEMA app TO '+grantee);
    const altered=await ownershipSnapshot(tx);
    expect(altered.schema[0].appCreate||altered.schema[0].childCreate).toBe(true);
    await tx.unsafe(blocks.preflight);
   }),'P0001');
   expect(await ownershipSnapshot(owner)).toEqual(beforeFailure);
  }
  // Force the SECOND real ownership transfer to fail after the first transfer and its temporary
  // child CREATE grant. An earlier separate ACL change and function DROP must roll back as well.
  await sqlstate(owner.begin(async tx=>{
   await tx.unsafe(blocks.preflight);
   await tx.unsafe('REVOKE USAGE ON SCHEMA app FROM ai_hr_app');
   await tx.unsafe('DROP FUNCTION app.native_employee_draft_discard_delete(uuid)');
   await tx.unsafe(blocks.transfer);
  }),'42883');
  const afterFailure=await ownershipSnapshot(owner);
  expect(afterFailure).toEqual(beforeFailure);
  expect(afterFailure.login).toEqual(initial);
  // Source text is executed verbatim in one real-owner transaction; neither transfer algorithm nor
  // SUPER migration exception is copied, patched or substituted into this rehearsal.
  await owner.begin(async tx=>{
   await tx.unsafe("SET LOCAL lock_timeout='5s'");await tx.unsafe("SET LOCAL statement_timeout='15s'");
   expect(await loginState(tx)).toEqual(initial);
   await tx.unsafe(blocks.preflight);
   expect(await loginState(tx)).toEqual(initial);
   await tx.unsafe(blocks.transfer);
   expect(await loginState(tx)).toEqual(initial);
  });
  expect(await loginState(owner)).toEqual(initial);
  const [privileges]=await owner<{childCreate:boolean;ownerSource:boolean;ownerNative:boolean;appSource:boolean;appNative:boolean;appChildMember:boolean;appChildUsage:boolean;appChildSet:boolean}[]>`
   select has_schema_privilege('ai_hr_draft_discard_port','app','CREATE') as "childCreate",
    has_function_privilege('ai_hr_owner','app._draft_discard_source_snapshot(uuid,uuid)','EXECUTE') as "ownerSource",
    has_function_privilege('ai_hr_owner','app.native_employee_draft_discard_delete(uuid)','EXECUTE') as "ownerNative",
    has_function_privilege('ai_hr_app','app._draft_discard_source_snapshot(uuid,uuid)','EXECUTE') as "appSource",
    has_function_privilege('ai_hr_app','app.native_employee_draft_discard_delete(uuid)','EXECUTE') as "appNative",
    pg_has_role('ai_hr_app','ai_hr_draft_discard_port','MEMBER') as "appChildMember",
    pg_has_role('ai_hr_app','ai_hr_draft_discard_port','USAGE') as "appChildUsage",
    pg_has_role('ai_hr_app','ai_hr_draft_discard_port','SET') as "appChildSet"`;
  expect(privileges).toEqual({childCreate:false,ownerSource:true,ownerNative:false,appSource:false,appNative:true,appChildMember:false,appChildUsage:false,appChildSet:false});
  const functions=await owner<{identity:string;owner:string;securityDefiner:boolean;acl:string[]|null}[]>`
   select p.oid::regprocedure::text as identity,pg_get_userbyid(p.proowner)::text as owner,p.prosecdef as "securityDefiner",p.proacl::text[] as acl
   from pg_proc p where p.oid in('app._draft_discard_source_snapshot(uuid,uuid)'::regprocedure,'app.native_employee_draft_discard_delete(uuid)'::regprocedure)
   order by p.oid::regprocedure::text`;
  expect(functions).toHaveLength(2);for(const fn of functions){expect(fn.owner).toBe('ai_hr_draft_discard_port');expect(fn.securityDefiner).toBe(true);}
  const tables=await owner<{identity:string;owner:string;rls:boolean;forceRls:boolean}[]>`
   select c.oid::regclass::text as identity,pg_get_userbyid(c.relowner)::text as owner,c.relrowsecurity as rls,c.relforcerowsecurity as "forceRls"
   from pg_class c where c.oid in('public.employee_draft'::regclass,'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass) order by c.oid::regclass::text`;
  expect(tables).toHaveLength(3);for(const table of tables){expect(table.owner).toBe('ai_hr_owner');expect(table.rls).toBe(true);expect(table.forceRls).toBe(false);}
  const appInitial=await loginState(app);
  expect(appInitial).toEqual({session:'ai_hr_app',current:'ai_hr_app',priorRole:'none',super:false,createDb:false,createRole:false,bypassRls:false,inheritsChild:false,setsChild:false});
  await sqlstate(app.unsafe('SET ROLE ai_hr_draft_discard_port'),'42501');
  expect(await loginState(app)).toEqual(appInitial);
  await sqlstate(app.unsafe("SELECT app._draft_discard_source_snapshot('11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid)"),'42501');
  // Metadata only. No URLs/passwords/native records or placeholder bodies are exported.
  const finalRoles=await readDraftDiscardRoleCatalog(admin);assertDraftDiscardRoleCatalog(finalRoles);
  expect(finalRoles).toEqual(catalog);
  writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-draft-discard-role-transfer.json'),JSON.stringify({
   kind:'PERSONNEL_DRAFT_DISCARD_RESTRICTED_LOGIN_OWNERSHIP_REHEARSAL',candidate:process.env.AIHR_CI_HEAD,
   controller:process.env.AIHR_CI_CONTROL_HEAD,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
   source:{file:blocks.file,sha256:blocks.sourceHash,preflightSha256:blocks.preflightHash,transferSha256:blocks.transferHash,journalIndex:blocks.journalIndex,journalWhen:blocks.journalWhen,journalTag:blocks.journalTag,journalSha256:blocks.journalHash},
   roleFixtureFingerprintInput:DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT,
   roleFixtureSha256:hash(readFileSync(DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT,'utf8')),
   postgres:{versionNumber:server.version,versionText:server.versionText},
   realOwnerLogin:initial,realAppLogin:appInitial,roles:finalRoles,functions:Array.from(functions),tables:Array.from(tables),privileges,
   schemaCreateRefusal:{sqlstate:'P0001',rolledBack:true},
   forcedTransferFailure:{sqlstate:'42883',rolledBack:true,before:beforeFailure,after:afterFailure},
   rehearsalSourceSha256:hash(readFileSync(fileURLToPath(import.meta.url),'utf8')),
   scope:'actual assigned preflight and ownership transfer only; inert placeholders do not establish native deletion or custody proof',
  },null,2)+'\n');
 }finally{
  try{await app?.end({timeout:5});}finally{
   try{await owner?.end({timeout:5});}finally{
    try{if(created)await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);}finally{await admin.end({timeout:5});}
   }
  }
 }
},60000);
