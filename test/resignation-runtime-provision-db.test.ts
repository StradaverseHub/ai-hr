/** Real CLI custody in a uniquely owned DB; never delete/rotate the worker's shared verifier singleton. */
import {expect,it} from 'vitest';
import postgres from 'postgres';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {resignationRuntimeKey} from '../lib/resignation-runtime-proof';
const success='Resignation runtime verifier provisioned.\n';
const refusal='Resignation runtime verifier provisioning refused. Check protected configuration and owner access.\n';
const key='a'.repeat(64),otherKey='b'.repeat(64);

it('provisions once as the restricted owner and refuses missing config/table, another key/role and a held verifier lock without changing bytes',async()=>{
 const adminUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(adminUrl.hostname);expect(appUrl.hostname).toBe(adminUrl.hostname);expect(appUrl.port).toBe(adminUrl.port);expect(appUrl.username).toBe('ai_hr_app');expect(appUrl.search).toBe('');expect(appUrl.hash).toBe('');
 // Existing native test-role fixture owns role creation/admission. Never create or elevate a cluster role here.
 expect(adminUrl.username).toBe('postgres');expect(adminUrl.password).toBe('');expect(adminUrl.search).toBe('');
 adminUrl.pathname='/postgres';const admin=postgres(adminUrl.toString(),{max:1,connect_timeout:10,onnotice:()=>{}});
 const database='ai_hr_resignation_provision_'+randomUUID().replaceAll('-',''),fixtureRoot=resolve('scratchpad');mkdirSync(fixtureRoot,{recursive:true});const dir=mkdtempSync(join(fixtureRoot,'runtime-provision-'));
 const restrictedUrl=new URL(adminUrl);restrictedUrl.pathname='/'+database;restrictedUrl.username='ai_hr_owner';restrictedUrl.password='';appUrl.pathname='/'+database;
 const owner=postgres(restrictedUrl.toString(),{max:1,connect_timeout:10,onnotice:()=>{}}),locker=postgres(restrictedUrl.toString(),{max:1,connect_timeout:10,onnotice:()=>{}}),application=postgres(appUrl.toString(),{max:1,connect_timeout:10,onnotice:()=>{}});
 let created=false;
 const childEnvironment=()=>{const env={...process.env,NODE_OPTIONS:''};for(const name of Object.keys(env))if(name.startsWith('AUTH_')||name==='MIGRATION_DATABASE_URL'||['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGOPTIONS'].includes(name))delete env[name];return env;};
 const run=async(options:{url?:string;sessionKey?:string;missingKey?:boolean;origin?:string}={})=>{
  const envPath=join(dir,'operator-'+randomUUID()+'.env');writeFileSync(envPath,'MIGRATION_DATABASE_URL='+(options.url??restrictedUrl.toString())+'\nAUTH_PUBLIC_ORIGIN='+(options.origin??'https://runtime.example.test')+'\n'+(options.missingKey?'':'AUTH_SESSION_KEY='+(options.sessionKey??key)+'\n'),{mode:0o600});
  return new Promise<{status:number|null;stdout:string;stderr:string;timedOut:boolean}>((resolveResult,reject)=>{
   const child=spawn(process.execPath,['--env-file='+envPath,'--import','tsx','scripts/provision-resignation-runtime.ts'],{cwd:process.cwd(),env:childEnvironment(),stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='',timedOut=false,overflow=false;
   const collect=(kind:'stdout'|'stderr',chunk:Buffer)=>{if(kind==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();if(stdout.length+stderr.length>16384){overflow=true;child.kill('SIGKILL');}};
   child.stdout.on('data',(chunk:Buffer)=>collect('stdout',chunk));child.stderr.on('data',(chunk:Buffer)=>collect('stderr',chunk));
   // Deliberately shorter than the 60s statement cap: a 10s lock refusal must be a normal exit, never our kill.
   const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},30000);
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('close',status=>{clearTimeout(timer);if(overflow)return reject(Error('Provisioning CLI output exceeded its fixed bound.'));resolveResult({status,stdout,stderr,timedOut});});
  });
 };
 const refused=(result:Awaited<ReturnType<typeof run>>)=>{expect(result.timedOut).toBe(false);expect(result.status).toBe(1);expect(result.stdout==='').toBe(true);expect(result.stderr===refusal).toBe(true);};
 const noDisclosure=(result:Awaited<ReturnType<typeof run>>)=>{const output=result.stdout+result.stderr;for(const value of [key,otherKey,restrictedUrl.toString(),appUrl.toString()])expect(output.includes(value)).toBe(false);};
 const unchanged=async()=>{const[row]=await owner<{count:number;matches:boolean}[]>`select count(*)::integer as count,coalesce(bool_and(secret=${resignationRuntimeKey(key)}::bytea),false) as matches from app.resignation_runtime_verifier`;expect(row).toEqual({count:1,matches:true});};
 try{
  await admin.unsafe(`CREATE DATABASE "${database}" OWNER ai_hr_owner`);created=true;
  const[role]=await owner<{role:string;superuser:boolean;bypass:boolean;createRole:boolean}[]>`select current_user as role,rolsuper as superuser,rolbypassrls as bypass,rolcreaterole as "createRole" from pg_roles where rolname=current_user`;
  expect(role).toEqual({role:'ai_hr_owner',superuser:false,bypass:false,createRole:false});
  // Minimal native CLI fixture, not a full migration rehearsal: exact immutable ownership function and verifier block.
  await owner.unsafe('CREATE SCHEMA app AUTHORIZATION ai_hr_owner');await owner.unsafe('GRANT USAGE ON SCHEMA app TO ai_hr_app');
  await owner.unsafe('CREATE TABLE public.app_user(id uuid PRIMARY KEY)');await owner.unsafe('CREATE TABLE public.tenant(id uuid PRIMARY KEY)');
  const ownership=readFileSync('db/migrations/0312_invitation_privilege_escalation.sql','utf8').match(/CREATE OR REPLACE FUNCTION app\.acting_as_owner\(\)[\s\S]*?\$\$;/)?.[0];expect(ownership).toBeTruthy();await owner.unsafe(ownership!);
  const missingTable=await run();refused(missingTable);noDisclosure(missingTable);expect((await owner`select to_regclass('app.resignation_runtime_verifier') as relation`)[0].relation).toBeNull();
  const files=readdirSync('db/migrations').filter(name=>/^\d+_resignation_journey\.sql$/.test(name));expect(files).toHaveLength(1);
  const native=readFileSync(join('db/migrations',files[0]),'utf8'),start=native.indexOf('CREATE TABLE app.resignation_runtime_verifier('),end=native.indexOf('REVOKE ALL ON app.resignation_runtime_verifier,app.resignation_runtime_state FROM PUBLIC,ai_hr_app;',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);const exact=native.slice(start,end)+'REVOKE ALL ON app.resignation_runtime_verifier,app.resignation_runtime_state FROM PUBLIC,ai_hr_app;';
  for(const statement of exact.replaceAll('--> statement-breakpoint','').split(';').map(s=>s.trim()).filter(Boolean))await owner.unsafe(statement);
  for(const options of [{url:''},{missingKey:true},{sessionKey:'not-a-session-key'},{origin:'http://runtime.example.test'}]){const result=await run(options);refused(result);noDisclosure(result);expect((await owner`select count(*)::integer as count from app.resignation_runtime_verifier`)[0].count).toBe(0);}
  for(let n=0;n<2;n++){const result=await run();expect(result.status).toBe(0);expect(result.timedOut).toBe(false);expect(result.stdout===success).toBe(true);expect(result.stderr==='').toBe(true);noDisclosure(result);await unchanged();}
  const[appRole]=await application<{role:string;database:string;owner:boolean;canRead:boolean}[]>`select current_user as role,current_database() as database,pg_has_role(current_user,'ai_hr_owner','MEMBER') as owner,has_table_privilege(current_user,'app.resignation_runtime_verifier','SELECT') as "canRead"`;expect(appRole).toEqual({role:'ai_hr_app',database,owner:false,canRead:false});
  for(const options of [{sessionKey:otherKey},{url:appUrl.toString()}]){const result=await run(options);refused(result);noDisclosure(result);await unchanged();}
  // Intentional contention is ONLY in this owned DB. No parent transaction holds the table during normal CLI cases.
  let release!:()=>void,ready!:()=>void;const releaseLock=new Promise<void>(resolveLock=>{release=resolveLock;}),locked=new Promise<void>(resolveLock=>{ready=resolveLock;});
  const holding=locker.begin(async tx=>{await tx.unsafe('LOCK TABLE app.resignation_runtime_verifier IN EXCLUSIVE MODE');ready();await releaseLock;});
  try{await Promise.race([locked,holding.then(()=>{throw Error('Fixture lock ended before admission.');})]);const result=await run();refused(result);noDisclosure(result);}finally{release();await holding;}
  await unchanged();
 }finally{
  try{await Promise.allSettled([owner.end({timeout:5}),locker.end({timeout:5}),application.end({timeout:5})]);if(created)await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);}
  finally{try{await admin.end({timeout:5});}finally{rmSync(dir,{recursive:true,force:true});}}
 }
},90000);
