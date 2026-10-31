/** Coordinator entry (owns both slots + dev DB until all children stop):
 * node --env-file=/absolute/own/.env.local --import tsx /absolute/own/scripts/dev-browser-overtime-patterns.mjs
 * Do NOT put an outer both-slot wrapper around this entry: it already acquires both slots.
 * Held-lock worker, only for coordinator/debugging: same command with --held-lock-worker.
 * That worker proves all three named lock files are live before any DB/build/server work.
 * --resume (coordinator/worker only) reopens a proven stopped target WITHOUT setup or clean-twice claims.
 * Optional parent allocation: --attempt=b2 uses its own DB/namespace/scratchpad, fixed port3210.
 * STOP: create browser.stop inside the selected scratchpad in this derived worktree.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard.ts';
import {overtimeBrowserTarget,validateOvertimePayrollPreparation} from './overtime-browser-target.mjs';
import {overtimeResumeReceiptName,validateOvertimeResumeReceipts} from './overtime-browser-resume.mjs';
import {todayInKualaLumpur} from '../lib/hr-date.ts';
const filename=fileURLToPath(import.meta.url),root=fileURLToPath(new URL('..',import.meta.url));
const target=overtimeBrowserTarget(process.argv.slice(2),{allowWorker:true,allowResume:true});
const out=path.join(root,target.scratchpad),stopFile=path.join(out,'browser.stop');
const {database,port,namespace}=target;
const lockNames={a:namespace+'-browser-a',b:namespace+'-browser-b',db:namespace+'-browser-db'};
const gateState=path.join(os.homedir(),'.aihr-gate-state');
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER!=='workos')throw new Error('Local fictional demo authentication only.');
if(!fs.existsSync(path.join(root,'node_modules')) || fs.lstatSync(path.join(root,'node_modules')).isSymbolicLink())throw new Error('Parent must provision real worktree dependencies first; this runner never installs or links them.');
function configuredUrl(key){try{return new URL(process.env[key]??'');}catch{throw new Error('Valid local database credentials are required.');}}
const appUrl=configuredUrl('DATABASE_URL'),ownerUrl=configuredUrl('MIGRATION_DATABASE_URL');
for(const url of [appUrl,ownerUrl])if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433')throw new Error('Only localhost:5433 credentials may be retargeted to the named disposable database.');
if(decodeURIComponent(appUrl.username)!=='ai_hr_app' || appUrl.username===ownerUrl.username)throw new Error('Use the non-owner ai_hr_app role for the application and separate migration credentials.');
appUrl.pathname='/'+database;ownerUrl.pathname='/'+database;
const env={...process.env,TOIL_ENABLED:'true',NOTIFICATIONS_ENABLED:'false',IDENTITY_EMAIL_SOCKET:path.join(out,'no-mail.sock'),NODE_ENV:'development',NEXT_PUBLIC_APP_URL:'http://127.0.0.1:'+port,DATABASE_URL:appUrl.toString(),MIGRATION_DATABASE_URL:ownerUrl.toString(),TEST_DB_NAMESPACE:namespace,PORT:port,DEV_TENANT_ID:DEMO_TENANT_ID,ALLOW_DEMO_SESSION:'true',AUTH_PROVIDER:'workos',SEED_MAY_DESTROY_OTHER_TENANTS:''};
// Explicit lock locations/slot count prevent inherited override variables from weakening coordination.
const lockEnv={...env,AIHR_TEST_SLOTS:'2',AIHR_LOCK_DIR:path.join(gateState,'locks')};
fs.mkdirSync(out,{recursive:true});
if(!target.heldLockWorker) {
  if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
  const args=[path.join(gateState,'testlock.sh'),lockNames.a,'--','bash',path.join(gateState,'testlock.sh'),lockNames.b,'--','bash',path.join(gateState,'devdb-lock.sh'),lockNames.db,'--',process.execPath,'--import','tsx',filename,'--held-lock-worker',...target.childArgs,...(target.resume?['--resume']:[])];
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
  const candidate=git(['rev-parse','HEAD']);
  const facadeSource=fs.readFileSync(path.join(root,'packs/attendance/service.ts'),'utf8');
  const actionSource=fs.readFileSync(path.join(root,'app/(app)/admin/attendance/settings/overtime-patterns/actions.ts'),'utf8');
  if(!facadeSource.includes('overtime-records')||!actionSource.includes('transferOvertimePatternToPayroll'))throw new Error('Integrate actual configuration, Records and Payroll action owners before this journey.');
  env.OVERTIME_FIXTURE_COORDINATOR_PID=String(process.pid);env.OVERTIME_FIXTURE_CANDIDATE=candidate;
  let server,activeJob,stopping=false,serverFd,forceStopTimer;
  let runFailed=false,ownedServerPid;
  let postgresAdmin,postgresTarget,postgresApp;
  let preparationCandidate=candidate,resumeReceipt,devLogName='browser-dev.log',fixtureDate;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function groupExists(child){if(!child?.pid)return false;try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
  function signalOwned(child,signal){if(groupExists(child)){try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}}
  const requestStop=()=>{stopping=true;fs.writeFileSync(stopFile,'Held worker received a graceful stop.\n');signalOwned(activeJob,'SIGTERM');signalOwned(server,'SIGTERM');forceStopTimer??=setTimeout(()=>{signalOwned(activeJob,'SIGKILL');signalOwned(server,'SIGKILL');},5000);};
  process.on('SIGINT',requestStop);process.on('SIGTERM',requestStop);
  const deadline=Date.now()+45*60*1000,watchdog=setTimeout(requestStop,45*60*1000);
  watchdog.unref();
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
    checkCandidate();const fd=fs.openSync(path.join(out,label+'.log'),'w');
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
    const content=fs.readFileSync(path.join(out,name+'.log'),'utf8'),marker='OVERTIME16_MANIFEST\n',start=content.indexOf(marker);
    if(start<0)throw new Error('Fixture manifest marker missing.');return JSON.parse(content.slice(start+marker.length));
  }
  function readReceipt(name) {
    const file=path.join(out,name),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw new Error('Missing or invalid local browser receipt; preserve target.');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  }
  function proveStoppedGroup(stopped) {
    const filename=path.join(out,'browser.pid'),stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32)throw new Error('Unproven prior owned server PID.');
    const raw=fs.readFileSync(filename,'utf8').trim();if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<=1||stopped.serverPid!==undefined&&stopped.serverPid!==Number(raw))throw new Error('Unproven or unmatched prior owned server PID.');
    try {process.kill(-Number(raw),0);}catch(error){if(error.code==='ESRCH')return;throw error;}
    throw new Error('Prior owned process group still exists; no resume and no process will be killed.');
  }
  try {
    if(fs.existsSync(stopFile))throw new Error('Run was stopped while waiting for locks.');
    if(fs.existsSync(env.IDENTITY_EMAIL_SOCKET))throw new Error('Disabled local mail socket must not exist.');
    await assertPortFree();
    const {default:postgres}=await import('postgres');
    let preparedFixture;
    if(target.resume) {
      const fixture=readReceipt('fixture-manifest.json'),browser=readReceipt('browser-manifest.json'),stopped=readReceipt('browser-stopped.json');
      const resumeRecords={};
      const resumeNames=fs.readdirSync(out).filter(name=>name.startsWith('browser-resume-')&&name.endsWith('.json'));
      if(resumeNames.length>64)throw new Error('Resume history exceeds the bounded proof limit; preserve target.');
      for(const name of resumeNames){const receipt=readReceipt(name);if(!overtimeResumeReceiptName(name,receipt.candidate))throw new Error('Invalid prior resume receipt identity.');resumeRecords[name]=receipt;}
      const binding=validateOvertimeResumeReceipts({fixture,browser,stopped,resumeRecords,target,root,today:todayInKualaLumpur()});
      proveStoppedGroup(stopped);
      for(const prior of new Set([binding.preparationCandidate,binding.resumedFromCandidate])) {
        if(git(['rev-parse',prior+'^{commit}'])!==prior || git(['diff','--name-only',prior,candidate,'--','db/migrations','packs/catalog.ts','db/schema.ts']))throw new Error('Resume requires unchanged migrations, pack catalog and schema versus preparation/prior candidate.');
      }
      postgresTarget=postgres(ownerUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
      postgresApp=postgres(appUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
      const [appRole]=await postgresApp`select current_user as name,current_database() as database,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
      if(appRole?.name!=='ai_hr_app'||appRole.database!==database||appRole.rolsuper||appRole.rolbypassrls)throw new Error('Resume requires the restricted application role on its exact database.');
      const [ownerRole]=await postgresTarget`select current_user as name,current_database() as database,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
      if(ownerRole?.name!==decodeURIComponent(ownerUrl.username)||ownerRole.name===appRole.name||ownerRole.database!==database)throw new Error('Resume requires the distinct configured migration reader on its exact database.');
      if(!ownerRole.rolsuper&&!ownerRole.rolbypassrls)throw new Error('Resume requires full migration-reader visibility to prove the exact tenant set; filtered absence is insufficient.');
      const tenants=await postgresTarget`select id,name from public.tenant`;
      const expected=new Map([[DEMO_TENANT_ID,'Demo Group'],[SYSTEM_TENANT_ID,null],[fixture.tenantId,'Overtime16 fictional primary tenant'],[fixture.foreignTenant.id,'Overtime16 fictional foreign tenant']]);
      if(expected.size!==4||tenants.length!==4||tenants.some(row=>!expected.has(row.id)||expected.get(row.id)!==null&&expected.get(row.id)!==row.name))throw new Error('Resume tenant identities differ from the exact fictional preparation; preserve target.');
      await postgresApp.end();postgresApp=undefined;await postgresTarget.end();postgresTarget=undefined;
      preparationCandidate=binding.preparationCandidate;fixtureDate=binding.date;preparedFixture=fixture;
      resumeReceipt='browser-resume-'+candidate+'-'+Date.now()+'.json';devLogName=resumeReceipt.replace(/\.json$/,'-dev.log');
      fs.writeFileSync(path.join(out,resumeReceipt),JSON.stringify({candidate,preparationCandidate,resumedFromCandidate:binding.resumedFromCandidate,preparationManifest:'browser-manifest.json',priorStoppedReceipt:stopped,...(target.deferPayroll?{payrollPreparation:'deferred'}:{}),root,database,namespace,port:Number(port),date:fixtureDate,fixtureRunsThisCandidate:0,resumedAt:new Date().toISOString(),devLogName,applicationAcceptance:'UNVERIFIED'},null,2)+'\n',{flag:'wx'});
    } else {
      if(fs.existsSync(path.join(out,'fixture-manifest.json')))validateOvertimePayrollPreparation(readReceipt('fixture-manifest.json'),target);
      const adminUrl=new URL(ownerUrl);adminUrl.pathname='/postgres';postgresAdmin=postgres(adminUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
      const existing=await postgresAdmin`select datname from pg_database where datname=${database}`;
      if(!existing.length)await postgresAdmin.unsafe('CREATE DATABASE "'+database+'"');
      await postgresAdmin.end();postgresAdmin=undefined;
      postgresTarget=postgres(ownerUrl.toString(),{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
      const [table]=await postgresTarget`select to_regclass('public.tenant')::text as name`;
      let seeded=false;
      if(table.name) {
        const tenants=await postgresTarget`select id,name from public.tenant`;
        const receiptPath=path.join(out,'fixture-manifest.json');
        let receipt=null;if(fs.existsSync(receiptPath)){receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));if(receipt.root!==root||receipt.database!==database||receipt.namespace!==namespace||!receipt.tenantId||!receipt.foreignTenant?.id)throw new Error('Existing foreign-tenant receipt differs from target; preserve it.');}
        if(tenants.some(row=>row.id!==DEMO_TENANT_ID&&row.id!==SYSTEM_TENANT_ID&&!(receipt?.foreignTenant?.id===row.id&&row.name==='Overtime16 fictional foreign tenant')&&!(receipt?.tenantId===row.id&&row.name==='Overtime16 fictional primary tenant')))throw new Error('Named database contains a tenant outside its fictional receipt; preserve it and refuse.');
        seeded=tenants.some(row=>row.id===DEMO_TENANT_ID&&row.name==='Demo Group');
        if(tenants.some(row=>row.id===DEMO_TENANT_ID)&&!seeded)throw new Error('Demo tenant identity changed; preserve it and refuse.');
      }
      await postgresTarget.end();postgresTarget=undefined;
      const migrationConfig=path.join(out,'drizzle-overtime.config.ts');
      fs.writeFileSync(migrationConfig,`import {defineConfig} from 'drizzle-kit';\nconst url=process.env.MIGRATION_DATABASE_URL;\nif(!url||new URL(url).pathname!=='/${database}')throw new Error('Named Overtime migration target required');\nexport default defineConfig({schema:${JSON.stringify(path.join(root,'db/schema.ts'))},out:${JSON.stringify(path.join(root,'db/migrations'))},dialect:'postgresql',dbCredentials:{url},strict:true});\n`);
      await run('pnpm',['exec','drizzle-kit','migrate','--config',migrationConfig],'browser-migrate',180000);
      if(!seeded)await run(process.execPath,['--import','tsx',path.join(root,'db/seed.ts')],'browser-seed',180000);
      else fs.writeFileSync(path.join(out,'browser-seed.log'),'Existing named fictional demo database preserved; seed was not rerun.\n');
      for(const label of ['browser-fixture-first','browser-fixture-second'])await run(process.execPath,['--import','tsx',path.join(root,'scripts/dev-fixture-overtime-patterns.mts'),...target.childArgs],label,120000);
      const manifests=['browser-fixture-first','browser-fixture-second'].map(manifestFromLog);
      if(JSON.stringify(manifests[0])!==JSON.stringify(manifests[1]))throw new Error('Fixture rerun changed its declared business identities/files; no clean-twice claim.');
      preparedFixture=manifests[1];validateOvertimePayrollPreparation(preparedFixture,target);fixtureDate=preparedFixture.date;
      fs.writeFileSync(path.join(out,'browser-manifest.json'),JSON.stringify({candidate,...(target.deferPayroll?{payrollPreparation:'deferred'}:{}),root,database,namespace,port:Number(port),fixtureRuns:2,fixture:preparedFixture},null,2)+'\n');
    }
    env.DEV_USER_ID=preparedFixture.people.HR.userId;
    // Switching principals in the actual demo UI also permits the receipt-bound foreign tenant.
    // No forged cookies, API mutation or per-page synthetic permission is installed.
    if(stopping||fs.existsSync(stopFile)||Date.now()>=deadline)throw new Error('Stopped before app startup.');
    await assertPortFree();checkCandidate();
    serverFd=fs.openSync(path.join(out,devLogName),'w');
    server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port',port],{cwd:root,env,stdio:['ignore',serverFd,serverFd],detached:true});
    server.once('error',error=>{fs.appendFileSync(path.join(out,devLogName),'\nSpawn failed: '+error.message+'\n');runFailed=true;process.exitCode=1;stopping=true;});
    ownedServerPid=server.pid;
    fs.writeFileSync(path.join(out,'browser.pid'),String(server.pid??'')+'\n');
    console.log(target.resume?`Resuming candidate ${candidate} from preparation ${preparationCandidate}; NO migration, seed or fixture ran for this candidate. Local app http://127.0.0.1:${port}; application outcomes remain unverified.`:`Fixture exited cleanly twice with identical declared facts. Owned candidate ${candidate}; local app http://127.0.0.1:${port}; render/application outcomes remain unverified.`);
    console.log(`Stop via ${stopFile}. Only owned process group ${server.pid} will be stopped. Both slots and DB stay held until cleanup.`);
    while(!stopping && !fs.existsSync(stopFile) && Date.now()<deadline) {
      if(server.exitCode!==null||server.signalCode!==null)throw new Error('Owned Next process exited; inspect '+devLogName+'.');
      checkCandidate();await sleep(1000);
    }
    if(Date.now()>=deadline)console.log('Browser lifetime watchdog reached; stopping the owned server.');
    await stopOwned(server);server=undefined;fs.closeSync(serverFd);serverFd=undefined;
  }catch(error){console.error(error instanceof Error?error.message:String(error));runFailed=true;process.exitCode=1;}
  finally {
    clearTimeout(watchdog);clearTimeout(forceStopTimer);
    await stopOwned(activeJob);await stopOwned(server);
    if(serverFd!==undefined)fs.closeSync(serverFd);
    if(postgresApp)await postgresApp.end();if(postgresAdmin)await postgresAdmin.end();if(postgresTarget)await postgresTarget.end();
    // Publish a CURRENT stop only after every owned group and DB handle has closed. A failed run
    // remains failed; this is cleanup provenance, never a browser or fixture PASS receipt.
    if(Number.isSafeInteger(ownedServerPid)&&ownedServerPid>1) {
      const receipt={candidate,preparationCandidate,...(target.deferPayroll?{payrollPreparation:'deferred'}:{}),root,database,namespace,date:fixtureDate,port:Number(port),resumeReceipt,devLogName,serverPid:ownedServerPid,ownedServerStopped:true,cleanupSucceeded:true,outcome:runFailed?'failed':'stopped',exitCode:runFailed?1:0,stoppedAt:new Date().toISOString()};
      const temporary=path.join(out,'browser-stopped.json.tmp-'+process.pid);
      fs.writeFileSync(temporary,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
      fs.renameSync(temporary,path.join(out,'browser-stopped.json'));
      console.log(`Owned Overtime cleanup complete (${receipt.outcome}); coordinator may release both slots + DB. No acceptance PASS claimed.`);
    }
  }
}
