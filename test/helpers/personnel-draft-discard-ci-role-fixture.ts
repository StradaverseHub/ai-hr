/** Disposable hosted role fixture. No import-time execution or live provisioning.
 * Validated before every template reuse/migration; included in FINGERPRINT_EXTRA_FILES.
 * This emulates operator provisioning only in the canonical disposable focused job. */
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {platform} from 'node:os';
import postgres from 'postgres';

export const DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT='test/helpers/personnel-draft-discard-ci-role-fixture.ts';
const roleNames=['ai_hr_app','ai_hr_owner','ai_hr_draft_discard_port'] as const;
/** Only the shared query method is required; TransactionSql need not expose Sql connection methods. */
export type DraftDiscardCatalogSql=Pick<postgres.Sql,'unsafe'>;
/** test/db-names.ts builds workerDbPrefix as WORKER_BASE + namespaceSuffix, THEN appends poolId:
 * ai_hr_test_w + _aifocus + 1 = ai_hr_test_w_aifocus1. The old w1_aifocus shape is refused. */
export const isDraftDiscardFixtureDatabasePath=(path:string)=>/^\/ai_hr_test(?:_tpl_aifocus|_w_aifocus[1-9][0-9]*)?$/.test(path);
export type RoleRow={oid:number;name:string;login:boolean;inherit:boolean;super:boolean;createDb:boolean;createRole:boolean;replication:boolean;bypassRls:boolean;connectionLimit:number;validUntil:string|null};
export type MembershipRow={role:string;member:string;grantor:string;inherit:boolean;set:boolean;admin:boolean};
export type RoleCatalog={roles:RoleRow[];edges:MembershipRow[]};
export type DraftDiscardRoleFixture=RoleCatalog&{mode:'focused_disposable'|'preprovisioned_read_only';postgres:{versionNumber:number;versionText:string;session:string;current:string}};
const refuse=():never=>{throw Error('Disposable focused role fixture prerequisites are not satisfied.');};
const sha=(value:string|undefined)=>/^[0-9a-f]{40}$/.test(value??'');
const numeric=(value:string|undefined)=>/^[1-9][0-9]*$/.test(value??'');

/** No URL or credential is included in an error, result or artifact. All checks precede a connection. */
export function assertDisposableDraftDiscardFixture(adminUrl:string):void{
 const env=process.env;
 if(env.GITHUB_ACTIONS!=='true'||env.CI!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.RUNNER_OS!=='Linux'||platform()!=='linux'
  ||env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_WORKFLOW!=='alpha-focused-checks'
  ||env.GITHUB_JOB!=='selected-tests'||!numeric(env.GITHUB_RUN_ID)||!numeric(env.GITHUB_RUN_ATTEMPT)
  ||env.TEST_DB_NAMESPACE!=='aifocus'||env.AIHR_FOCUSED_SUITE_CAPACITY!=='true'||!sha(env.AIHR_CI_HEAD)||!sha(env.AIHR_CI_CONTROL_HEAD)
  ||!env.GITHUB_WORKFLOW_REF?.startsWith('StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/heads/'))refuse();
 if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==env.AIHR_CI_HEAD)refuse();
 const check=(raw:string|undefined,user:string,admin=false)=>{
  if(!raw)return refuse();let url:URL;try{url=new URL(raw);}catch{return refuse();}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='5433'
   ||url.username!==user||url.password!==''||url.search!==''||url.hash!=='')refuse();
  if(admin?url.pathname!=='/postgres':!isDraftDiscardFixtureDatabasePath(url.pathname))refuse();
  return url;
 };
 const admin=check(adminUrl,'postgres',true),migration=check(env.TEST_MIGRATION_DATABASE_URL,'postgres');
 check(env.TEST_DATABASE_URL,'ai_hr_app');migration.pathname='/postgres';
 if(admin.href!==migration.href)refuse();
 const evidence=env.AIHR_FOCUSED_EVIDENCE_DIR,temp=env.RUNNER_TEMP;
 if(!evidence||!temp||!isAbsolute(evidence)||!isAbsolute(temp))refuse();
 if(realpathSync(evidence)!==join(realpathSync(temp),'aihr-focused'))refuse();
 if(resolve(evidence)!==realpathSync(evidence))refuse();
}
export async function readDraftDiscardRoleCatalog(sql:DraftDiscardCatalogSql):Promise<RoleCatalog>{
 const roles=await sql.unsafe<RoleRow[]>(`select oid::int as oid,rolname::text as name,rolcanlogin as login,rolinherit as inherit,
   rolsuper as super,rolcreatedb as "createDb",rolcreaterole as "createRole",rolreplication as replication,
   rolbypassrls as "bypassRls",rolconnlimit as "connectionLimit",rolvaliduntil::text as "validUntil"
   from pg_roles where rolname in ('ai_hr_app','ai_hr_owner','ai_hr_draft_discard_port') order by rolname`);
 const edges=await sql.unsafe<MembershipRow[]>(`select parent.rolname::text as role,child.rolname::text as member,
   grantor.rolname::text as grantor,m.inherit_option as inherit,m.set_option as set,m.admin_option as admin
   from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles child on child.oid=m.member
   join pg_roles grantor on grantor.oid=m.grantor
   where parent.rolname in ('ai_hr_app','ai_hr_owner','ai_hr_draft_discard_port')
    or child.rolname in ('ai_hr_app','ai_hr_owner','ai_hr_draft_discard_port')
   order by parent.rolname,child.rolname,grantor.rolname`);
 return{roles:Array.from(roles),edges:Array.from(edges)};
}
/** Missing roles are accepted ONLY for the before-provisioning inspection. Existing attributes and
 * every existing incident edge must already equal the exact intended graph; none are repaired. */
