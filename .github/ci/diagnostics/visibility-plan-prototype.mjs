/** Diagnostic-only PG16 plan reuse. Never an applied migration or a release witness. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const MIGRATION='db/migrations/0515_set_based_visibility.sql';
export const MIGRATION_SHA='dbeab56c82d76a78ac300163bec13b22c3b5dacb288b07190967104f5e3e07f3';
export const BODY_SHA='f432124ede65722f018be3ac5b5372ac2aac6aec333c8f0a4bd5cda002efe220';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function prototypeDefinition(migration){
 assert.equal(hash(migration),MIGRATION_SHA,'Reassess changed canonical migration');
 const found=migration.match(/CREATE OR REPLACE FUNCTION app\.visible_employment_ids\(\)\s+RETURNS uuid\[\]\s+LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public\s+AS \$\$([\s\S]*?)\$\$;/);
 assert(found&&hash(found[1])===BODY_SHA,'Exact canonical predicate required');
 const original=found[1],query=original.trim();assert(query.endsWith(';'));
 const body='\nBEGIN\n RETURN (\n'+query.slice(0,-1)+'\n );\nEND;\n';
 return {original,body,sql:'CREATE OR REPLACE FUNCTION app.visible_employment_ids() RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $aihr_plan_probe$'+body+'$aihr_plan_probe$;'};
}
export const CATALOG_SQL="SELECT current_database() AS database,current_user AS caller,p.oid::text AS oid,pg_get_userbyid(p.proowner) AS owner,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS dbid,l.lanname AS language,p.prosrc AS body,(to_jsonb(p)-'prosrc'-'prolang') AS immutable FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='app.visible_employment_ids()'::regprocedure";
export function validatePrototypeCatalog(row,definition,mode){
 assert(['baseline','prototype'].includes(mode));
 assert(row?.caller==='postgres'&&row.owner==='postgres'&&/^ai_hr_test_w[12]_plan_(base|proto)$/.test(row.database),'Owned worker/owner required');
 assert.equal(row.database.endsWith('_plan_proto'),mode==='prototype','Wrong phase database');
 const p=row.immutable;
 assert(/^\d+$/.test(row.oid)&&p&&p.proname==='visible_employment_ids'&&p.prokind==='f'&&p.provolatile==='s'
  &&p.prosecdef===true&&p.proleakproof===false&&p.proisstrict===false&&p.proretset===false&&p.proparallel==='u'
  &&p.pronargs===0&&p.procost===100&&p.prosqlbody===null&&isDeepStrictEqual(p.proconfig,['search_path=public']),'Canonical function properties changed');
 assert((row.language==='sql'&&row.body===definition.original)||(mode==='prototype'&&row.language==='plpgsql'&&row.body===definition.body),'Foreign function implementation');
 return row;
}
export function assertInstallEnvironment(e){
 assert(e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'
  &&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_RUN_ATTEMPT==='1','Owned first-attempt hosted experiment only');
 assert(['baseline','prototype'].includes(e.AIHR_PLAN_REUSE_MODE)&&e.AIHR_CI_HEAD===e.AIHR_CI_CONTROL_HEAD&&/^[a-f0-9]{40}$/.test(e.AIHR_CI_HEAD??''),'Frozen identical candidate/controller required');
 assert(e.TEST_DB_NAMESPACE===(e.AIHR_PLAN_REUSE_MODE==='baseline'?'plan_base':'plan_proto'),'Explicit private namespace required');
 const url=new URL(e.TEST_MIGRATION_DATABASE_URL);assert(url.hostname==='127.0.0.1'&&url.port==='5433'&&url.username==='postgres'
  &&/^\/ai_hr_test_w[12]_plan_(base|proto)$/.test(url.pathname),'Owned local runner worker only');
}
export async function installVisibilityPlan(query,label){
 assertInstallEnvironment(process.env);assert(['cash','visibility','principal'].includes(label));
 const temp=realpathSync(process.env.RUNNER_TEMP),declared=resolve(process.env.AIHR_PLAN_PROOF_DIR),out=realpathSync(declared),st=lstatSync(declared);
 assert(out===declared&&out.startsWith(temp+'/')&&st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o077)===0,'Owned private evidence directory required before mutation');
 const mode=process.env.AIHR_PLAN_REUSE_MODE,definition=prototypeDefinition(readFileSync(join(process.cwd(),MIGRATION),'utf8'));
 const [before]=await query(CATALOG_SQL);validatePrototypeCatalog(before,definition,mode);
 if(mode==='prototype'&&before.language==='sql')await query(definition.sql);
 const [after]=await query(CATALOG_SQL);validatePrototypeCatalog(after,definition,mode);
 assert.equal(after.language,mode==='prototype'?'plpgsql':'sql');
 assert.equal(after.oid,before.oid);assert(isDeepStrictEqual(before.immutable,after.immutable),'Ownership, ACLs, volatility, search path or other catalog properties changed');

 const proof={kind:'OWNED_VISIBILITY_PLAN_PROTOTYPE_NOT_RELEASE_EVIDENCE',source:process.env.AIHR_CI_HEAD,mode,label,database:after.database,
  before:{...before,bodySha256:hash(before.body)},after:{...after,bodySha256:hash(after.body)},canonicalBodySha256:BODY_SHA,immutablePropertiesPreserved:true,releaseAuthorized:false};
 writeFileSync(join(out,after.database+'-'+label+'.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
 return proof;
}
