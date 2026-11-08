/** Fixed unnumbered function in one actual disposable worker DB; never an installer. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import type {ISql,Sql} from 'postgres';
import {employeeRestorationHash,verifyEmployeePrototypeRestoration} from '../../.github/ci/employee-restoration-proof.mjs';
import {workerDb} from '../db-names';
export const employeeChoicePrototypeSignature='app.employee_choice_native_prototype(uuid,uuid,uuid,text[],jsonb,uuid[],date,uuid[],uuid,uuid,uuid,text,text,text,uuid,bigint,integer,text,text,uuid[])';
const sha=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
export const employeeChoicePrototypeSqlSha256='d72e6ded4a07cbbb848856c35391e1e56fdd02ad793c71a18360754e11fe8efc';
async function readNativeSecurity(query:ISql){
 return {functions:Array.from(await query`select p.oid::regprocedure::text as signature,md5(to_jsonb(p)::text) as identity
   from pg_proc p where p.pronamespace='app'::regnamespace and p.proname<>'employee_choice_native_prototype' order by p.oid::regprocedure::text`),
  policies:Array.from(await query`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname in('public','app') order by schemaname,tablename,policyname`),
  grants:Array.from(await query`select table_schema,table_name,grantee,privilege_type,is_grantable from information_schema.role_table_grants where table_schema in('public','app') order by table_schema,table_name,grantee,privilege_type`),
  roleEdges:Array.from(await query`select * from pg_auth_members order by roleid,member`)};
}
export type EmployeeChoiceNativeInstallation={database:string;sourceSha256:string;installed:{definition:string;identity:unknown};security:Awaited<ReturnType<typeof readNativeSecurity>>;unchanged:()=>Promise<void>;remove:()=>Promise<void>;restoration:()=>Promise<unknown>};
/** Fixed native owner only. Caller owns actual admission, bounded carriers and
 * work→cleanup transition; this creates no pool or authorization token. */