export function assertDraftDiscardRoleCatalog(catalog:RoleCatalog,allowMissing=false):void{
 const byName=new Map(catalog.roles.map(role=>[role.name,role]));
 if(!byName.has('ai_hr_app')||!allowMissing&&byName.size!==3)refuse();
 // Fresh controller cluster is app-only. A partially existing owner/child graph is uncertain,
 // so it is refused rather than completed or reconciled by this fixture.
 if(allowMissing&&byName.size!==1&&byName.size!==3)refuse();
 for(const role of catalog.roles){
  if(!roleNames.some(name=>name===role.name)||role.login!==(role.name!=='ai_hr_draft_discard_port')||!role.inherit
   ||role.super||role.createDb||role.createRole||role.replication||role.bypassRls||role.connectionLimit!==-1||role.validUntil!==null)refuse();
 }
 const intended=[
  {role:'ai_hr_app',member:'ai_hr_draft_discard_port',inherit:true,set:false,admin:false},
  {role:'ai_hr_draft_discard_port',member:'ai_hr_owner',inherit:false,set:true,admin:false},
 ].filter(edge=>byName.has(edge.role)&&byName.has(edge.member));
 if(catalog.edges.length!==intended.length)refuse();
 for(const edge of intended){
  const actual=catalog.edges.filter(row=>row.role===edge.role&&row.member===edge.member);
  if(actual.length!==1||actual[0].inherit!==edge.inherit||actual[0].set!==edge.set||actual[0].admin!==edge.admin||actual[0].grantor!=='postgres')refuse();
 }
}
export async function prepareDisposableDraftDiscardRoles(adminUrl:string):Promise<DraftDiscardRoleFixture>{
 assertDisposableDraftDiscardFixture(adminUrl);
 const admin=postgres(adminUrl,{max:1,onnotice:()=>{},connect_timeout:5});
 try{return await admin.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(hashtextextended('test:focused:draft-discard-role-fixture',0))`;
  const [server]=await tx<{version:number;versionText:string;session:string;current:string;super:boolean}[]>`select
   current_setting('server_version_num')::int as version,version() as "versionText",session_user::text as session,current_user::text as current,
   (select rolsuper from pg_roles where rolname=current_user) as super`;
  if(server.version<160000||server.version>=170000||server.session!=='postgres'||server.current!=='postgres'||!server.super)refuse();
  const before=await readDraftDiscardRoleCatalog(tx);assertDraftDiscardRoleCatalog(before,true);
  const absent=(name:string)=>!before.roles.some(role=>role.name===name);
  if(absent('ai_hr_owner'))await tx.unsafe('CREATE ROLE ai_hr_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT');
  if(absent('ai_hr_draft_discard_port'))await tx.unsafe('CREATE ROLE ai_hr_draft_discard_port NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT');
  // Add only edges whose endpoint role was absent. Never modify a pre-existing edge or role.
  if(absent('ai_hr_draft_discard_port')){
   await tx.unsafe('GRANT ai_hr_app TO ai_hr_draft_discard_port WITH INHERIT TRUE');
   await tx.unsafe('GRANT ai_hr_app TO ai_hr_draft_discard_port WITH SET FALSE');
   await tx.unsafe('GRANT ai_hr_app TO ai_hr_draft_discard_port WITH ADMIN FALSE');
  }
  if(absent('ai_hr_owner')||absent('ai_hr_draft_discard_port')){
   await tx.unsafe('GRANT ai_hr_draft_discard_port TO ai_hr_owner WITH INHERIT FALSE');
   await tx.unsafe('GRANT ai_hr_draft_discard_port TO ai_hr_owner WITH SET TRUE');
   await tx.unsafe('GRANT ai_hr_draft_discard_port TO ai_hr_owner WITH ADMIN FALSE');
  }
  const after=await readDraftDiscardRoleCatalog(tx);assertDraftDiscardRoleCatalog(after);
  const [paths]=await tx<{inheritsChild:boolean;setsChild:boolean;appMemberChild:boolean;childMemberOwner:boolean}[]>`select
   pg_has_role('ai_hr_owner','ai_hr_draft_discard_port','USAGE') as "inheritsChild",
   pg_has_role('ai_hr_owner','ai_hr_draft_discard_port','SET') as "setsChild",
   pg_has_role('ai_hr_app','ai_hr_draft_discard_port','MEMBER') as "appMemberChild",
   pg_has_role('ai_hr_draft_discard_port','ai_hr_owner','MEMBER') as "childMemberOwner"`;
  if(paths.inheritsChild||!paths.setsChild||paths.appMemberChild||paths.childMemberOwner)refuse();
  return {...after,mode:'focused_disposable' as const,postgres:{versionNumber:server.version,versionText:server.versionText,session:server.session,current:server.current}};
 });}finally{await admin.end({timeout:5});}
}

/** Other test contexts may use an already provisioned graph. This path never creates or repairs
 * roles, assumes no superuser identity, and writes no focused artifact. Missing prerequisites refuse. */
export async function validateExistingDraftDiscardRoles(adminUrl:string):Promise<DraftDiscardRoleFixture>{
 const connection=postgres(adminUrl,{max:1,onnotice:()=>{},connect_timeout:5});
 try{return await connection.begin(async tx=>{
  await tx`set transaction read only`;
  const [server]=await tx<{version:number;versionText:string;session:string;current:string}[]>`select
   current_setting('server_version_num')::int as version,version() as "versionText",
   session_user::text as session,current_user::text as current`;
  if(server.version<160000)refuse();
  const catalog=await readDraftDiscardRoleCatalog(tx);assertDraftDiscardRoleCatalog(catalog);
  return {...catalog,mode:'preprovisioned_read_only' as const,postgres:{versionNumber:server.version,versionText:server.versionText,session:server.session,current:server.current}};
 });}finally{await connection.end({timeout:5});}
}
/** Focused intent always takes the strict guard. A failed guard cannot fall back to a connection
 * or another provisioning course. Other contexts only validate their existing operator prerequisite. */
export function ensureDraftDiscardTestRoles(adminUrl:string):Promise<DraftDiscardRoleFixture>{
 if(process.env.AIHR_FOCUSED_SUITE_CAPACITY==='true'||process.env.GITHUB_WORKFLOW==='alpha-focused-checks')
  return prepareDisposableDraftDiscardRoles(adminUrl);
 return validateExistingDraftDiscardRoles(adminUrl);
}
