/** Original18 closed browser coordinator. Explicit --scenario=schedules|holidays|approval|inquiry|labels|reports.
 * Integration and Personnel are --scenario=integration|personnel --resume ONLY, with its exact reviewed legacy preparation.
 * This entry acquires BOTH test slots and the dev DB lock itself; do not wrap it in those locks.
 * Parent provisions real dependencies/private .env.local. No install, reset or automatic retry.
 * STOP: create browser.stop in the scenario scratchpad; 45-minute owned lifetime includes setup.
 * Preparation/cleanup receipts never claim browser acceptance. Resume runs ZERO setup calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {original18BrowserTarget,original18FixtureFromLog,original18FixtureIdentities,original18FixtureTenants,original18InvocationStopFile,original18EmploymentProof,original18ResumeReceiptName,validateOriginal18Resume,PERSONNEL_PREPARATION,INTEGRATION_PREPARATION} from './original18-browser-target.mjs';
import {todayInKualaLumpur} from '../lib/hr-date.ts';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard.ts';
const filename=fileURLToPath(import.meta.url);
const options=original18BrowserTarget(process.argv.slice(2),{allowWorker:true});
// Preserve each fixture's exact root representation, including pinned legacy Personnel bytes.
const derivedRoot=fileURLToPath(new URL('..',import.meta.url));
const root=options.scenario==='reports'?path.resolve(derivedRoot):derivedRoot;
const {database,namespace,scenario}=options,port=String(options.port);
const out=path.join(root,options.scratchpad),stopFile=path.join(out,'browser.stop');
const lockNames={a:namespace+'-browser-a',b:namespace+'-browser-b',db:namespace+'-browser-db'};
const gateState=path.join(os.homedir(),'.aihr-gate-state');
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER!=='workos')throw new Error('Local fictional demo authentication only.');
if(!fs.existsSync(path.join(root,'node_modules')) || fs.lstatSync(path.join(root,'node_modules')).isSymbolicLink())throw new Error('Parent must provision real worktree dependencies first; this runner never installs or links them.');
const localEnv=path.join(root,'.env.local'),envStat=fs.lstatSync(localEnv);
if(!envStat.isFile()||envStat.isSymbolicLink()||envStat.uid!==process.getuid()||(envStat.mode&0o077))throw new Error('Parent must provision a private owned .env.local (0600); no env files are copied by this runner.');
function configuredUrl(key){try{return new URL(process.env[key]??'');}catch{throw new Error('Valid local database credentials are required.');}}
const appUrl=configuredUrl('DATABASE_URL'),ownerUrl=configuredUrl('MIGRATION_DATABASE_URL');
for(const url of [appUrl,ownerUrl])if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433')throw new Error('Only localhost:5433 credentials may be retargeted to the named disposable database.');
if(decodeURIComponent(appUrl.username)!=='ai_hr_app' || appUrl.username===ownerUrl.username)throw new Error('Use the non-owner ai_hr_app role for the application and separate migration credentials.');
appUrl.pathname='/'+database;ownerUrl.pathname='/'+database;
const env={...process.env,NOTIFICATIONS_ENABLED:'false',IDENTITY_EMAIL_SOCKET:path.join(out,'no-mail.sock'),NEXT_PUBLIC_APP_URL:'http://127.0.0.1:'+port,NODE_ENV:'development',DATABASE_URL:appUrl.toString(),MIGRATION_DATABASE_URL:ownerUrl.toString(),TEST_DB_NAMESPACE:namespace,PORT:port,DEV_TENANT_ID:DEMO_TENANT_ID,ALLOW_DEMO_SESSION:'true',AUTH_PROVIDER:'workos',SEED_MAY_DESTROY_OTHER_TENANTS:''};
// Explicit lock locations/slot count prevent inherited override variables from weakening coordination.
const lockEnv={...env,AIHR_TEST_SLOTS:'2',AIHR_LOCK_DIR:path.join(gateState,'locks')};
fs.mkdirSync(out,{recursive:true,mode:0o700});
const outStat=fs.lstatSync(out);if(!outStat.isDirectory()||outStat.isSymbolicLink()||outStat.uid!==process.getuid())throw new Error('An owned ordinary scratchpad directory is required.');
if(!options.heldLockWorker) {
  // A queued invocation may cancel only itself, never the active scenario's shared stop pointer.
  const requestName='browser-request-'+randomUUID().replaceAll('-','')+'.stop';
  const requestFile=original18InvocationStopFile(out,requestName);
  const args=[path.join(gateState,'testlock.sh'),lockNames.a,'--','bash',path.join(gateState,'testlock.sh'),lockNames.b,'--','bash',path.join(gateState,'devdb-lock.sh'),lockNames.db,'--',process.execPath,'--import','tsx',filename,'--held-lock-worker','--scenario='+scenario,...(options.resume?['--resume']:[]),...(options.recoverMigrationOnly?['--recover-migration-only-reports']:[]),...(options.continueReportsPrefix?['--continue-reports-prefix']:[])];
  // Isolate lock wrappers from terminal Ctrl-C: only the coordinator receives it and requests a
  // stop-file handoff. A wrapper's own signal trap must not release before owned server cleanup.
  const child=spawn('bash',args,{cwd:root,env:{...lockEnv,ORIGINAL18_BROWSER_STOP_REQUEST:requestName},stdio:'inherit',detached:true});
  const stop=()=>{fs.writeFileSync(requestFile,'This coordinator invocation requested a graceful stop.\n',{mode:0o600});};
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
  const requestName=process.env.ORIGINAL18_BROWSER_STOP_REQUEST;
  const requestFile=original18InvocationStopFile(out,requestName);
  if(fs.existsSync(requestFile))throw new Error('This queued invocation was cancelled; active journey was not touched.');
  // Shared manual-stop ownership begins only after every required lock is held.
  if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
  const stopRequested=()=>fs.existsSync(requestFile)||fs.existsSync(stopFile);
  const git=(args)=>execFileSync('git',['-C',root,...args],{cwd:root,encoding:'utf8'}).trim();
  if(git(['status','--porcelain']))throw new Error('Freeze a clean owned candidate before the browser runner.');
  const candidate=git(['rev-parse','HEAD']),runId=candidate+'-'+Date.now();
  const bound={root,scenario,database,namespace,port:Number(port)};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const writeNew=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  let server,activeJob,stopping=false,serverFd,forceStopTimer;
  let runFailed=false,ownedServerPid;
  let postgresAdmin,postgresTarget,postgresApp;
  let preparationCandidate=candidate,resumeReceipt,labelsContinuity,reportsRecovery,reportsPrefix,reportsContinuity,devLogName=runId+'-browser-dev.log';
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
  async function run(command,args,label,limit=120000,childEnv=env) {
    if(stopping||stopRequested())throw new Error('Browser run stopped before '+label);
    checkCandidate();const fd=fs.openSync(path.join(out,runId+'-'+label+'.log'),'wx',0o600);
    let timedOut=false,forceTimer;
    const child=spawn(command,args,{cwd:root,env:childEnv,stdio:['ignore',fd,fd],detached:true});activeJob=child;
    const timer=setTimeout(()=>{timedOut=true;signalOwned(child,'SIGTERM');forceTimer??=setTimeout(()=>signalOwned(child,'SIGKILL'),5000);},limit);
    const cancel=setInterval(()=>{if(stopRequested()){stopping=true;signalOwned(child,'SIGTERM');forceTimer??=setTimeout(()=>signalOwned(child,'SIGKILL'),5000);}},500);
    try {
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?1:0)));});
      if(timedOut||stopping||stopRequested()||code!==0)throw new Error(`${label} failed or timed out; inspect its named log. No PASS claimed.`);
      checkCandidate();
    }finally {clearTimeout(timer);clearTimeout(forceTimer);clearInterval(cancel);await stopOwned(child);fs.closeSync(fd);activeJob=undefined;}
  }
  function manifestFromLog(name){return original18FixtureFromLog(fs.readFileSync(path.join(out,runId+'-'+name+'.log'),'utf8'));}
  function readReceipt(name) {
    const file=path.join(out,name),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw new Error('Missing or invalid local acceptance browser receipt; preserve target.');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  }
  function proveStoppedGroup(stopped) {
    const file=path.join(out,'browser.pid'),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32)throw new Error('Unproven prior owned server PID.');
    const raw=fs.readFileSync(file,'utf8').trim();
    if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<=1||stopped.serverPid!==undefined&&stopped.serverPid!==Number(raw))throw new Error('Unproven or unmatched prior owned server PID.');
    for(const pid of [Number(raw),-Number(raw)]){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')continue;throw error;}throw new Error('Prior PID/group exists or was reused; refuse resume and never kill it.');}
    if(scenario==='personnel'&&stopped.resumeReceipt===undefined&&Number(raw)!==PERSONNEL_PREPARATION.pid)throw new Error('Legacy Personnel PID differs from reviewed preparation.');
  }
  async function proveRoles(){
    const [app]=await postgresApp`select current_user name,current_database() database,r.rolsuper,r.rolbypassrls,(r.rolcreaterole or r.rolcreatedb or r.rolreplication or exists(select 1 from pg_auth_members m where m.member=r.oid) or exists(select 1 from pg_class c where c.relowner=r.oid) or exists(select 1 from pg_namespace n where n.nspowner=r.oid)) privileged from pg_roles r where r.rolname=current_user`;
    if(app?.name!=='ai_hr_app'||app.database!==database||app.rolsuper||app.rolbypassrls||app.privileged)throw new Error('Restricted non-owner app role required on exact named database.');
    const [owner]=await postgresTarget`select current_user name,current_database() database,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    if(owner?.name!==decodeURIComponent(ownerUrl.username)||owner.name===app.name||owner.database!==database||!owner.rolsuper&&!owner.rolbypassrls)throw new Error('Distinct full-visibility local migration reader required; filtered absence cannot prove pristine state.');
  }
  async function proveTenants(fixture){
    const tenants=await postgresTarget`select id,name from public.tenant order by id`;
    const expected=new Map(original18FixtureTenants(scenario,fixture).map(row=>[row.id,row.name]));
    if(tenants.length!==expected.size||tenants.some(row=>expected.get(row.id)!==row.name))throw new Error('Exact fictional tenant identities required; preserve target.');
  }
  async function proveIdentities(identities,expectedPrincipals){
    for(const company of identities.companies){
      const rows=await postgresTarget`select id from public.company where id=${company.id} and tenant_id=${company.tenantId??DEMO_TENANT_ID} and company_label is not distinct from ${company.label} and legal_name=${company.name} and archived_at is null`;
      if(rows.length!==1)throw new Error('Declared fictional company identity changed; preserve target.');
    }
    const principals=[];
    for(const actor of identities.actors){
      const rows=await postgresTarget`select id,person_id from public.app_user where id=${actor.id} and tenant_id=${actor.tenantId??DEMO_TENANT_ID} and workos_user_id=${actor.login} and archived_at is null`;
      const user=rows[0];if(rows.length!==1||actor.personId===undefined&&!user.person_id||actor.personId!==undefined&&actor.personId!==user.person_id)throw new Error('Declared fictional principal identity changed; preserve target.');
      let employment;
      if(actor.employmentId){
        const employments=await postgresTarget`select id,company_id as "companyId",employee_code as "employeeCode" from public.employment where id=${actor.employmentId} and person_id=${user.person_id} and tenant_id=${actor.tenantId??DEMO_TENANT_ID}`;
        if(employments.length!==1)throw new Error('Declared fictional employment identity changed.');
        employment=employments[0];
      }
      const [login]=await postgresApp`select app.login_blocked(${actor.id}::uuid) as blocked`;
      const employmentProof=original18EmploymentProof(actor,employment,login?.blocked);
      const grants=await postgresTarget`select role,company_id as "companyId" from public.role_assignment where app_user_id=${actor.id} and tenant_id=${actor.tenantId??DEMO_TENANT_ID} order by role,company_id nulls first`;
      const canonical=rows=>JSON.stringify(rows.map(row=>[row.role,row.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
      if(canonical(grants)!==canonical(actor.grants))throw new Error('Declared fictional grants changed; no authority is repaired by this runner.');
      principals.push({id:actor.id,personId:user.person_id,...(employmentProof?{employment:employmentProof}:{})});
    }
    if(expectedPrincipals&&JSON.stringify(principals)!==JSON.stringify(expectedPrincipals))throw new Error('Prepared principal person binding changed.');
    return principals;
  }
  async function proveFreshSource(fixture,browser,resumeRecords){
    if(!options.fresh)return;
    if(scenario==='labels'){
      const {systemLabelFixtureSourceProof}=await import('./system-label-fixture-contract.mjs');
      const currentProof=await systemLabelFixtureSourceProof(root);
      const {prepareLabelsReadabilityContinuity,LABELS_READABILITY_SOURCE_SHA256,LABELS_READABILITY_CONTINUITY_NAME}=await import('./system-label-readability-continuity.mjs');
      // Once a transition exists, never let returning to the original source bypass its review.
      const transitioned=fs.existsSync(path.join(out,'labels-source-continuity-886-grid-workbook-v1.json'))||fs.existsSync(path.join(out,LABELS_READABILITY_CONTINUITY_NAME))||Object.values(resumeRecords??{}).some(record=>record.labelsSourceContinuity!==undefined);
      if(JSON.stringify(currentProof)!==JSON.stringify(fixture.sourceProof)||transitioned){
        if(!options.resume)throw new Error('Labels metadata/catalog proof changed; preserve journey.');
        const {prepareLabelsSourceContinuity}=await import('./system-label-source-continuity.mjs');
        const readabilityTransitioned=fs.existsSync(path.join(out,LABELS_READABILITY_CONTINUITY_NAME))||Object.values(resumeRecords??{}).some(record=>record.labelsSourceContinuity?.fileName===LABELS_READABILITY_CONTINUITY_NAME);
        labelsContinuity=currentProof.sha256===LABELS_READABILITY_SOURCE_SHA256||readabilityTransitioned
          ?await prepareLabelsReadabilityContinuity({root,candidate,fixture,browser,currentProof,resumeRecords})
          :await prepareLabelsSourceContinuity({root,candidate,fixture,browser,currentProof,resumeRecords});
      }
    }else{
      const {readEmployeeMasterFixtureProof}=await import('./employee-master-fixture-proof.mts');
      const proof=await readEmployeeMasterFixtureProof({client:postgresTarget},{tenantId:fixture.tenantId,foreignTenantId:fixture.foreignTenant.id});
      const {prepareReportsProjectionContinuity,REPORTS_PROJECTION_CONTINUITY_NAME}=await import('./reports-projection-source-continuity.mjs');
      const transitioned=fs.existsSync(path.join(out,REPORTS_PROJECTION_CONTINUITY_NAME))||Object.values(resumeRecords??{}).some(record=>record.reportsSourceContinuity!==undefined);
      if(JSON.stringify(proof)!==JSON.stringify(fixture.proof)||transitioned){
        if(!options.resume)throw new Error('Reports metadata/invariant source proof changed; preserve journey.');
        reportsContinuity=await prepareReportsProjectionContinuity({root,candidate,fixture,browser,currentProof:proof,resumeRecords});
      }
    }
  }
  try {
    if(stopRequested())throw new Error('Run was stopped while waiting for locks.');
    await assertPortFree();
    const {default:postgres}=await import('postgres');
    const connect=url=>postgres(url,{max:1,connect_timeout:10,idle_timeout:5,connection:{statement_timeout:10000}});
    let preparedFixture,identities;
    if(options.resume) {
      const browser=readReceipt('browser-manifest.json');
      const fixture=scenario==='integration'?browser.fixture:readReceipt('fixture-manifest.json');
      const manualCleanup=scenario==='integration'?readReceipt('browser-manual-cleanup.json'):undefined;
      const stopReceiptFile=scenario==='integration'&&!fs.existsSync(path.join(out,'browser-stopped.json'))?'browser-manual-cleanup.json':'browser-stopped.json';
      const stopped=readReceipt(stopReceiptFile);
      if(scenario==='integration'){
        for(const [name,expected]of [['browser-manifest.json',INTEGRATION_PREPARATION.browserBytes],['browser-fixture-first.log',INTEGRATION_PREPARATION.firstLogBytes],['browser-fixture-second.log',INTEGRATION_PREPARATION.secondLogBytes]])if(hash(fs.readFileSync(path.join(out,name)))!==expected)throw new Error('Reviewed 3191 preparation bytes changed; preserve target.');
        const source=execFileSync('git',['-C',root,'show',INTEGRATION_PREPARATION.candidate+':scripts/dev-browser-board-integration.mjs']);
        if(hash(source)!==INTEGRATION_PREPARATION.runnerBytes)throw new Error('Unproven legacy 3191 runner source.');
        const evidence=path.join(out,'browser-manual-cleanup-evidence.log'),stat=fs.lstatSync(evidence);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>1024*1024||hash(fs.readFileSync(evidence))!==manualCleanup.evidenceSha256)throw new Error('Independent cleanup evidence is missing or changed.');
      }
      if(scenario==='personnel'){
        for(const [name,expected]of [['fixture-manifest.json',PERSONNEL_PREPARATION.fixtureBytes],['browser-manifest.json',PERSONNEL_PREPARATION.browserBytes]])if(hash(fs.readFileSync(path.join(out,name)))!==expected)throw new Error('Reviewed Personnel preparation bytes changed; preserve target.');
        const source=execFileSync('git',['-C',root,'show',PERSONNEL_PREPARATION.candidate+':scripts/dev-browser-personnel-registers.mjs']);
        if(hash(source)!==PERSONNEL_PREPARATION.runnerBytes)throw new Error('Unproven legacy Personnel runner source.');
        if(stopped.resumeReceipt===undefined&&hash(fs.readFileSync(path.join(out,'browser-stopped.json')))!==PERSONNEL_PREPARATION.stopBytes)throw new Error('Unproven legacy Personnel cleanup receipt.');
      }
      const resumeRecords={},resumeNames=fs.readdirSync(out).filter(name=>name.startsWith('browser-resume-')&&name.endsWith('.json'));
      if(resumeNames.length>64)throw new Error('Resume history exceeds bounded proof limit.');
      for(const name of resumeNames){const receipt=readReceipt(name);if(!original18ResumeReceiptName(name,receipt.candidate))throw new Error('Invalid resume receipt identity.');resumeRecords[name]=receipt;}
      const binding=validateOriginal18Resume({fixture,browser,stopped,resumeRecords,manualCleanup,root,scenario});
      proveStoppedGroup(stopped);
      for(const prior of new Set([binding.preparationCandidate,binding.resumedFromCandidate]))if(git(['rev-parse',prior+'^{commit}'])!==prior||git(['diff','--name-only',prior,candidate,'--','db/migrations','packs/catalog.ts','db/schema.ts']))throw new Error('Resume requires unchanged SQL, journal, schema and pack catalog versus preparation/prior candidate.');
      postgresTarget=connect(ownerUrl.toString());postgresApp=connect(appUrl.toString());await proveRoles();await proveTenants(fixture);await proveFreshSource(fixture,browser,resumeRecords);
      identities=original18FixtureIdentities(scenario,['personnel','integration'].includes(scenario)||options.fresh?fixture:fixture.facts);
      const expectedPrincipals=scenario==='integration'&&stopped.resumeReceipt?resumeRecords[stopped.resumeReceipt].principals:['personnel','integration'].includes(scenario)||options.fresh?undefined:fixture.principals;
      const resumePrincipals=await proveIdentities(identities,expectedPrincipals);
      await postgresApp.end();postgresApp=undefined;await postgresTarget.end();postgresTarget=undefined;
      checkCandidate();
      if(labelsContinuity?.create)writeNew(labelsContinuity.name,labelsContinuity.value);
      if(reportsContinuity?.create)writeNew(reportsContinuity.name,reportsContinuity.value);
      preparationCandidate=binding.preparationCandidate;preparedFixture=fixture;
      resumeReceipt='browser-resume-'+runId+'.json';
      // Archive exact previous cleanup bytes before changing the current pointer; never overwrite old evidence.
      fs.copyFileSync(path.join(out,stopReceiptFile),path.join(out,'browser-prior-stop-'+runId+'.json'),fs.constants.COPYFILE_EXCL);
      writeNew(resumeReceipt,{candidate,...binding,...bound,...(scenario==='integration'?{principals:resumePrincipals}:{}),...(labelsContinuity?{labelsSourceContinuity:labelsContinuity.reference}:{}),...(reportsContinuity?{reportsSourceContinuity:reportsContinuity.reference}:{}),preparationManifest:'browser-manifest.json',priorStoppedReceipt:stopped,fixtureRunsThisCandidate:0,migrationRunsThisCandidate:0,seedRunsThisCandidate:0,resumedAt:new Date().toISOString(),devLogName,applicationAcceptance:'UNVERIFIED'});
    } else {
      if(options.resumeOnly)throw new Error('Preserved scenario setup is forbidden.');
      if(options.recoverMigrationOnly){
        if(scenario!=='reports'||!options.fresh)throw new Error('Closed Reports migration-only recovery required.');
        postgresTarget=connect(ownerUrl.toString());postgresApp=connect(appUrl.toString());await proveRoles();
        const {prepareReportsMigrationOnlyRecovery}=await import('./reports-migration-only-recovery.mjs');
        const recovery=await prepareReportsMigrationOnlyRecovery({root,candidate,out,owner:postgresTarget,app:postgresApp});
        await postgresApp.end();postgresApp=undefined;await postgresTarget.end();postgresTarget=undefined;
        checkCandidate();writeNew(recovery.name,recovery.value);reportsRecovery=recovery.reference;
      }else if(options.continueReportsPrefix){
        if(scenario!=='reports'||!options.fresh)throw new Error('Closed Reports prefix continuation required.');
        postgresTarget=connect(ownerUrl.toString());postgresApp=connect(appUrl.toString());await proveRoles();
        const {prepareReportsPrefixContinuation}=await import('./reports-prefix-continuation.mjs');
        const continuation=await prepareReportsPrefixContinuation({root,candidate,out,owner:postgresTarget,app:postgresApp,coordinatorPid:process.pid});
        await postgresApp.end();postgresApp=undefined;await postgresTarget.end();postgresTarget=undefined;
        checkCandidate();writeNew(continuation.name,continuation.value);reportsPrefix=continuation.reference;
      }else{
      if(['preparation-attempt.json','fixture-manifest.json','browser-manifest.json','browser-stopped.json','browser.pid'].some(name=>fs.existsSync(path.join(out,name))))throw new Error('Existing preparation/partial attempt preserved; use receipt-bound resume only.');
      const adminUrl=new URL(ownerUrl);adminUrl.pathname='/postgres';postgresAdmin=connect(adminUrl.toString());
      const [creator]=await postgresAdmin`select current_user name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
      if(creator?.name!==decodeURIComponent(ownerUrl.username)||!creator.rolsuper&&!creator.rolbypassrls)throw new Error('Full-visibility local migration reader required before absence proof.');
      const existing=await postgresAdmin`select datname from pg_database where datname=${database}`;
      if(!existing.length)await postgresAdmin.unsafe('CREATE DATABASE "'+database+'"'); // closed target constant only
      await postgresAdmin.end();postgresAdmin=undefined;
      postgresTarget=connect(ownerUrl.toString());postgresApp=connect(appUrl.toString());await proveRoles();
      const relations=await postgresTarget`select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S','f')`;
      if(relations.length)throw new Error('Named target is not pristine; no migration/seed/fixture will run. Preserve it.');
      writeNew('preparation-attempt.json',{candidate,...bound,startedAt:new Date().toISOString(),applicationAcceptance:'UNVERIFIED'});
      await postgresApp.end();postgresApp=undefined;await postgresTarget.end();postgresTarget=undefined;
      const migrationConfig=path.join(out,runId+'-drizzle.config.ts');
      fs.writeFileSync(migrationConfig,`import {defineConfig} from 'drizzle-kit';\nconst url=process.env.MIGRATION_DATABASE_URL;\nif(!url||new URL(url).pathname!=='/${database}')throw new Error('Named original18 migration target required');\nexport default defineConfig({schema:${JSON.stringify(path.join(root,'db/schema.ts'))},out:${JSON.stringify(path.join(root,'db/migrations'))},dialect:'postgresql',dbCredentials:{url},strict:true});\n`,{flag:'wx',mode:0o600});
      await run('pnpm',['exec','drizzle-kit','migrate','--config',migrationConfig],'browser-migrate',180000);
      postgresTarget=connect(ownerUrl.toString());
      const tenants=await postgresTarget`select id,name from public.tenant order by id`;
      if(tenants.some(row=>row.id!==SYSTEM_TENANT_ID||row.name!=='System (auth audit)'))throw new Error('Post-migration target is not pristine fictional system-only; seed refused.');
      const [business]=await postgresTarget`select (select count(*) from public.company)+(select count(*) from public.person)+(select count(*) from public.employment)+(select count(*) from public.app_user) as count`;
      if(Number(business.count)!==0)throw new Error('Post-migration business data exists; seed refused.');
      await postgresTarget.end();postgresTarget=undefined;
      }
      if(!options.fresh)await run(process.execPath,['--import','tsx',path.join(root,'db/seed.ts')],'browser-seed',180000);
      const fixtureEnv={...env};
      if(options.fresh){delete fixtureEnv.DEV_TENANT_ID;delete fixtureEnv.DEV_USER_ID;const prefix=scenario==='labels'?'LABELS':'REPORT';fixtureEnv[prefix+'_FIXTURE_COORDINATOR_PID']=String(process.pid);fixtureEnv[prefix+'_FIXTURE_COORDINATOR_CANDIDATE']=candidate;}
      const preparationDate=todayInKualaLumpur();
      for(const label of ['browser-fixture-first','browser-fixture-second'])await run(process.execPath,['--import','tsx',path.join(root,'scripts',options.fixture),...(reportsPrefix&&label==='browser-fixture-first'?['--continue-reviewed-prefix']:[])],label,120000,fixtureEnv);
      if(todayInKualaLumpur()!==preparationDate)throw new Error('Business date changed during preparation; preserve attempt, no clean-twice claim.');
      const manifests=['browser-fixture-first','browser-fixture-second'].map(manifestFromLog);
      if(JSON.stringify(manifests[0])!==JSON.stringify(manifests[1]))throw new Error('Fixture repeat changed declared business facts; no clean-twice claim.');
      identities=original18FixtureIdentities(scenario,manifests[1]);postgresTarget=connect(ownerUrl.toString());postgresApp=connect(appUrl.toString());await proveRoles();await proveTenants(manifests[1]);
      const principals=await proveIdentities(identities);
      if(options.fresh){
        preparedFixture=readReceipt('fixture-manifest.json');
        if(JSON.stringify(preparedFixture)!==JSON.stringify(manifests[1])||preparedFixture.root!==root||preparedFixture.candidate!==candidate||preparedFixture.database!==database||preparedFixture.namespace!==namespace||preparedFixture.port!==Number(port)||preparedFixture.date!==preparationDate)throw new Error('Fresh fixture private/public source binding differs.');
        await proveFreshSource(preparedFixture);
      }else{
        preparedFixture={...bound,tenantId:DEMO_TENANT_ID,date:preparationDate,facts:manifests[1],identities,principals};writeNew('fixture-manifest.json',preparedFixture);
      }
      await postgresApp.end();postgresApp=undefined;await postgresTarget.end();postgresTarget=undefined;
      writeNew('browser-manifest.json',{candidate,...bound,fixtureRuns:2,...(reportsRecovery?{recoveryAdmission:reportsRecovery,migrationRunsThisCandidate:0,seedRunsThisCandidate:0}:{}),...(reportsPrefix?{prefixContinuationAdmission:reportsPrefix,fixtureInvocationKinds:['bounded-prefix-continuation','read-only-completed-fixture-proof'],migrationRunsThisCandidate:0,seedRunsThisCandidate:0,provisioningRunsThisCandidate:0,companyCreationRunsThisCandidate:0}:{}),fixture:preparedFixture,applicationAcceptance:'UNVERIFIED'});
    }
    const hr=identities.actors.find(actor=>actor.login===({integration:'board-ten-fixture:hr',schedules:'board15-schedules:hr',holidays:'board15-holidays:hr',approval:'approval15-fixture:HR',inquiry:'inquiry15-fixture:hr',personnel:'personnel15-fixture:HR',reports:'report18-fixture:HR_A'})[scenario]);
    const defaultHr=scenario==='labels'?identities.actors.find(actor=>actor.id===preparedFixture.people.GroupHR.userId):hr;
    if(!defaultHr)throw new Error('Exact fictional HR principal missing.');
    env.DEV_USER_ID=defaultHr.id;env.DEV_TENANT_ID=preparedFixture.tenantId;
    if(stopping||stopRequested()||Date.now()>=deadline)throw new Error('Stopped before app startup.');
    await assertPortFree();checkCandidate();
    serverFd=fs.openSync(path.join(out,devLogName),'wx',0o600);
    server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port',port],{cwd:root,env,stdio:['ignore',serverFd,serverFd],detached:true});
    server.once('error',error=>{fs.appendFileSync(path.join(out,devLogName),'\nSpawn failed: '+error.message+'\n');runFailed=true;process.exitCode=1;stopping=true;});
    ownedServerPid=server.pid;
    if(!Number.isSafeInteger(server.pid)||server.pid<=1)throw new Error('Owned server PID unavailable.');
    fs.writeFileSync(path.join(out,'browser.pid'),String(server.pid)+'\n',{mode:0o600});
    console.log(options.resume?`Resuming candidate ${candidate} from preparation ${preparationCandidate}; NO migration, seed or fixture ran for this candidate. Local app http://127.0.0.1:${port}; application outcomes remain unverified.`:`${reportsPrefix?'Bounded prefix continuation and read-only completed fixture proof exited cleanly':'Fixture exited cleanly twice'} with identical declared facts. Owned candidate ${candidate}; local app http://127.0.0.1:${port}; render/application outcomes remain unverified.`);
    console.log(`First route ${options.route}. Stop via ${stopFile}. Only owned process group ${server.pid} will be stopped. Both slots and DB stay held until cleanup.`);
    while(!stopping && !stopRequested() && Date.now()<deadline) {
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
    // A current stop is cleanup provenance, including failure, never application acceptance.
    // No receipt is published if an owned process or database handle failed to close.
    if(Number.isSafeInteger(ownedServerPid)&&ownedServerPid>1) {
      const receipt={candidate,preparationCandidate,...bound,resumeReceipt,devLogName,serverPid:ownedServerPid,ownedServerStopped:true,cleanupSucceeded:true,outcome:runFailed?'failed':'stopped',exitCode:runFailed?1:0,stoppedAt:new Date().toISOString()};
      const temporary=path.join(out,'browser-stopped.json.tmp-'+process.pid);
      writeNew('browser-stop-'+runId+'.json',receipt);
      fs.writeFileSync(temporary,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
      fs.renameSync(temporary,path.join(out,'browser-stopped.json'));
      console.log(`Owned original18 cleanup complete (${receipt.outcome}); coordinator may release both slots + DB. No acceptance PASS claimed.`);
    }
  }
}
