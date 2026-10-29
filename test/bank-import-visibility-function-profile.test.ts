/** Disposable GHA function-only causality diagnostic. No policy replacement or throughput acceptance. */
import {createHash} from 'node:crypto';
import {afterAll,describe,expect,it} from 'vitest';
import {closeAll,migrateTestDb} from './harness';
import {b,C,CONTEXTS,ctxByName,E,inCtx,pg,q,setupOrg,T2,type Ctx} from './r395-org';

const ROWS=100001;
const ORIGINAL='app.visible_employment_ids()';
const CANDIDATE='app.ci_bank_visible_employment_ids_materialized()';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const ident=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const anchor=`  admin_company AS (
    SELECT c.company_id
    FROM (SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id()) c
    WHERE app.is_admin_for(c.company_id)
  ),`;
const replacement=`  tenant_companies AS MATERIALIZED (
    SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id()
  ),
  admin_company AS (
    SELECT c.company_id
    FROM tenant_companies c
    WHERE app.is_admin_for(c.company_id)
  ),`;
function once(value:string,from:string,to:string){
 expect(value.split(from).length,'Reviewed transformation anchor must occur exactly once').toBe(2);
 return value.replace(from,to);
}
type Acl={grantor:string;grantee:string;privilege:string;grantable:boolean};
type Snapshot={definition:string;catalog:Record<string,unknown>;owner_name:string;acl:Acl[]};
async function snapshot(signature:string):Promise<Snapshot>{
 const [row]=await q(`select pg_get_functiondef(p.oid) as definition,to_jsonb(p) as catalog,r.rolname as owner_name
  from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`,[signature]);
 expect(Boolean(row),'Function must exist in actual disposable catalog').toBe(true);
 const acl=await q(`select grantor.rolname as grantor,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,
  a.privilege_type as privilege,a.is_grantable as grantable
  from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  join pg_roles grantor on grantor.oid=a.grantor left join pg_roles grantee on grantee.oid=a.grantee
  where p.oid=$1::regprocedure order by grantor.rolname,a.grantee,a.privilege_type,a.is_grantable`,[signature]);
 return {...row,acl} as unknown as Snapshot;
}
const comparableAttributes=({oid:_oid,proname:_name,prosrc:_body,proacl:_acl,...attributes}:Record<string,unknown>)=>attributes;
async function fences(){
 return {
  policies:await q(`select n.nspname,c.relname,to_jsonb(p) as policy from pg_policy p join pg_class c on c.oid=p.polrelid
   join pg_namespace n on n.oid=c.relnamespace order by n.nspname,c.relname,p.polname`),
  tables:await q(`select n.nspname,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity from pg_class c
   join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','app') order by n.nspname,c.relname`),
 };
}
async function installCandidate(original:Snapshot,created:()=>void){
 expect(original.catalog.prosecdef).toBe(true);expect(original.catalog.provolatile).toBe('s');
 expect(original.catalog.proconfig).toEqual(['search_path=public']);
 expect(original.catalog.prosrc,'Actual SQL body must be captured').toBeTypeOf('string');
 expect(original.acl.every(a=>a.privilege==='EXECUTE'),'Function ACL must contain EXECUTE entries only').toBe(true);
 const renamed=once(original.definition,'CREATE OR REPLACE FUNCTION '+ORIGINAL,'CREATE FUNCTION '+CANDIDATE);
 const definition=once(renamed,anchor,replacement);
 await pg.begin(async raw=>{
  const tx=raw as unknown as typeof pg;
  // CREATE, never CREATE OR REPLACE: an unexpected preexisting candidate is a refusal.
  await tx.unsafe(definition);
  await tx.unsafe(`ALTER FUNCTION ${CANDIDATE} OWNER TO ${ident(original.owner_name)}`);
  const defaults=await tx.unsafe(`select distinct case when a.grantee=0 then 'PUBLIC' else r.rolname end as grantee
   from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   left join pg_roles r on r.oid=a.grantee where p.oid=$1::regprocedure`,[CANDIDATE]);
  await tx.unsafe(`SET LOCAL ROLE ${ident(original.owner_name)}`);
  for(const entry of defaults){
   const grantee=String(entry.grantee);
   await tx.unsafe(`REVOKE ALL PRIVILEGES ON FUNCTION ${CANDIDATE} FROM ${grantee==='PUBLIC'?'PUBLIC':ident(grantee)} CASCADE`);
  }
  // Reproduce effective ACL, including original grantors and grant options. Owner-origin grants
  // precede delegated grants; unexpected chains fail the exact post-install ACL comparison.
  const grants=original.acl.slice().sort((a,z)=>Number(z.grantor===original.owner_name)-Number(a.grantor===original.owner_name)||Number(z.grantable)-Number(a.grantable));
  for(const entry of grants){
   await tx.unsafe('RESET ROLE');
   await tx.unsafe(`SET LOCAL ROLE ${ident(entry.grantor)}`);
   await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${CANDIDATE} TO ${entry.grantee==='PUBLIC'?'PUBLIC':ident(entry.grantee)}${entry.grantable?' WITH GRANT OPTION':''}`);
  }
 });
 created(); // Cleanup owns this successfully committed candidate even if metadata checks fail.
 const candidate=await snapshot(CANDIDATE);
 expect(comparableAttributes(candidate.catalog)).toEqual(comparableAttributes(original.catalog));
 expect(candidate.owner_name).toBe(original.owner_name);expect(candidate.acl).toEqual(original.acl);
 expect(candidate.catalog.prosrc).toBe(once(String(original.catalog.prosrc),anchor,replacement));
 expect(candidate.definition).toBe(once(once(original.definition,'CREATE OR REPLACE FUNCTION '+ORIGINAL,'CREATE OR REPLACE FUNCTION '+CANDIDATE),anchor,replacement));
 console.info('[bank-visibility-function-metadata]',JSON.stringify({originalDefinitionSha256:sha(original.definition),candidateDefinitionSha256:sha(candidate.definition),
  originalBodySha256:sha(String(original.catalog.prosrc)),candidateBodySha256:sha(String(candidate.catalog.prosrc)),attributes:comparableAttributes(original.catalog),owner:original.owner_name,effectiveExecuteAcl:original.acl,onlyDistinctCompanyMaterializationChanged:true}));
}
async function principal(tx:typeof pg,ctx:Ctx,backend:number){
 await tx.unsafe("SET LOCAL statement_timeout='120s'");
 await tx.unsafe(`select set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.roles',$3,true),set_config('app.grants',$4,true)`,[ctx.tenantId,ctx.userId,ctx.roles.join(','),JSON.stringify(ctx.grants)]);
 const [role]=await tx.unsafe(`select current_user as role,r.rolsuper,r.rolbypassrls,pg_backend_pid() as backend,current_setting('row_security') as row_security,
  current_setting('app.tenant_id')=$1 as tenant_matches,current_setting('app.user_id')=$2 as user_matches,
  current_setting('app.roles')=$3 as roles_match,current_setting('app.grants')=$4 as grants_match from pg_roles r where r.rolname=current_user`,[ctx.tenantId,ctx.userId,ctx.roles.join(','),JSON.stringify(ctx.grants)]);
 expect({...role}).toEqual({role:'ai_hr_app',rolsuper:false,rolbypassrls:false,backend,row_security:'on',tenant_matches:true,user_matches:true,roles_match:true,grants_match:true});
}
async function call(tx:typeof pg,signature:typeof ORIGINAL|typeof CANDIDATE){
 const started=performance.now();
 const [row]=await tx.unsafe(`select ${signature} as ids`);
 const elapsedMs=performance.now()-started;
 expect(Array.isArray(row.ids),'Visibility must return an actual ordered UUID array').toBe(true);
 const ids=row.ids as string[];
 expect(ids.every(id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))).toBe(true);
 expect(ids.every((id,i)=>i===0||ids[i-1]<id),'UUID ordering/uniqueness must remain exact').toBe(true);
 return {ids,elapsedMs,hash:sha(ids.join('\n'))};
}
async function compare(tx:typeof pg,ctx:Ctx,backend:number,stage:string,round:number){
 await principal(tx,ctx,backend);
 // Reverse order on alternate rounds; do not assume cache temperature or assert a speedup.
 const first=await call(tx,round%2?ORIGINAL:CANDIDATE),second=await call(tx,round%2?CANDIDATE:ORIGINAL);
 const original=round%2?first:second,candidate=round%2?second:first;
 // Boolean equality keeps UUID values out of assertion failure output as well as successful logs.
 expect(original.ids.length===candidate.ids.length&&original.ids.every((id,i)=>id===candidate.ids[i]),'Candidate must preserve the exact ordered visibility array, without expansion').toBe(true);
 expect(original.hash).toBe(candidate.hash);
 if(ctx.name==='employee (leaf2)')expect(original.ids.includes(E.leaf2),'Existing self visibility must be nonempty').toBe(true);
 if(ctx.name==='manager top (ceo)'){
  expect(original.ids.includes(E.subco),'Company-descendant manager fixture must remain live').toBe(true);
  expect(original.ids.includes(E.bemp),'Unrelated-company report must stay fenced').toBe(false);
 }
 if(ctx.name==='hr_admin scoped to A')expect(original.ids.includes(E.adminA)).toBe(true);
 if(ctx.tenantId===T2)expect(original.ids.includes(E.t2emp)&&!original.ids.includes(E.leaf2),'Other tenant principal must retain its own visibility only').toBe(true);
 if(ctx.name==='no user')expect(original.ids.length).toBe(0);
 console.info('[bank-visibility-function-sample]',JSON.stringify({stage,round,context:ctx.name,count:original.ids.length,orderedUuidSha256:original.hash,originalMs:original.elapsedMs,candidateMs:candidate.elapsedMs,exactOrderedEquality:true,sameConnection:true}));
 return {count:original.ids.length,hash:original.hash};
}

afterAll(closeAll);
describe('separately named materialized-company visibility function diagnostic',()=>{
 it('preserves all 24 principals and measures identical ordered arrays at fictional scale',async()=>{
  expect(process.env.GITHUB_ACTIONS,'Disposable GitHub Actions diagnosis only').toBe('true');
  expect(process.env.CI).toBe('true');
  await migrateTestDb();await setupOrg();expect(CONTEXTS.length).toBe(24);
  const original=await snapshot(ORIGINAL),originalFences=await fences();
  const [environment]=await q("select current_setting('server_version_num') as postgres_version,current_setting('jit') as jit");
  console.info('[bank-visibility-function-environment]',JSON.stringify({environment,originalPolicyAndRlsSha256:sha(JSON.stringify(originalFences)),sourceFunctionOnly:true}));
  const [absent]=await q('select to_regprocedure($1) is null as absent',[CANDIDATE]);expect(absent.absent).toBe(true);
  let installed=false,primaryError:unknown;
  try{
   await installCandidate(original,()=>{installed=true;});
   await inCtx(CONTEXTS[0],async tx=>{
    await tx.unsafe('SET LOCAL ROLE ai_hr_app');
    const [connection]=await tx.unsafe('select pg_backend_pid() as backend');
    for(const ctx of CONTEXTS)await compare(tx,ctx,Number(connection.backend),'small-org',1);
    // GUC changes on this same backend revisit the original principal after another tenant/no user.
    const admin=ctxByName('hr_admin scoped to A');
    const before=await compare(tx,admin,Number(connection.backend),'small-revisit',1);
    await compare(tx,ctxByName('other tenant manager'),Number(connection.backend),'small-revisit',1);
    await compare(tx,ctxByName('no user'),Number(connection.backend),'small-revisit',1);
    expect(await compare(tx,admin,Number(connection.backend),'small-revisit',2)).toEqual(before);
   });
   const [before]=await q('select count(*)::int as rows,count(distinct company_id)::int as companies from employment');
   await pg.begin(async tx=>{
    // Fictional construction only. LOCAL restores ordinary triggers at transaction end;
    // every measured function uses the real app role with normal RLS and unchanged policies.
    await tx.unsafe("SET LOCAL session_replication_role='replica'");
    await tx.unsafe(`with people as (insert into person(tenant_id,full_name,primary_email)
     select $1::uuid,'Function profile '||n,'function-profile-'||n||'@example.test' from generate_series(1,$3::int) n returning id)
     insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
     select $1::uuid,id,$2::uuid,'VFUN'||row_number() over(order by id),'2026-01-05'::date from people`,[b.tenantId,C.A,ROWS]);
   });
   for(const table of ['person','employment'])await q(`ANALYZE public.${ident(table)}`);
   const [restored]=await q("select current_setting('session_replication_role') as replication");expect(restored.replication).toBe('origin');
   const [cohort]=await q(`select count(*)::int as rows,count(distinct e.id)::int as employments,count(distinct e.person_id)::int as people,
    count(distinct e.company_id)::int as companies from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
    where e.tenant_id=$1::uuid and e.company_id=$2::uuid and e.employee_code ~ '^VFUN[0-9]+$'`,[b.tenantId,C.A]);
   expect(cohort).toEqual({rows:ROWS,employments:ROWS,people:ROWS,companies:1});
   const [after]=await q('select count(*)::int as rows,count(distinct company_id)::int as companies from employment');
   expect(after.rows).toBe(Number(before.rows)+ROWS);expect(after.companies).toBe(before.companies);
   console.info('[bank-visibility-function-catalog]',JSON.stringify({kind:'DISPOSABLE_FUNCTION_CAUSALITY_NOT_NATIVE_THROUGHPUT',fictionalAddedRows:ROWS,before,after,cohort}));
   await inCtx(ctxByName('hr_admin scoped to A'),async tx=>{
    await tx.unsafe('SET LOCAL ROLE ai_hr_app');
    const [connection]=await tx.unsafe('select pg_backend_pid() as backend');
    const admin=ctxByName('hr_admin scoped to A'),employee=ctxByName('employee (leaf2)'),other=ctxByName('other tenant manager');
    let expectedAdmin:{count:number;hash:string}|undefined;
    for(const round of [1,2]){
     const actual=await compare(tx,admin,Number(connection.backend),'scale',round);
     expect(actual.count>ROWS,'Scoped administrator must include the genuine large cohort').toBe(true);
     if(expectedAdmin)expect(actual).toEqual(expectedAdmin);else expectedAdmin=actual;
     await compare(tx,employee,Number(connection.backend),'scale',round);
     await compare(tx,other,Number(connection.backend),'scale',round);
    }
    expect(await compare(tx,admin,Number(connection.backend),'scale-revisit',2)).toEqual(expectedAdmin);
   });
  }catch(error){primaryError=error;throw error;}finally{
   const failures:unknown[]=[];
   // Cleanup and immutable-original checks all run even if an earlier measurement fails.
   if(installed)try{await q(`DROP FUNCTION ${CANDIDATE}`);}catch(error){failures.push(error);}
   for(const check of [async()=>expect(await snapshot(ORIGINAL)).toEqual(original),async()=>expect(await fences()).toEqual(originalFences),async()=>{
    const [row]=await q('select to_regprocedure($1) is null as absent',[CANDIDATE]);expect(row.absent).toBe(true);
   }])try{await check();}catch(error){failures.push(error);}
   if(primaryError!==undefined)for(const error of failures)console.error('Function diagnostic cleanup/immutability failure after original error:',error);
   else if(failures.length)throw failures[0];
  }
  console.info('[bank-visibility-function-summary]',JSON.stringify({contexts:24,fictionalAddedRows:ROWS,originalFunctionUnchanged:true,policyAndRlsFencesUnchanged:true,candidateRemoved:true,nativeWritesMeasured:0,throughputAcceptance:false,releaseAuthorized:false}));
 },900000);
});
