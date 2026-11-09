/** Actual workload cluster boundary. The browser and business fixture are separate courses. */
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import postgres from 'postgres';
import {expect,it} from 'vitest';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {NATIVE_WORKLOAD_DATABASE_CASE,NATIVE_WORKLOAD_DATABASE_MEMBER,NATIVE_WORKLOAD_OBSERVER,
 validateNativeWorkloadObserverUrl} from '../.github/ci/singleton-protocol.mjs';

const admission=admitSingletonTest('test/runtime-next-workload-database-native.test.ts');
if(admission.mode!=='full-ci-singleton'||!admission.workloadDatabase||!admission.workloadContext)throw Error('Native workload database custody binding required');
const custody=admission.workloadDatabase,context=admission.workloadContext;

const client=(url:string)=>postgres(url,{max:1,connect_timeout:3,connection:{statement_timeout:2000,lock_timeout:300}});
type Client=ReturnType<typeof client>;
async function refusalCode(run:()=>PromiseLike<unknown>){
 try{await run();return 'unexpected-success';}
 catch(error){return typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'unclassified';}
}
async function refuseConnection(url:string,code:string){
 const db=client(url);
 try{expect(await refusalCode(()=>db`select 1`)).toBe(code);}
 finally{await db.end({timeout:2});}
}
async function nativeSession(db:Client){
 const [row]=await db`select session_user::text as login,current_user::text as role,current_database() as database,
  (select oid::text from pg_database where datname=current_database()) as oid,
  host(inet_server_addr()) as host,inet_server_port() as port,
  r.rolsuper as superuser,r.rolbypassrls as bypass,r.rolcreatedb as "createDb",r.rolcreaterole as "createRole",
  r.rolreplication as replication,r.rolconnlimit as "connectionLimit",
  current_setting('transaction_read_only')='on' as "readOnly"
  from pg_roles r where r.rolname=current_user`;
 return row;
}

it(NATIVE_WORKLOAD_DATABASE_CASE,async()=>{
 const ownerUrl=process.env.MIGRATION_DATABASE_URL!,appUrl=process.env.DATABASE_URL!,observerUrl=validateNativeWorkloadObserverUrl(process.env);
 const owner=client(ownerUrl),app=client(appUrl),observer=client(observerUrl);
 try{
  const ownerSession=await nativeSession(owner),appSession=await nativeSession(app),observerSession=await nativeSession(observer);
  expect(ownerSession).toMatchObject({login:'postgres',role:'postgres',superuser:true});
  expect(appSession).toMatchObject({login:'ai_hr_app',role:'ai_hr_app',superuser:false,bypass:false,createDb:false,createRole:false,replication:false});
  expect(observerSession).toMatchObject({login:NATIVE_WORKLOAD_OBSERVER,role:NATIVE_WORKLOAD_OBSERVER,superuser:false,bypass:false,
   createDb:false,createRole:false,replication:false,connectionLimit:2,readOnly:true});
  expect(ownerSession.oid).toMatch(/^[1-9][0-9]*$/);
  for(const session of [ownerSession,appSession,observerSession])expect(session).toMatchObject({database:'ai_hr_test_w1',oid:ownerSession.oid,host:'127.0.0.1',port:5433});
  const [identity]=await owner`select system_identifier::text as id from pg_control_system()`;
  expect(createHash('sha256').update(identity.id).digest('hex')).toBe(custody.systemIdentifierSha256);
  const [permissions]=await app`select row_security_active('public.employment') as rls,
   has_table_privilege(current_user,'public.employment','SELECT') as readable`;
  expect(permissions).toEqual({rls:true,readable:true});
  const [statistics]=await observer`select pg_has_role(current_user,'pg_read_all_stats','USAGE') as readable`;
  expect(statistics.readable).toBe(true);
  const [statements]=await observer`select count(*)::int as statements from pg_stat_statements`;
  expect(Number.isSafeInteger(statements.statements)&&statements.statements>=0).toBe(true);
  expect(await refusalCode(()=>observer`select pg_stat_statements_reset()`)).toBe('42501');
  expect(await refusalCode(()=>observer`select id from public.employment limit 1`)).toBe('42501');
  expect(await refusalCode(()=>observer`set role postgres`)).toBe('42501');
  expect(await refusalCode(()=>observer`set role pg_read_all_stats`)).toBe('42501');
  expect(await refusalCode(()=>app`set role postgres`)).toBe('42501');

  expect(process.env.PGPASSWORD===undefined).toBe(true);
  for(const raw of [ownerUrl,appUrl,observerUrl]){
   const missing=new URL(raw);missing.password='';await refuseConnection(missing.href,'28P01');
  }
  for(const raw of [appUrl,observerUrl]){
   const crossRole=new URL(raw);crossRole.username='postgres';await refuseConnection(crossRole.href,'28P01');
   const foreignDb=new URL(raw);foreignDb.pathname='/ai_hr_dev';await refuseConnection(foreignDb.href,'28000');
  }
  const foreignOwnerDb=new URL(ownerUrl);foreignOwnerDb.pathname='/template1';await refuseConnection(foreignOwnerDb.href,'28000');
 }finally{
  const closures=await Promise.allSettled([owner.end({timeout:2}),app.end({timeout:2}),observer.end({timeout:2})]);
  if(closures.some(row=>row.status==='rejected'))throw Error('Native workload test client closure refused');
 }
 writeFileSync(join(admission.evidenceDirectory,NATIVE_WORKLOAD_DATABASE_MEMBER),JSON.stringify({
  kind:'NATIVE_WORKLOAD_DATABASE_CUSTODY_COMPONENT_ONLY',...context,unit:admission.databaseUnit,
  systemIdentifierSha256:custody.systemIdentifierSha256,containerIdentitySha256:custody.containerIdentitySha256,
  authenticatedRoles:3,connectionRefusals:8,privilegeRefusals:5,clientClosures:3,releaseEligible:false,
 })+'\n',{flag:'wx',mode:0o600});
});
