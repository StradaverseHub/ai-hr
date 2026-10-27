/** Explicit LOCAL experience coordinator, source-only until actually invoked by the owner.
 * node --env-file=/private/external.env --import tsx /absolute/owned/scripts/dev-browser-ai-delivery.mjs
 * Acquires one atomic COMPLETE reservation; never wrap it in another resource lease.
 * No seed/reset/drop/reuse, no remote provider, no browser PASS, no release/deployment. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {AI_DELIVERY_BROWSER_TARGET as target,assertAiDeliveryBrowserAdmission} from './ai-delivery-browser-fixture.ts';
const mainwt='/Users/zenlam/Projects/ai-hr/.claude/worktrees/mainwt',filename=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(filename),'..');
const tsxLoader=createRequire(path.join(root,'package.json')).resolve('tsx');
const worker=process.argv.slice(2);if(worker.length>1||worker.length===1&&worker[0]!=='--held-lock-worker')throw Error('Use the closed browser coordinator invocation.');
if(process.env.NODE_ENV==='production')throw Error('Development only.');
const out=path.join(root,target.scratchpad),stopFile=path.join(out,'browser.stop'),state=path.join(os.homedir(),'.aihr-gate-state');
// Next automatically reloads these files. Refuse rather than silently rehydrate scrubbed credentials.
for(const name of ['.env','.env.local','.env.development','.env.development.local'])if(fs.existsSync(path.join(root,name)))throw Error('Use external private env input; automatic application env files must be absent in this owned checkout.');
const appUrl=new URL(process.env.DATABASE_URL??''),ownerUrl=new URL(process.env.MIGRATION_DATABASE_URL??'');
for(const url of [appUrl,ownerUrl])if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/'+target.database||url.hash||[...url.searchParams].some(([key,value])=>key!=='sslmode'||value!=='disable'))throw Error('Exact named disposable loopback database URLs required; no retargeting.');
if(decodeURIComponent(appUrl.username)!=='ai_hr_app'||appUrl.username===ownerUrl.username)throw Error('Separate restricted application and migration credentials required.');
if(!fs.existsSync(path.join(root,'node_modules'))||fs.lstatSync(path.join(root,'node_modules')).isSymbolicLink())throw Error('Provision real owned worktree dependencies separately; no installs or links are performed here.');
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','USER','SHELL'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
const fixtureSecret=process.env.AI_DELIVERY_BROWSER_FIXTURE_SECRET??randomBytes(32).toString('hex');if(!/^[a-f0-9]{64}$/.test(fixtureSecret))throw Error('Use a dedicated 32-byte hex fictional-fixture key.');
Object.assign(env,{NODE_ENV:'development',AUTH_PROVIDER:'workos',ALLOW_DEMO_SESSION:'true',DATABASE_URL:appUrl.toString(),MIGRATION_DATABASE_URL:ownerUrl.toString(),TEST_DATABASE_URL:appUrl.toString(),TEST_MIGRATION_DATABASE_URL:ownerUrl.toString(),TEST_DB_NAMESPACE:target.namespace,PORT:String(target.port),NEXT_PUBLIC_APP_URL:`http://127.0.0.1:${target.port}`,DEV_USER_ID:'',DEV_TENANT_ID:'',NOTIFICATIONS_ENABLED:'false',IDENTITY_EMAIL_SOCKET:path.join(out,'no-mail.sock'),NEXT_TELEMETRY_DISABLED:'1',AI_DELIVERY_BROWSER_FIXTURE_SECRET:fixtureSecret,AI_CONFIG_SECRET:fixtureSecret,ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',GOOGLE_API_KEY:'',GEMINI_API_KEY:'',OPENROUTER_API_KEY:'',AI_DRAFT_MODEL:'',WORKOS_API_KEY:'',WORKOS_CLIENT_ID:'',WORKOS_COOKIE_PASSWORD:'',AIHR_TEST_SLOTS:'2',AIHR_LOCK_DIR:path.join(state,'locks')});
fs.mkdirSync(out,{recursive:true,mode:0o700});if(fs.realpathSync(out)!==out||fs.lstatSync(out).isSymbolicLink())throw Error('Owned canonical private scratchpad required.');
if(!worker.length){
 // One coordinator owns all resources before spawning its entire service/fixture descendant tree.
 const child=spawn('python3',[path.join(root,'scripts/local-resource-lock.py'),'--test-slots','2','--database',target.leaseName,'--',process.execPath,'--import',tsxLoader,filename,'--held-lock-worker'],{cwd:mainwt,env,stdio:'inherit',detached:true});
 const stop=()=>{fs.writeFileSync(stopFile,'Explicit coordinator stop requested.\n',{mode:0o600});if(child.pid)try{process.kill(child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?1:0)));});
}else{
 assertAiDeliveryBrowserAdmission();
 if(Number(execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim())!==process.pid)throw Error('Atomic coordinator isolated worker process group required.');
 const git=args=>execFileSync('git',['-C',root,...args],{cwd:mainwt,encoding:'utf8'}).trim();
 const candidate=git(['rev-parse','HEAD']);
 const frozen=()=>{assertAiDeliveryBrowserAdmission();if(git(['rev-parse','HEAD'])!==candidate||git(['status','--porcelain','--untracked-files=all']))throw Error('Frozen candidate changed; preserve resources/evidence and stop.');};
 frozen();
 if(fs.existsSync(stopFile)||fs.existsSync(path.join(out,'fixture.json'))||fs.existsSync(path.join(out,'browser-current.json')))throw Error('Prior preparation/stop evidence exists; no automatic reuse/reset/removal.');
 const attempt=path.join(out,'attempt-'+randomUUID());fs.mkdirSync(attempt,{mode:0o700});
 const write=(name,value)=>fs.writeFileSync(path.join(attempt,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 write('source.json',{candidate,root,target,sourceMode:'next_dev_not_release_build',acceptance:'UNVERIFIED',startedAt:new Date().toISOString()});
 let server,job,serverFd,admin,targetDb,stopping=false,failed=false,ownedServerPid;
 const stop=()=>{stopping=true;fs.writeFileSync(stopFile,'Explicit owned browser shutdown requested.\n',{mode:0o600});};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 // The Python coordinator starts this worker in its own session. Descendants MUST stay in
 // that group so abnormal worker death cannot release leases while an escaped server survives.
 const members=()=>execFileSync('ps',['-Ao','pid=,pgid=,stat='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/)).filter(([pid,pgid,status])=>Number(pgid)===process.pid&&Number(pid)!==process.pid&&!status.startsWith('Z')).map(([pid])=>Number(pid));
 const signal=(_child,sig)=>{for(const pid of members())if(members().includes(pid))try{process.kill(pid,sig);}catch(error){if(error.code!=='ESRCH')throw error;}};
 async function stopOwned(child){if(!child)return;signal(child,'SIGTERM');const deadline=Date.now()+7500;while(members().length&&Date.now()<deadline)await sleep(100);if(members().length)signal(child,'SIGKILL');while(members().length)await sleep(250);}
 async function portFree(){const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',()=>reject(Error('Reserved3177 is occupied; no process will be killed.')));probe.listen({host:'127.0.0.1',port:target.port,exclusive:true},()=>probe.close(resolve));});}
 async function run(command,args,label,limit=180000){
  frozen();if(stopping||fs.existsSync(stopFile))throw Error('Stopped before '+label);const fd=fs.openSync(path.join(attempt,label+'.log'),'wx',0o600);
  const child=spawn(command,args,{cwd:mainwt,env,stdio:['ignore',fd,fd],detached:false});job=child;let timedOut=false,forceTimer;
  const terminate=()=>{signal(child,'SIGTERM');forceTimer??=setTimeout(()=>signal(child,'SIGKILL'),7500);};
  const timer=setTimeout(()=>{timedOut=true;terminate();},limit),cancel=setInterval(()=>{if(stopping||fs.existsSync(stopFile))terminate();},250);
  try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?1:0)));});if(timedOut||code!==0||stopping||fs.existsSync(stopFile))throw Error(label+' failed/stopped; private raw log retained, no PASS.');frozen();}finally{clearTimeout(timer);clearTimeout(forceTimer);clearInterval(cancel);await stopOwned(child);fs.closeSync(fd);job=undefined;}
 }
 try{
  await portFree();
  const {default:postgres}=await import('postgres');const adminUrl=new URL(ownerUrl);adminUrl.pathname='/postgres';
  admin=postgres(adminUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
  const [physical]=await admin`select current_user as name,host(inet_server_addr()) as address,inet_server_port() as port,rolsuper,rolcreatedb from pg_roles where rolname=current_user`;
  if(physical?.name!==decodeURIComponent(ownerUrl.username)||physical.port!==5433||!['127.0.0.1','::1'].includes(physical.address)||!physical.rolsuper&&!physical.rolcreatedb)throw Error('Local database-creation principal proof failed.');
  if((await admin`select datname from pg_database where datname=${target.database}`).length)throw Error('Named database already exists; preserve it and refuse.');
  frozen();await admin.unsafe('CREATE DATABASE aihr_ai_delivery_browser_20261027');await admin.end();admin=undefined;
  const migrationConfig=path.join(attempt,'drizzle-ai-delivery.config.ts');
  fs.writeFileSync(migrationConfig,`import {defineConfig} from 'drizzle-kit';\nconst url=process.env.MIGRATION_DATABASE_URL;if(!url||new URL(url).pathname!=='/${target.database}')throw Error('Exact local browser target required');\nexport default defineConfig({schema:${JSON.stringify(path.join(root,'db/schema.ts'))},out:${JSON.stringify(path.join(root,'db/migrations'))},dialect:'postgresql',dbCredentials:{url},strict:true});\n`,{flag:'wx',mode:0o600});
  await run('pnpm',['--dir',root,'exec','drizzle-kit','migrate','--config',migrationConfig],'migrate',300000);
  const {readMigrationFiles}=await import('drizzle-orm/migrator');const expected=readMigrationFiles({migrationsFolder:path.join(root,'db/migrations')});
  targetDb=postgres(ownerUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
  const applied=await targetDb`select hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
  if(applied.length!==expected.length||applied.some((row,index)=>row.hash!==expected[index].hash||row.created_at!==String(expected[index].folderMillis)))throw Error('Actual migration tuples differ; retain raw evidence.');
  write('migration-tuples.json',{candidate,tuples:applied,journalSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'db/migrations/meta/_journal.json'))).digest('hex')});
  const configs=await targetDb`select to_regclass('public.ai_provider_config')::text as name`;
  if(!configs[0]?.name)throw Error('Native provider configuration schema missing.');
  if(configs[0]?.name){const active=await targetDb`select count(*)::int as n from public.ai_provider_config`;if(active[0]?.n!==0)throw Error('Provider configuration exists in new target; refuse.');}
  await targetDb.end();targetDb=undefined;
  await run(process.execPath,['--import',tsxLoader,path.join(root,'scripts/ai-delivery-browser-fixture.ts')],'fixture',180000);
  const fixtureFile=path.join(out,'fixture.json'),stat=fs.lstatSync(fixtureFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)||stat.size>1048576)throw Error('Private fixture identity is unavailable.');
  const fixture=JSON.parse(fs.readFileSync(fixtureFile,'utf8'));
  if(fixture.state!=='prepared_not_experienced'||fixture.candidate!==candidate||fixture.target.database!==target.database||!fixture.actors?.hr?.userId||!fixture.tenantId)throw Error('Fixture/source target differs.');
  env.DEV_TENANT_ID=fixture.tenantId;env.DEV_USER_ID=''; // Header cookie must be selected; commands cannot assume an HR fallback.
  await portFree();frozen();serverFd=fs.openSync(path.join(attempt,'next-dev.log'),'wx',0o600);
  const appEnv={...env};for(const key of ['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL','TEST_DATABASE_URL','AI_DELIVERY_BROWSER_FIXTURE_SECRET'])delete appEnv[key];
  server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev',root,'--hostname','127.0.0.1','--port',String(target.port)],{cwd:mainwt,env:appEnv,stdio:['ignore',serverFd,serverFd],detached:false});
  server.once('error',()=>{stopping=true;});
  ownedServerPid=server.pid;if(!Number.isSafeInteger(ownedServerPid))throw Error('Owned server did not start.');
  const current={candidate,root,target,serverPid:ownedServerPid,attempt:path.basename(attempt),fixtureSha256:createHash('sha256').update(fs.readFileSync(fixtureFile)).digest('hex'),applicationAcceptance:'UNVERIFIED',healthReady:false};
  fs.writeFileSync(path.join(out,'browser-current.json'),JSON.stringify(current,null,2)+'\n',{flag:'wx',mode:0o600});
  // Only loopback readiness. This proves DB/application health, NOT render/auth/action experience.
  const readyDeadline=Date.now()+120000;let ready=false;
  while(!ready&&!stopping&&Date.now()<readyDeadline){frozen();if(server.exitCode!==null||server.signalCode!==null)throw Error('Owned Next process exited; retain private log.');try{const response=await fetch(`http://127.0.0.1:${target.port}/health`,{redirect:'error',signal:AbortSignal.timeout(5000),cache:'no-store'});ready=response.status===200;}catch{}if(!ready)await sleep(500);}
  if(!ready)throw Error('Loopback health did not become ready; no browser PASS.');write('health-ready.json',{candidate,at:new Date().toISOString(),healthReady:true,applicationAcceptance:'UNVERIFIED'});
  console.log(`Owned fictional app ready at http://127.0.0.1:${target.port}; choose an actual fixture user in the existing header. Browser acceptance remains UNVERIFIED.`);
  console.log(`Stop with ${stopFile}. The SAME complete reservation stays held until owned children disappear. No automatic database teardown.`);
  const deadline=Date.now()+2*60*60*1000;
  while(!stopping&&!fs.existsSync(stopFile)&&Date.now()<deadline){frozen();if(server.exitCode!==null||server.signalCode!==null)throw Error('Owned server exited during experience lifetime.');await sleep(500);}
 }catch{failed=true;process.exitCode=1;console.error('Owned AI delivery browser failed/refused; preserve named private logs/database. No experience or release PASS claimed.');}
 finally{
  await stopOwned(job);await stopOwned(server);if(members().length)await stopOwned({pid:process.pid});if(serverFd!==undefined)fs.closeSync(serverFd);if(admin)await admin.end();if(targetDb)await targetDb.end();
  write('owned-stopped.json',{candidate,target,serverPid:ownedServerPid??null,ownedChildrenStopped:true,failed,stoppedAt:new Date().toISOString(),databasePreserved:true,applicationAcceptance:'UNVERIFIED'});
 }
}
