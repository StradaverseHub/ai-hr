/** Coordinator entry (owns both slots + dev DB until all children stop):
 * node --env-file=/absolute/own/.env.local --import tsx /absolute/own/scripts/dev-browser-system-testing.mjs
 * Do NOT put an outer both-slot wrapper around this entry: it already acquires both slots.
 * Held-lock worker, only for coordinator/debugging: same command with --held-lock-worker.
 * That worker proves all three named lock files are live before any DB/build/server work.
 * STOP: create scratchpad/board19-profile-testing/browser.stop in this derived worktree.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {SYSTEM_TESTING_BROWSER_TARGET,systemTestingBrowserOptions} from './system-testing-browser-target.mjs';
import {prepareSystemTestingBuild,systemTestingCompileEnvironment} from './improve/system-testing-manifest.ts';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard.ts';
const filename=fileURLToPath(import.meta.url),root=fileURLToPath(new URL('..',import.meta.url));
const out=path.join(root,'scratchpad/board19-profile-testing'),stopFile=path.join(out,'browser.stop');
const {database,port,namespace}=SYSTEM_TESTING_BROWSER_TARGET;
const lockNames={a:namespace+'-browser-a',b:namespace+'-browser-b',db:namespace+'-browser-db'};
const gateState=path.join(os.homedir(),'.aihr-gate-state');
const options=systemTestingBrowserOptions(process.argv.slice(2),{allowWorker:true});
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER!=='workos')throw new Error('Local fictional demo authentication only.');
if(!fs.existsSync(path.join(root,'node_modules')) || fs.lstatSync(path.join(root,'node_modules')).isSymbolicLink())throw new Error('Parent must provision real worktree dependencies first; this runner never installs or links them.');
function configuredUrl(key){try{return new URL(process.env[key]??'');}catch{throw new Error('Valid local database credentials are required.');}}
const appUrl=configuredUrl('DATABASE_URL'),ownerUrl=configuredUrl('MIGRATION_DATABASE_URL');
for(const url of [appUrl,ownerUrl])if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.hash||[...url.searchParams].some(([key,value])=>key!=='sslmode'||value!=='disable'))throw new Error('Only localhost:5433 credentials may be retargeted to the named disposable database.');
if(decodeURIComponent(appUrl.username)!=='ai_hr_app' || appUrl.username===ownerUrl.username)throw new Error('Use the non-owner ai_hr_app role for the application and separate migration credentials.');
appUrl.pathname='/'+database;ownerUrl.pathname='/'+database;
const env={...process.env,NOTIFICATIONS_ENABLED:'false',IDENTITY_EMAIL_SOCKET:path.join(out,'no-mail.sock'),NEXT_PUBLIC_APP_URL:'http://127.0.0.1:'+port,NODE_ENV:'development',DATABASE_URL:appUrl.toString(),MIGRATION_DATABASE_URL:ownerUrl.toString(),TEST_DB_NAMESPACE:namespace,PORT:port,DEV_TENANT_ID:DEMO_TENANT_ID,ALLOW_DEMO_SESSION:'true',AUTH_PROVIDER:'workos',SEED_MAY_DESTROY_OTHER_TENANTS:''};
// Explicit lock locations/slot count prevent inherited override variables from weakening coordination.
const lockEnv={...env,AIHR_TEST_SLOTS:'2',AIHR_LOCK_DIR:path.join(gateState,'locks')};
fs.mkdirSync(out,{recursive:true});
if(!options.heldLockWorker) {
  if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
  const args=[path.join(gateState,'testlock.sh'),lockNames.a,'--','bash',path.join(gateState,'testlock.sh'),lockNames.b,'--','bash',path.join(gateState,'devdb-lock.sh'),lockNames.db,'--',process.execPath,'--import','tsx',filename,'--held-lock-worker',...(options.reviewRequired?['--review-required']:[])];
  // Isolate lock wrappers from terminal Ctrl-C: only the coordinator receives it and requests a
  // stop-file handoff. A wrapper's own signal trap must not release before owned server cleanup.
  const child=spawn('bash',args,{cwd:root,env:lockEnv,stdio:'inherit',detached:true});
  const stop=()=>{fs.writeFileSync(stopFile,'Coordinator requested a graceful stop.\n');};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?1:0)));});
  process.exitCode=code; // wrappers release only after the held worker returns after child cleanup
} else {
  const ancestors=new Set();
  let ancestor=process.ppid;
  for(let depth=0;ancestor>1&&depth<64;depth++) {
    if(ancestors.has(ancestor))throw new Error('Invalid coordinator process ancestry.');
    ancestors.add(ancestor);
    ancestor=Number(execFileSync('ps',['-o','ppid=','-p',String(ancestor)],{encoding:'utf8'}).trim());
    if(!Number.isSafeInteger(ancestor)||ancestor<0)throw new Error('Cannot prove coordinator process ancestry.');
  }
  function proveLock(directory,expected) {
    for(const entry of fs.readdirSync(directory).filter(name=>name.startsWith('slot.'))) {
      const dir=path.join(directory,entry);
      try {const name=fs.readFileSync(path.join(dir,'name'),'utf8').trim(),pid=Number(fs.readFileSync(path.join(dir,'pid'),'utf8').trim());if(name===expected && Number.isSafeInteger(pid)&&pid>1&&ancestors.has(pid)){process.kill(pid,0);return;}}catch{}
    }
    throw new Error(`Required live coordinator lock is missing: ${expected}`);
  }
  proveLock(path.join(gateState,'locks'),lockNames.a);proveLock(path.join(gateState,'locks'),lockNames.b);proveLock(path.join(gateState,'devdb-locks'),lockNames.db);
  const git=(args)=>execFileSync('git',['-C',root,...args],{cwd:root,encoding:'utf8'}).trim();
  if(git(['status','--porcelain']))throw new Error('Freeze a clean owned candidate before the browser runner.');
  const candidate=git(['rev-parse','HEAD']),attemptDirectory='attempt-'+randomUUID(),attemptOut=path.join(out,attemptDirectory);
  fs.mkdirSync(attemptOut,{mode:0o700});
  let server,activeJob,stopping=false,serverFd,forceStopTimer;
  const overallDeadline=Date.now()+45*60*1000;
  const overallWatchdog=setTimeout(()=>requestStop(),45*60*1000);overallWatchdog.unref();
  let postgresAdmin,postgresTarget;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function groupExists(child){if(!child?.pid)return false;try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
  function signalOwned(child,signal){if(groupExists(child)){try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}}
  const requestStop=()=>{stopping=true;fs.writeFileSync(stopFile,'Held worker received a graceful stop.\n');signalOwned(activeJob,'SIGTERM');signalOwned(server,'SIGTERM');forceStopTimer??=setTimeout(()=>{signalOwned(activeJob,'SIGKILL');signalOwned(server,'SIGKILL');},5000);};
  process.on('SIGINT',requestStop);process.on('SIGTERM',requestStop);
  async function stopOwned(child) {
    if(!groupExists(child))return;
    signalOwned(child,'SIGTERM');
    const deadline=Date.now()+5000;while(groupExists(child) && Date.now()<deadline)await sleep(100);
    if(groupExists(child))signalOwned(child,'SIGKILL');
    let reportAt=Date.now()+30000;
    while(groupExists(child)) {
      // Never release shared locks while an owned child group still exists.
      if(Date.now()>=reportAt){console.error('Waiting for the owned process group to disappear; all three locks remain held.');reportAt=Date.now()+30000;}
      await sleep(250);
    }
  }
  async function assertPortFree() {
    const probe=net.createServer();
    await new Promise((resolve,reject)=>{probe.once('error',()=>reject(new Error(`Reserved port ${port} is occupied; no process will be killed.`)));probe.listen({host:'127.0.0.1',port:Number(port),exclusive:true},()=>probe.close(resolve));});
  }
  function checkCandidate(){if(git(['rev-parse','HEAD'])!==candidate || git(['status','--porcelain']))throw new Error('Candidate changed during verification; stop and reassess evidence.');}
  async function run(command,args,label,limit=120000) {
    if(stopping||fs.existsSync(stopFile))throw new Error('Browser run stopped before '+label);
    checkCandidate();const fd=fs.openSync(path.join(attemptOut,label+'.log'),'w',0o600);
    let timedOut=false,forceTimer;
    const child=spawn(command,args,{cwd:root,env,stdio:['ignore',fd,fd],detached:true});activeJob=child;
    const timer=setTimeout(()=>{timedOut=true;signalOwned(child,'SIGTERM');forceTimer??=setTimeout(()=>signalOwned(child,'SIGKILL'),5000);},limit);
    const cancel=setInterval(()=>{if(fs.existsSync(stopFile)){stopping=true;signalOwned(child,'SIGTERM');forceTimer??=setTimeout(()=>signalOwned(child,'SIGKILL'),5000);}},500);
    try {
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?1:0)));});
      if(timedOut||code!==0)throw new Error(`${label} failed or timed out; inspect its named log. No PASS claimed.`);
      checkCandidate();
    }finally {clearTimeout(timer);clearTimeout(forceTimer);clearInterval(cancel);await stopOwned(child);fs.closeSync(fd);activeJob=undefined;}
  }
  function manifestFromLog(name) {
    const content=fs.readFileSync(path.join(attemptOut,name+'.log'),'utf8'),marker='SYSTEM_TESTING16_MANIFEST\n',start=content.indexOf(marker);
    if(start<0)throw new Error('Fixture manifest marker missing.');return JSON.parse(content.slice(start+marker.length));
  }
  try {
    if(fs.existsSync(stopFile))throw new Error('Run was stopped while waiting for locks.');
    if(fs.existsSync(path.join(out,'browser-manifest.json')))throw new Error('A prior browser target exists; preserve it. This initial runner has no resume/reset path.');
    const journal=JSON.parse(fs.readFileSync(path.join(root,'db/migrations/meta/_journal.json'),'utf8'));
    if(!journal.entries.some(e=>e.idx===561&&e.when===1791900000041&&e.tag==='0561_versioned_system_testing'))throw new Error('Parent must integrate the real0561 journal after prerequisites before execution.');
    const compiled=prepareSystemTestingBuild({worktree:root,candidate,buildRecordId:randomUUID()});
    if(!options.reviewRequired)Object.assign(env,systemTestingCompileEnvironment(compiled));
    else for(const key of Object.keys(systemTestingCompileEnvironment(compiled)))delete env[key];
    const identityFile='dev-source-identity-'+compiled.identity.buildRecordId+'.json';
    fs.writeFileSync(path.join(out,identityFile),JSON.stringify({mode:'dev_only_not_production_build',...compiled,reviewRequiredRequested:options.reviewRequired},null,2)+'\n',{flag:'wx',mode:0o600});
    env.SYSTEM_TESTING_FIXTURE_COORDINATOR_PID=String(process.pid);env.SYSTEM_TESTING_FIXTURE_CANDIDATE=candidate;
    await assertPortFree();
    const {default:postgres}=await import('postgres');
    const adminUrl=new URL(ownerUrl);adminUrl.pathname='/postgres';postgresAdmin=postgres(adminUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
    const existing=await postgresAdmin`select datname from pg_database where datname=${database}`;
    if(!existing.length)await postgresAdmin.unsafe('CREATE DATABASE ai_hr_board19_profile_testing_browser');
    await postgresAdmin.end();postgresAdmin=undefined;
    // Prove the actual restricted role on the exact target, not merely the URL username.
    const roleProbeUrl=new URL(appUrl);roleProbeUrl.pathname='/'+database;
    const roleProbe=postgres(roleProbeUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
    try{const [role]=await roleProbe`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;if(role?.name!=='ai_hr_app'||role.rolsuper||role.rolbypassrls)throw new Error('Restricted application role proof failed.');}finally{await roleProbe.end();}
    postgresTarget=postgres(ownerUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
    const [table]=await postgresTarget`select to_regclass('public.tenant')::text as name`;
    let seeded=false;
    if(table.name) {
      const tenants=await postgresTarget`select id,name from public.tenant`;
      let receipt=null;const file=path.join(out,'fixture-manifest.json');if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)throw new Error('Invalid prior fixture receipt; preserve target.');receipt=JSON.parse(fs.readFileSync(file,'utf8'));if(receipt.root!==root||receipt.database!==database||receipt.namespace!==namespace||!Array.isArray(receipt.fixtureTenants))throw new Error('Prior fixture receipt differs from target.');}
      const allowed=new Map([[DEMO_TENANT_ID,'Demo Group'],[SYSTEM_TENANT_ID,'System (auth audit)'],...(receipt?.fixtureTenants??[]).map(t=>[t.id,t.name])]);
      if(tenants.some(row=>allowed.get(row.id)!==row.name))throw new Error('Named database contains an unbound tenant; preserve it and refuse.');
      seeded=tenants.some(row=>row.id===DEMO_TENANT_ID&&row.name==='Demo Group');
      if(tenants.some(row=>row.id===DEMO_TENANT_ID)&&!seeded)throw new Error('Demo tenant identity changed; preserve it and refuse.');
    }
    await postgresTarget.end();postgresTarget=undefined;
    const migrationConfig=path.join(attemptOut,'drizzle-system-testing.config.ts');
    fs.writeFileSync(migrationConfig,`import {defineConfig} from 'drizzle-kit';\nconst url=process.env.MIGRATION_DATABASE_URL;\nif(!url||new URL(url).pathname!=='/${database}')throw new Error('Named System Testing migration target required');\nexport default defineConfig({schema:${JSON.stringify(path.join(root,'db/schema.ts'))},out:${JSON.stringify(path.join(root,'db/migrations'))},dialect:'postgresql',dbCredentials:{url},strict:true});\n`);
    await run('pnpm',['exec','drizzle-kit','migrate','--config',migrationConfig],'browser-migrate',180000);
    if(!seeded)await run(process.execPath,['--import','tsx',path.join(root,'db/seed.ts')],'browser-seed',180000);
    else fs.writeFileSync(path.join(attemptOut,'browser-seed.log'),'Existing named fictional demo database preserved; seed was not rerun.\n');
    for(const label of ['browser-fixture-first','browser-fixture-second'])await run(process.execPath,['--import','tsx',path.join(root,'scripts/dev-fixture-system-testing.mts')],label,120000);
    const manifests=['browser-fixture-first','browser-fixture-second'].map(manifestFromLog);
    const stable=manifest=>{const {reused,...facts}=manifest;return JSON.stringify(facts);};
    if(!manifests[1].reused||stable(manifests[0])!==stable(manifests[1]))throw new Error('Fixture rerun changed its declared business identities; no clean-twice claim.');
    const hr=manifests[1].people?.HR;
    if(!hr?.userId||hr.tenantId!==manifests[1].tenantId)throw new Error('Named fictional HR principal is missing.');
    env.DEV_USER_ID=hr.userId;
    fs.writeFileSync(path.join(out,'browser-manifest.json'),JSON.stringify({candidate,root,database,namespace,port:Number(port),fixtureRuns:2,attemptDirectory,identityFile,identitySha256:createHash('sha256').update(fs.readFileSync(path.join(out,identityFile))).digest('hex'),fixtureManifestSha256:createHash('sha256').update(fs.readFileSync(path.join(out,'fixture-manifest.json'))).digest('hex'),identityMode:options.reviewRequired?'review_required':'prepared_dev_identity',activeServiceVerified:false,applicationAcceptance:'UNVERIFIED',fixture:manifests[1]},null,2)+'\n',{flag:'wx',mode:0o600});
    await assertPortFree();checkCandidate();
    serverFd=fs.openSync(path.join(attemptOut,'browser-dev.log'),'w',0o600);
    server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port',port],{cwd:root,env,stdio:['ignore',serverFd,serverFd],detached:true});
    server.once('error',error=>{fs.appendFileSync(path.join(attemptOut,'browser-dev.log'),'\nSpawn failed: '+error.message+'\n');stopping=true;});
    fs.writeFileSync(path.join(out,'browser.pid'),String(server.pid??'')+'\n');
    console.log(`Fixture exited cleanly twice with identical declared facts. Owned candidate ${candidate}; local app http://127.0.0.1:${port}; render/application outcomes remain unverified.`);
    console.log(`Stop via ${stopFile}. Only owned process group ${server.pid} will be stopped. Both slots and DB stay held until cleanup.`);
    const deadline=overallDeadline;
    while(!stopping && !fs.existsSync(stopFile) && Date.now()<deadline) {
      if(server.exitCode!==null||server.signalCode!==null)throw new Error("Owned Next process exited; inspect the named attempt's browser-dev.log.");
      checkCandidate();await sleep(1000);
    }
    if(Date.now()>=deadline)console.log('Browser lifetime watchdog reached; stopping the owned server.');
    await stopOwned(server);server=undefined;fs.closeSync(serverFd);serverFd=undefined;
    fs.writeFileSync(path.join(out,'browser-stopped.json'),JSON.stringify({candidate,database,port:Number(port),ownedServerStopped:true,stoppedAt:new Date().toISOString()},null,2)+'\n');
    console.log('Owned System Testing server stopped; coordinator may now release both slots + DB. No browser outcome, production build or arrival PASS claimed by runner.');
  }catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
  finally {
    clearTimeout(overallWatchdog);clearTimeout(forceStopTimer);
    await stopOwned(activeJob);await stopOwned(server);
    if(serverFd!==undefined)fs.closeSync(serverFd);
    if(postgresAdmin)await postgresAdmin.end();if(postgresTarget)await postgresTarget.end();
  }
}