export function employeeChoiceNativePrototypeOwner(getQuery:()=>Sql){
async function install(adopt?:(value:EmployeeChoiceNativeInstallation)=>void):Promise<EmployeeChoiceNativeInstallation>{
 expect(sha('core/employee-choice.ts')).toBe('ce1e3559addbffa4b4e780594ebcc5fcf917ddffde79a6155cc7fbcecdbcfbd5');
 expect(sha('test/performance/employee-choice-native-current-baseline.ts')).toBe('fc1a1603aa7a032a0450dfca98eddd6068de5a1913478d25e5e7e90eea8e3816');
 expect(sha('test/fixtures/employee-choice-native-purpose.sql')).toBe(employeeChoicePrototypeSqlSha256);
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(pool).toMatch(/^[1-9][0-9]*$/);expect(process.env.WORKER_DB).not.toBe('0');
 const database=workerDb(pool!);
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const configured=new URL(process.env[key]!);expect(configured.hostname).toBe('127.0.0.1');expect(configured.pathname).toBe('/'+database);
  expect(configured.searchParams.has('host')).toBe(false);expect(configured.searchParams.has('database')).toBe(false);expect(configured.searchParams.has('options')).toBe(false);
 }
 const [identity]=await getQuery()`select current_user as role,session_user as login,current_database() as database,inet_server_addr()='127.0.0.1'::inet as loopback`;
 expect(identity).toEqual({role:'postgres',login:'postgres',database,loopback:true});
 const security=await readNativeSecurity(getQuery()),source=readFileSync('test/fixtures/employee-choice-native-purpose.sql','utf8');
 let installed:EmployeeChoiceNativeInstallation['installed']|undefined,removed=false;
 const owned=async()=>{
  if(!installed)throw Error('Native prototype witness missing');
  expect((await getQuery()`select count(*)::int as count from pg_proc where pronamespace='app'::regnamespace and proname='employee_choice_native_prototype'`)[0].count).toBe(1);
  const [current]=await getQuery()`select pg_get_functiondef(p.oid) as definition,to_jsonb(p) as identity from pg_proc p where p.oid=${employeeChoicePrototypeSignature}::regprocedure`;
  expect(current).toEqual({definition:installed.definition,identity:installed.identity});
 };
 const restored=async()=>{
  if(!installed)throw Error('Native prototype witness missing');
  const [identity]=await getQuery()`select current_user as role,session_user as login,current_database() as database,(select oid::text from pg_database where datname=current_database())as "databaseOid",inet_server_addr()='127.0.0.1'::inet as loopback`;
  const [absence]=await getQuery()`select to_regprocedure(${employeeChoicePrototypeSignature})is null as absent,(select count(*)::int from pg_proc where pronamespace='app'::regnamespace and proname='employee_choice_native_prototype')as overloads`;
  const after=await readNativeSecurity(getQuery());
  const value={version:1,kind:'NATIVE_EMPLOYEE_PROTOTYPE_RESTORATION_NOT_RELEASE',database,identity,sourceSha256:employeeChoicePrototypeSqlSha256,installed:structuredClone(installed),installedSha256:employeeRestorationHash(installed),beforeSecurity:structuredClone(security),afterSecurity:after,beforeSecuritySha256:employeeRestorationHash(security),afterSecuritySha256:employeeRestorationHash(after),securityCounts:Object.fromEntries(Object.entries(security).map(([name,rows])=>[name,rows.length])),signatureAbsent:absence.absent,overloads:absence.overloads};
  return verifyEmployeePrototypeRestoration(value,{database,sourceSha256:employeeChoicePrototypeSqlSha256,installedSha256:employeeRestorationHash(installed),securitySha256:employeeRestorationHash(security)});
 };
 let resource:EmployeeChoiceNativeInstallation|undefined;
 await getQuery().begin(async tx=>{
  await tx`select set_config('aihr.employee_choice_probe.database',${database},true)`;
  await tx.unsafe(source);
 const [created]=await tx<{definition:string;identity:unknown}[]>`select pg_get_functiondef(p.oid) as definition,to_jsonb(p) as identity,p.prosecdef,p.provolatile,p.proparallel,
  p.proconfig,p.pronargs,p.proisstrict,p.proleakproof,p.prokind,p.proowner::regrole::text as owner,
  has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0) as public,
  (select count(*)::int from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))) as acl_count
  from pg_proc p where p.oid=${employeeChoicePrototypeSignature}::regprocedure`;
 if(!created)throw Error('Native created function witness missing');
 expect(created).toMatchObject({prosecdef:false,provolatile:'s',proparallel:'u',proconfig:['search_path=pg_catalog, pg_temp','jit=off'],
  pronargs:20,proisstrict:false,proleakproof:false,prokind:'f',owner:'postgres',app:true,public:false,acl_count:2});
 const acl=await tx`select a.grantor::regrole::text as grantor,a.grantee::regrole::text as grantee,a.privilege_type,a.is_grantable from pg_proc p,aclexplode(p.proacl) a where p.oid=${employeeChoicePrototypeSignature}::regprocedure order by a.grantee::regrole::text`;
 expect(Array.from(acl)).toEqual([{grantor:'postgres',grantee:'ai_hr_app',privilege_type:'EXECUTE',is_grantable:false},{grantor:'postgres',grantee:'postgres',privilege_type:'EXECUTE',is_grantable:false}]);
 // BORROWED_TRANSACTION_SECURITY: never reacquire a max1 owner pool.
 expect(await readNativeSecurity(tx)).toEqual(security);
 installed=structuredClone(created);
 resource={database,sourceSha256:createHash('sha256').update(source).digest('hex'),installed:structuredClone(created),security:structuredClone(security),
  async unchanged(){await owned();expect(await readNativeSecurity(getQuery())).toEqual(security);},
  async remove(){
   if(removed){await restored();return;}
   const [present]=await getQuery()`select count(*)::int as count from pg_proc where pronamespace='app'::regnamespace and proname='employee_choice_native_prototype'`;
   // Predecessor guard established complete absence. A rolled-back/lost COMMIT
   // may leave that exact predecessor; never drop an unrecognized replacement.
   if(present.count===0){await restored();removed=true;return;}
   await owned();
   await getQuery().unsafe('drop function '+employeeChoicePrototypeSignature);
   expect((await getQuery()`select to_regprocedure(${employeeChoicePrototypeSignature}) as function`)[0].function).toBeNull();
   expect(await readNativeSecurity(getQuery())).toEqual(security);await restored();removed=true;
  },async restoration(){if(!removed)throw Error('Native removal has not settled');return restored();}};
 // Own the native OID/body/metadata witness BEFORE the COMMIT response can be
 // lost. Cleanup accepts only this exact result or the guarded absent predecessor.
 adopt?.(resource);
 });
 if(!resource)throw Error('Native prototype adoption missing');return resource;
}
 return{security:()=>readNativeSecurity(getQuery()),install};
}
