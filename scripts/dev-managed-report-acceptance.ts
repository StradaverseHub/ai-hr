/** One root-staged INTERNAL acceptance entry for the owned disposable Lima VM. Not a product route.
 * prepare -> real human enrollment/configuration -> configure -> installed handoff -> verify.
 * No Auth/consent writes, provider mock, generated MFA, pasted recipient or alternate scheduler.
 */
import fs from 'node:fs/promises';
import {constants,readFileSync} from 'node:fs';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {request} from 'node:http';
import {startReportSmtpSink,reportAttachment} from '../test/fixtures/managed-report-delivery/smtp-sink';
import {confirmOwnedReportArtifactRemoval,assertOwnedReportArtifactAbsent,ownedReportArtifactPath} from '../test/fixtures/managed-report-delivery/artifact-cleanup';
import {internalReportAcceptanceMarker,reportAcceptanceHumanReady,reportAcceptanceBase,reportAcceptanceComponents,reportAcceptanceMode,reportAcceptanceDatabase,reportAcceptanceSameEndpoint,REPORT_ACCEPTANCE_DATABASE as DATABASE,REPORT_ACCEPTANCE_ORIGIN as ORIGIN,REPORT_ACCEPTANCE_TENANT as TENANT,REPORT_ACCEPTANCE_EMAILS as EMAILS,REPORT_ACCEPTANCE_ROOT as ROOT,REPORT_ACCEPTANCE_STAGING as STAGING,type ReportAcceptanceBase} from './managed-report-acceptance-model';
import {readTrustedDispatchFile,internalReportDispatchMarker,INTERNAL_REPORT_DISPATCH_MARKER,readDispatchSourcePins,reportDispatchInstance,INTERNAL_REPORT_DISPATCH_CRON,INTERNAL_REPORT_DISPATCH_CRON_SOURCE} from '../lib/employee-master-dispatch';
import {classifyReportProcess,schedulingInventory,INTERNAL_REPORT_SCHEDULE_STATE,INTERNAL_REPORT_SCHEDULE_LOCK} from '../deploy/identity-email/report-scheduling';
import {captureAcceptanceGroup,acceptanceProcessStat,acceptanceGroupMembers,stopOwnedAcceptanceGroup,bindAcceptanceActivationReceipt,bindAcceptanceActivationMarker,type AcceptanceProcessPin,type AcceptanceActivationBinding} from './managed-report-acceptance-lifecycle';
import {LEGACY_MODULE_ENV_GATES,LEGACY_SETTING_ENV_GATES} from '../packs/catalog';
import {reportBrokerResponse} from '../lib/internal-auth/report-broker-model';
import {assertManagedReportWorkbook} from './managed-report-workbook-evidence';
import {assertManagedReportAuthorityRefusal} from './managed-report-authority-evidence';
import {fingerprintOwnedReportArtifact} from '../deploy/identity-email/report-artifact';
import {REPORT_INSPECTION_LIFETIME_MS} from '../lib/internal-auth/report-broker-proof';
import type {SessionContext} from '../db/client';
const MARKER='/etc/aihr-report-acceptance.json',SMTP_PORT=24656,SYSTEM='00000000-0000-0000-0000-000000000000';
const SOCKET='/run/aihr-internal-report.sock',BROKER='/run/aihr-report-auth.sock',RENDERER='/run/aihr-report-renderer.sock';
const INTERNAL_NODE='/usr/local/lib/aihr-identity-email/internal-node',SCHEDULE='/usr/local/lib/aihr-identity-email/internal-report-schedule.cjs';
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const mode=reportAcceptanceMode(process.argv.slice(2)),safeEnv={NODE_ENV:'production' as const,PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'};
const command=(program:string,args:string[])=>execFileSync(program,args,{encoding:'utf8',timeout:30_000,maxBuffer:1024*1024,env:safeEnv,stdio:['ignore','pipe','pipe']}).trim();
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
type OwnedChild={child:ChildProcess;processGroupGate:Promise<AcceptanceProcessPin>;stop?:Promise<void>};
const children=new Set<OwnedChild>(),artifacts:{id:string;token:string}[]=[],ownedOccurrences=new Set<string>(),ownedReports=new Set<string>();
let fixtureTenant:string|undefined;
let disableOwnedSchedules:(()=>Promise<void>)|undefined;
const active=()=>check(!stopped&&Date.now()<hardDeadline,'Fixture stopped or deadline expired.');
function trackArtifact(pair:{id:string;token:string}){ownedReportArtifactPath(pair);ownedOccurrences.add(pair.id);if(!artifacts.some(value=>value.id===pair.id&&value.token===pair.token))artifacts.push(pair);check(artifacts.length<=200,'Owned artifact identity inventory exceeds bound.');}
let sink:Awaited<ReturnType<typeof startReportSmtpSink>>|undefined,owner:ReturnType<(typeof import('../db/client'))['createDb']>|undefined;
let appClient:{end(options?:{timeout?:number}):Promise<unknown>}|undefined,lock:Awaited<ReturnType<typeof fs.open>>|undefined;
let out:string|undefined,stage='preflight',stopped=false,scheduleInstallation:string|undefined,legacyUid:number|undefined,inventoryBefore:string|undefined;
let preservedDeliveryMessages=0;
async function preserveDeliveryMail(){
 if(!out||!sink)return;
 while(preservedDeliveryMessages<sink.messages.length){
  const index=preservedDeliveryMessages,message=sink.messages[index],sha256=hash(message.raw),name='delivery-mail-'+String(index).padStart(3,'0')+'-'+sha256;
  await fs.writeFile(out+'/'+name+'.eml',message.raw,{mode:0o600,flag:'wx'});
  await fs.writeFile(out+'/'+name+'.json',JSON.stringify({index,sha256,byteLength:message.raw.length})+'\n',{mode:0o600,flag:'wx'});
  preservedDeliveryMessages++;
 }
}
function failureFingerprint(error:unknown){
 if(!(error instanceof Error))return {name:'NonError'};
 const message=Buffer.from(error.message.slice(0,4096),'utf8'),bounded=message.subarray(0,4096);
 const name=['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','AggregateError'].includes(error.name)?error.name:'OtherError';
 return {name,messageSha256:hash(bounded),messageBytesHashed:bounded.length,truncated:error.message.length>4096||message.length>4096};
}
let cronStarted=false,managedUsed=false,memoryTimer:ReturnType<typeof setInterval>|undefined,cleanupPromise:Promise<void>|undefined;
let activationAttempted=false,activationBaseline:({receipts:Set<string>}&AcceptanceActivationBinding)|undefined;
let runtimePath:string|undefined;const memory={aggregate:0,dispatch:0,sender:0,broker:0,renderer:0};
const startedAt=Date.now(),hardDeadline=startedAt+40*60_000;
async function groupMembers(pin:AcceptanceProcessPin){
 const names=(await fs.readdir('/proc')).filter(name=>/^\d+$/.test(name));check(names.length<=10000,'Process inventory exceeds bound.');
 const stats=[];for(const name of names)try{stats.push(acceptanceProcessStat(await fs.readFile('/proc/'+name+'/stat','utf8')));}catch(error){if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
 return acceptanceGroupMembers(pin,stats);
}
async function stopChild(entry:OwnedChild){return entry.stop??=(async()=>{
 const pin=await entry.processGroupGate;
 await stopOwnedAcceptanceGroup({members:()=>groupMembers(pin),signal:signal=>process.kill(-pin.pid,signal),now:Date.now,delay:sleep});children.delete(entry);
})();}
async function drainOwnedChildren(){for(const entry of [...children])await stopChild(entry);check(children.size===0,'Owned child group inventory did not drain.');}
async function boundedWait(probe:()=>Promise<boolean>,deadline:number){while(!await probe()){check(!stopped&&Date.now()<Math.min(deadline,hardDeadline),'Stage stopped or timed out; preserve evidence.');await sleep(250);}}
async function rootFile(file:string,max=1_000_000){return readTrustedDispatchFile(file,max,0o600);}
async function privateJson(file:string){return JSON.parse((await rootFile(file)).toString('utf8'));}
async function run(program:string,args:string[],timeout=30_000,input?:string){
 check(!stopped||cleanupPromise,'Stopped fixture cannot start a new command.');
 check(program.startsWith('/'),'Only absolute reviewed child executables are allowed.');
 // Hold this detached leader at a one-byte stdin handshake until its Linux lifetime is pinned.
 // exec preserves PID/start ticks/group/session; even an immediately exiting target is owned.
 const launcher="import os,sys\nif os.read(0,1)!=b'1':raise SystemExit(1)\nos.execv(sys.argv[1],sys.argv[1:])";
 const child=spawn('/usr/bin/python3',['-I','-c',launcher,program,...args],{detached:true,env:safeEnv,stdio:['pipe','pipe','pipe']});
 const processGroupGate=new Promise<AcceptanceProcessPin>((resolve,reject)=>{child.once('spawn',()=>{try{check(child.pid,'Missing spawned PID.');const pin=captureAcceptanceGroup(readFileSync('/proc/'+child.pid+'/stat','utf8'),child.pid);resolve(pin);child.stdin.end('1'+(input??''));}catch(error){reject(error);}});child.once('error',reject);});
 void processGroupGate.catch(()=>{});const entry:OwnedChild={child,processGroupGate};children.add(entry);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await new Promise<string>((resolve,reject)=>{let bytes=0,text='';
  timer=setTimeout(()=>reject(new Error('Reviewed child command timed out.')),timeout);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024)reject(new Error('Reviewed child output exceeds bound.'));else text+=chunk.toString();});child.stderr.resume();
  child.on('error',reject);child.stdin.on('error',reject);child.on('close',code=>{code===0&&bytes<=1024*1024?resolve(text.trim()):reject(new Error('Reviewed child command refused.'));});
 });}finally{if(timer)clearTimeout(timer);await stopChild(entry);}
}
async function absentFile(file:string){try{await fs.lstat(file);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}}
async function assertSchedulingLockAbsent(){
 check(await absentFile(INTERNAL_REPORT_SCHEDULE_LOCK),'Canonical scheduling lock remains; owned acceptance lock retained.');
}
async function receiptNames(){
 try{const st=await fs.lstat(INTERNAL_REPORT_SCHEDULE_STATE);check(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===0&&(st.mode&0o777)===0o700,'Untrusted scheduling state.');const names=await fs.readdir(INTERNAL_REPORT_SCHEDULE_STATE);check(names.length<=1000&&names.every(name=>/^[0-9a-f-]{36}\.json$/i.test(name)),'Unknown scheduling state inventory.');return new Set(names);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return new Set<string>();throw error;}
}
async function captureActivationBaseline(web:Record<string,string>):Promise<{receipts:Set<string>}&AcceptanceActivationBinding>{
 active();await assertSchedulingLockAbsent();
 check(await absentFile(INTERNAL_REPORT_DISPATCH_MARKER)&&await absentFile(INTERNAL_REPORT_DISPATCH_CRON),'Preexisting scheduling handoff is not owned.');
 const inventory=await schedulingInventory();check(inventory.sha256===inventoryBefore,'Pre-activation inventory changed.');
 const node20Path=await fs.realpath('/opt/node20/bin/node');
 return {receipts:await receiptNames(),inventorySha256:inventory.sha256,node20Path,node20Sha256:hash(await rootExecutable(node20Path)),marker:{version:1 as const,purpose:'aihr-internal-report-dispatch' as const,runnerUser:inventory.legacyUser,runnerGroup:inventory.legacyGroup,runnerUid:inventory.legacyUid,runnerGid:inventory.legacyGid,candidateRoot:ROOT,sourcePins:await readDispatchSourcePins(),runtimeSha256:hash(await rootExecutable(await fs.realpath(INTERNAL_NODE))),instanceSha256:reportDispatchInstance(web.AUTH_PROVIDER,web.DATABASE_URL),cronSha256:hash(INTERNAL_REPORT_DISPATCH_CRON_SOURCE)}};
}
async function recoverPartialActivation(){
 if(!activationAttempted)return;check(activationBaseline,'Missing exact pre-activation ownership baseline.');
 const currentReceipts=await receiptNames();check([...activationBaseline.receipts].every(name=>currentReceipts.has(name)),'Preexisting scheduling receipts changed.');
 const added=[...currentReceipts].filter(name=>!activationBaseline!.receipts.has(name));check(added.length<=1,'Ambiguous partial activation receipts.');
 const markerAbsent=await absentFile(INTERNAL_REPORT_DISPATCH_MARKER),cronAbsent=await absentFile(INTERNAL_REPORT_DISPATCH_CRON);
 if(!added.length){check(markerAbsent&&cronAbsent&&!scheduleInstallation,'Unreceipted scheduling files remain.');return;}
 const id=added[0].slice(0,-5),receiptMarker=bindAcceptanceActivationReceipt(JSON.parse((await rootFile(INTERNAL_REPORT_SCHEDULE_STATE+'/'+added[0],8192)).toString()),id,activationBaseline);
 if(markerAbsent){check(cronAbsent&&!scheduleInstallation,'Partial scheduling cron exists without marker.');return;} // Receipt only: retain canonical history, never blindly unlink.
 const marker=bindAcceptanceActivationMarker(JSON.parse((await readTrustedDispatchFile(INTERNAL_REPORT_DISPATCH_MARKER,4096,0o644)).toString()),receiptMarker);
 check(!scheduleInstallation||scheduleInstallation===marker.installationId,'Successful and discovered installation differ.');scheduleInstallation=marker.installationId;
}
async function releaseOwnedLock(){
 await assertSchedulingLockAbsent();if(!lock)return;const held=await lock.stat(),current=await fs.lstat('/run/aihr-report-acceptance.lock');
 check(current.isFile()&&!current.isSymbolicLink()&&current.uid===0&&current.nlink===1&&current.dev===held.dev&&current.ino===held.ino&&(current.mode&0o777)===0o600,'Owned acceptance lock changed.');
 check((await rootFile('/run/aihr-report-acceptance.lock',32)).toString()===String(process.pid),'Owned acceptance lock payload changed.');
 await lock.close();const fresh=await fs.lstat('/run/aihr-report-acceptance.lock');check(fresh.dev===held.dev&&fresh.ino===held.ino&&!fresh.isSymbolicLink(),'Acceptance lock changed before release.');await fs.unlink('/run/aihr-report-acceptance.lock');lock=undefined;
}
async function runnerIdle(){
 check(legacyUid!==undefined,'Missing exact scheduler identity.');const names=(await fs.readdir('/proc')).filter(name=>/^\d+$/.test(name));check(names.length<=10000,'Process inventory too large.');let found=false;
 const legacyExe=await fs.realpath('/opt/node20/bin/node');
 for(const name of names)try{const prefix='/proc/'+name,raw=await fs.readFile(prefix+'/cmdline');check(raw.length<=65536,'Process command exceeds bound.');const args=raw.toString().split('\0').filter(Boolean);if(!args.some(value=>value.includes('provision-runner.ts')||value.includes('--installed-internal-reports-only')||value==='/usr/local/lib/aihr-identity-email/internal-report-tick'))continue;
  const [cwd,exe,stat]=await Promise.all([fs.readlink(prefix+'/cwd'),fs.readlink(prefix+'/exe'),fs.lstat(prefix)]);if(classifyReportProcess(args,cwd,exe,stat.uid,legacyUid,legacyExe))found=true;
 }catch(error){if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
 return !found;
}
async function peer(socket:typeof BROKER|typeof RENDERER,body:unknown){
 // No root impersonation: the kernel observes the actual installed mail UID. No keys/credentials in env.
 const encoded=JSON.stringify(body);check(Buffer.byteLength(encoded)<=4096,'Peer request exceeds bound.');
 if(socket===BROKER)return JSON.parse(await run('/usr/sbin/runuser',['-u','aihr-identity-email','--','/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C','TZ=UTC','/usr/bin/python3','-I','/usr/local/lib/aihr-identity-email/report-auth-peer.py','--client'],45_000,encoded)) as Record<string,unknown>;
 const program=`import socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(100);s.connect('${socket}');s.sendall(sys.stdin.buffer.read(4097));s.shutdown(socket.SHUT_WR);b=b''\nwhile True:\n c=s.recv(4096)\n if not c:break\n b+=c\n if len(b)>524288:raise RuntimeError('oversized')\nsys.stdout.buffer.write(b)`;
  return JSON.parse(await run('/usr/sbin/runuser',['-u','aihr-identity-email','--','/usr/bin/python3','-I','-c',program],105_000,encoded)) as Record<string,unknown>;
}
const renderer=(body:unknown)=>peer(RENDERER,body);
async function delivery(body:unknown){return new Promise<{outcome?:string;ready?:boolean;version?:number}>((resolve,reject)=>{
 const req=request({socketPath:SOCKET,path:'/v1/reports',method:'POST',headers:{'content-type':'application/json'},timeout:245_000},res=>{let text='';res.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>4096)res.destroy();});res.on('error',reject);res.on('end',()=>{try{check(res.statusCode===200,'Private sender refused.');resolve(JSON.parse(text));}catch(error){reject(error);}});});req.on('timeout',()=>req.destroy(new Error('Sender timeout.')));req.on('error',reject);req.end(JSON.stringify(body));
});}
async function privateWorkersIdle(){
 const rows=command('systemctl',['list-units','--all','--no-legend','--plain','--state=active,activating,deactivating','aihr-report-auth@*.service','aihr-report-renderer@*.service']).split('\n').filter(Boolean);
 for(const row of rows){const name=row.trim().split(/\s+/)[0];check(/^aihr-report-(?:auth|renderer)@[-a-zA-Z0-9_.\\]+\.service$/.test(name),'Unknown private worker unit.');}
 return rows.length===0;
}
async function cleanupWait(probe:()=>Promise<boolean>,timeout:number){const deadline=Date.now()+timeout;while(!await probe()){check(Date.now()<deadline,'Owned cleanup drain timed out.');await sleep(250);}}
async function cleanup(){return cleanupPromise??=(async()=>{
 const force=setTimeout(()=>process.exit(1),5*60_000);let failure:unknown;
 try{
  if(memoryTimer)clearInterval(memoryTimer);
  if(cronStarted){command('systemctl',['stop','cron.service']);cronStarted=false;await cleanupWait(runnerIdle,120_000);}
  await drainOwnedChildren();
  await assertSchedulingLockAbsent();
  await recoverPartialActivation();
  // Only the canonical handoff may remove its exact marker/cron; all user crontabs stay byte-identical.
  if(scheduleInstallation){check(runtimePath,'Missing reviewed runtime.');await run(INTERNAL_NODE,[SCHEDULE,'--rollback',scheduleInstallation],180_000);scheduleInstallation=undefined;check((await schedulingInventory()).sha256===inventoryBefore,'Scheduler inventory changed during cleanup.');}
  if(managedUsed)command('systemctl',['stop','aihr-internal-report.service']);
  if(managedUsed){
   await cleanupWait(privateWorkersIdle,110_000);
   check(owner&&fixtureTenant,'Missing owned artifact source scope.');const occurrences=await owner.client`select id from custom_report_occurrence where tenant_id=${fixtureTenant}::uuid and report_id=any(${[...ownedReports]}::uuid[]) limit 101`;check(occurrences.length<=100,'Owned occurrence inventory exceeds bound.');for(const occurrence of occurrences)ownedOccurrences.add(String(occurrence.id));
   const files=(await fs.readdir('/var/lib/aihr-report-renderer/render')).filter(name=>name.endsWith('.xlsx'));check(files.length<=20,'Artifact budget or ownership inventory changed.');
   for(const file of files){const matched=/^([0-9a-f-]{36})-([0-9a-f-]{36})\.xlsx$/i.exec(file);check(matched&&ownedOccurrences.has(matched[1]),'Unowned artifact remains; refuse rather than unlink it.');trackArtifact({id:matched[1],token:matched[2]});}
  }
  // These exact reports were captured by this invocation. Never leave due fault copies for a later run.
  if(disableOwnedSchedules)await disableOwnedSchedules();
  for(const artifact of artifacts)await confirmOwnedReportArtifactRemoval(artifact,renderer);
  if(managedUsed)await cleanupWait(privateWorkersIdle,110_000);
  for(const artifact of artifacts)await assertOwnedReportArtifactAbsent(artifact);
  if(managedUsed)check(!(await fs.readdir('/var/lib/aihr-report-renderer/render')).some(name=>name.endsWith('.xlsx')),'Artifact appeared after cleanup; no verified receipt.');
 }catch(error){failure=error;}
 finally{
  for(const close of [async()=>{if(sink)await sink.close();},async()=>{if(owner)await owner.client.end({timeout:5});},async()=>{if(appClient)await appClient.end({timeout:5});}])try{await close();}catch(error){failure??=error;}
  try{if(!failure)await releaseOwnedLock();}catch(error){failure??=error;}finally{clearTimeout(force);}
 }
 if(failure){console.error('Cleanup unresolved; owned lock retained.');throw failure;}
})();}
let stopDeadline:ReturnType<typeof setTimeout>|undefined;
function requestStop(){
 if(stopped)return;stopped=true;
 // Do not release the lock while main can still resume a canonical writer. Its normal rejection
 // joins cleanup below; a stuck writer leaves the exact lock/evidence for operator inspection.
 stopDeadline=setTimeout(()=>{console.error('Stopped writer did not settle; owned lock retained.');process.exit(1);},120_000);
 if(cronStarted)try{command('systemctl',['stop','cron.service']);}catch{console.error('Cron stop unresolved; owned lock retained.');}
 void drainOwnedChildren().catch(()=>{console.error('Child stop unresolved; owned lock retained.');});
}
const watchdog=setTimeout(requestStop,40*60_000);
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,requestStop);
type Base=ReportAcceptanceBase;
async function main(){
 check(process.platform==='linux'&&process.arch==='arm64'&&process.getuid?.()===0&&process.version==='v22.23.1','Only the reviewed owned ARM Linux Node22.23.1 course is allowed.');
 check(command('systemd-detect-virt',['--vm']).length>0&&command('systemctl',['is-system-running'])==='running','Actual dedicated systemd VM required.');
 const marker=internalReportAcceptanceMarker.parse(await privateJson(MARKER));
 check(hash(await fs.readFile('/etc/machine-id'))===marker.machineSha256,'This is not the reviewed disposable machine.');
 runtimePath=await fs.realpath(process.execPath);check(runtimePath===marker.runtimePath&&hash(await rootExecutable(runtimePath))===marker.nodeSha256,'Root-reviewed runtime pin differs.');
 check(process.argv[1]===STAGING+'/fixture.cjs'&&hash(await rootFile(process.argv[1],40_000_000))===marker.fixtureSha256,'Use only the reviewed root-staged fixture bundle.');
 check(hash(await rootFile(STAGING+'/internal-report-upgrade.cjs',60_000_000))===marker.installerSha256,'Installer source pin differs.');
 check(await fs.realpath(ROOT)===ROOT&&command('git',['-C',ROOT,'rev-parse','HEAD'])===marker.candidateSha&&!command('git',['-C',ROOT,'status','--porcelain']),'Clean exact integrated candidate required.');
 const rootStat=await fs.lstat(ROOT);check(rootStat.isDirectory()&&rootStat.uid===0&&(rootStat.mode&0o022)===0,'Trusted source root required.');
 process.chdir(ROOT);
 const show=(name:string)=>command('systemctl',['show',marker.webUnit,'--property='+name,'--value']);
 check(show('LoadState')==='loaded'&&show('ActiveState')==='active'&&show('WorkingDirectory')===ROOT&&show('DynamicUser')!=='yes','Actual fixed web unit required.');
 const pid=Number(show('MainPID')),user=show('User');check(pid>1&&user&&user!=='root','Non-root actual web principal required.');
 const uid=Number(command('id',['-u',user]));check((await fs.lstat('/proc/'+pid)).uid===uid&&(await fs.readFile('/proc/'+pid+'/cgroup','utf8')).split('\n').some(line=>line.endsWith('/'+marker.webUnit)),'Web process identity differs.');
 const web:Record<string,string>={};for(const item of (await fs.readFile('/proc/'+pid+'/environ','utf8')).split('\0')){const at=item.indexOf('=');if(at>0)web[item.slice(0,at)]=item.slice(at+1);}
 check(show('MainPID')===String(pid)&&web.AUTH_PROVIDER==='internal'&&web.AUTH_PUBLIC_ORIGIN===ORIGIN&&!web.MIGRATION_DATABASE_URL&&web.ALLOW_DEMO_SESSION!=='true','Canonical active internal web configuration required.');
 const app=reportAcceptanceDatabase(web.DATABASE_URL??'','ai_hr_app'),privateOwner=await privateJson(STAGING+'/owner.json');
 check(Object.keys(privateOwner).join(',')==='databaseUrl'&&typeof privateOwner.databaseUrl==='string','Separate private owner input required.');const migration=reportAcceptanceDatabase(privateOwner.databaseUrl);reportAcceptanceSameEndpoint(app,migration);
 const ca=await rootFile(STAGING+'/ca.pem'),key=await rootFile(STAGING+'/server.key'),cert=await rootFile(STAGING+'/server.pem');
 check(hash(ca)===marker.caSha256&&hash(key)===marker.serverKeySha256&&hash(cert)===marker.certificateSha256,'Reviewed local TLS fixture bytes required.');
 const publicCa='/usr/local/share/ca-certificates/aihr-report-acceptance.crt';const publicStat=await fs.lstat(publicCa);check(publicStat.isFile()&&!publicStat.isSymbolicLink()&&publicStat.uid===0&&(publicStat.mode&0o022)===0&&hash(await fs.readFile(publicCa))===marker.caSha256&&web.NODE_EXTRA_CA_CERTS===publicCa&&process.env.NODE_EXTRA_CA_CERTS===publicCa,'Actual web and fixture must already trust the same root-reviewed public CA.');
 for(const service of ['cron.service','crond.service']){let active='';try{active=command('systemctl',['is-active',service]);}catch{}check(active!=='active','Cron must initially be stopped on this dedicated VM.');}
 for(const name of ['AUTH_PROVIDER','AUTH_PUBLIC_ORIGIN','AUTH_SESSION_KEY','DATABASE_URL']){if(process.env[name]!==undefined)check(process.env[name]===web[name],'Caller cannot override active web Auth/database authority.');process.env[name]=web[name];}
 for(const name of [...new Set([...Object.values(LEGACY_MODULE_ENV_GATES),...Object.values(LEGACY_SETTING_ENV_GATES)])])if(name){delete process.env[name];if(web[name]!==undefined)process.env[name]=web[name];}
 delete process.env.DEV_TENANT_ID;delete process.env.DEV_USER_ID;process.env.ALLOW_DEMO_SESSION='false';if(web.AUDIT_HASH_CHAIN_ENABLED!==undefined)process.env.AUDIT_HASH_CHAIN_ENABLED=web.AUDIT_HASH_CHAIN_ENABLED;else delete process.env.AUDIT_HASH_CHAIN_ENABLED;
 Object.assign(process.env,{NODE_ENV:web.NODE_ENV??'production'});process.env.MIGRATION_DATABASE_URL=migration.toString();
 out='/var/lib/aihr-report-acceptance/'+marker.runId;await fs.mkdir(out,{recursive:true,mode:0o700});const st=await fs.lstat(out);check(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===0&&(st.mode&0o777)===0o700,'Private owned evidence directory required.');
 lock=await fs.open('/run/aihr-report-acceptance.lock',constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await lock.writeFile(String(process.pid));
 const dbModule=await import('../db/client'),s=await import('../db/schema'),q=await import('drizzle-orm');appClient=dbModule.client;owner=dbModule.createDb(migration.toString(),{max:1});
 const [appRole]=await dbModule.client`select current_user as name,current_database() as database,inet_server_addr()::text as address,inet_server_port() as port,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,exists(select 1 from pg_auth_members m where m.member=r.oid) as member,exists(select 1 from pg_class c where c.relowner=r.oid) as owns_table,exists(select 1 from pg_namespace n where n.nspowner=r.oid) as owns_schema from pg_roles r where rolname=current_user`;
 const [ownerRole]=await owner.client`select current_user as name,current_database() as database,inet_server_addr()::text as address,inet_server_port() as port,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb from pg_roles where rolname=current_user`;
 check(appRole?.name==='ai_hr_app'&&!appRole.rolsuper&&!appRole.rolbypassrls&&!appRole.rolcreaterole&&!appRole.rolcreatedb&&!appRole.rolreplication&&!appRole.member&&!appRole.owns_table&&!appRole.owns_schema&&appRole.database===DATABASE&&ownerRole?.name===decodeURIComponent(migration.username)&&ownerRole.database===DATABASE&&!ownerRole.rolsuper&&!ownerRole.rolbypassrls&&!ownerRole.rolcreaterole&&!ownerRole.rolcreatedb&&appRole.address===ownerRole.address&&appRole.port===ownerRole.port,'Actual restricted roles/endpoint differ.');
 const [authority]=await owner.client`select pg_has_role(current_user,pg_get_userbyid(c.relowner),'MEMBER') as allowed from pg_class c where c.oid='public.custom_report_occurrence'::regclass`;check(authority?.allowed===true,'Actual canonical migration owner required.');
 const journal=JSON.parse(await fs.readFile(ROOT+'/db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number}[]};
 const applied=await owner.client`select hash,created_at from drizzle.__drizzle_migrations order by id`;
 check(applied.length===journal.entries.length,'Apply the exact current full journal; a count is not a migration number.');
 for(let i=0;i<applied.length;i++)check(String(applied[i].created_at)===String(journal.entries[i].when)&&applied[i].hash===hash(await fs.readFile(ROOT+'/db/migrations/'+journal.entries[i].tag+'.sql')),'Applied migration content differs from candidate.');
 for(const name of ['app.employee_master_internal_render_context(uuid,uuid,text)','app.internal_auth_report_lock_context(uuid,uuid,text)','identity_email.queue_report(uuid,timestamptz,timestamptz)']){const [row]=await owner.client`select to_regprocedure(${name}) present`;check(row?.present,'Canonical internal Report/Auth prerequisite missing.');}
 const {resolveEntitlementsTx}=await import('../core/entitlements');
 async function context(person:{userId:string;personId:string},tenantId:string):Promise<SessionContext>{const grants=await owner!.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(q.and(q.eq(s.roleAssignment.appUserId,person.userId),q.eq(s.roleAssignment.tenantId,tenantId))).orderBy(q.asc(s.roleAssignment.id));return {tenantId,userId:person.userId,personId:person.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements:await owner!.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId))};}
 let base:Base|undefined;try{base=reportAcceptanceBase.parse(await privateJson(out+'/fixture.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const tenants=await owner.db.select({id:s.tenant.id,name:s.tenant.name}).from(s.tenant);
 check(tenants.every(t=>t.id===SYSTEM||base&&t.id===base.tenantId&&t.name===TENANT),'Unknown tenant; no demo seed/reset/repair.');
 if(mode==='prepare'){
  check(!base&&tenants.length===1&&tenants[0].id===SYSTEM,'Prepare is fresh-only; use configure for the exact existing fixture.');
  const {provisionTenant}=await import('../db/provision'),{createDepartment,assignRole}=await import('../core/admin'),{hireEmployee}=await import('../core/org'),{setCompensation}=await import('../core/comp'),{todayInKualaLumpur}=await import('../lib/hr-date');
  const made=await owner.db.transaction(tx=>provisionTenant(tx,{name:TENANT,adminEmail:EMAILS.owner,country:'MY',modules:['notifications','payroll'],baseUrl:ORIGIN}));
  // Limited fictional bootstrap grants only. Genuine Auth/bindings are created later by canonical root enrollment.
  await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:made.appUserId,role:'hr_admin',companyId:null});
  const admin=await context({userId:made.appUserId,personId:made.personId},made.tenantId),dept=await createDepartment(admin,{companyId:made.companyId,name:'Fictional report delivery team'}),date=todayInKualaLumpur();
  const employedOwner=await hireEmployee(admin,{person:{id:made.personId},companyId:made.companyId,departmentId:dept.id,employeeCode:'REPORT-OWNER',employmentType:'full_time',hiredOn:date});
  const employee=await hireEmployee(admin,{person:{fullName:'Fictional report recipient',primaryEmail:EMAILS.recipient},companyId:made.companyId,departmentId:dept.id,employeeCode:'REPORT-RECIPIENT',employmentType:'full_time',hiredOn:date});
  const [recipient]=await owner.db.insert(s.appUser).values({tenantId:made.tenantId,personId:employee.personId,workosUserId:'report-acceptance:recipient',onboardedAt:new Date()}).returning();await assignRole(admin,{appUserId:recipient.id,role:'hr_admin'});
  for(const employmentId of [employedOwner.employmentId,employee.employmentId])await setCompensation(admin,{employmentId,basicSalary:3500,currency:'MYR',effectiveFrom:date});
  base={version:2,candidateSha:marker.candidateSha,runId:marker.runId,tenantId:made.tenantId,companyId:made.companyId,date,owner:{userId:made.appUserId,personId:made.personId,employmentId:employedOwner.employmentId},recipient:{userId:recipient.id,personId:employee.personId,employmentId:employee.employmentId},routes:{login:ORIGIN+'/login',email:ORIGIN+'/admin/settings/email',policy:ORIGIN+'/admin/settings/notifications',consent:ORIGIN+'/me/notifications',newReport:ORIGIN+'/reports/employee-master/new'}};
  await fs.writeFile(out+'/fixture.json',JSON.stringify(base,null,2)+'\n',{mode:0o600,flag:'wx'});console.log('Fictional HR graph prepared privately. Human enrollment/MFA, SMTP, policy, consent and report UI are UNRUN. Read the owned fixture.json IDs; continue configure.');return;
 }
 check(base&&base.version===2&&base.runId===marker.runId&&base.candidateSha===marker.candidateSha&&tenants.length===2,'Exact completed prepare receipt required.');
 const {todayInKualaLumpur}=await import('../lib/hr-date');check(base.date===todayInKualaLumpur(),'KL date changed; preserve this journey rather than reseeding.');
 fixtureTenant=base.tenantId;
 const admin=await context(base.owner,base.tenantId),recipient=await context(base.recipient,base.tenantId);
 for(const ctx of [admin,recipient])check(JSON.stringify(ctx.grants)===JSON.stringify([{role:'hr_admin',companyId:null}]),'Exact fictional administrator grants changed.');
 for(const [key,actor] of [['owner',base.owner],['recipient',base.recipient]] as const){const [user]=await owner.db.select().from(s.appUser).where(q.eq(s.appUser.id,actor.userId));const [person]=await owner.db.select().from(s.person).where(q.eq(s.person.id,actor.personId));const [employment]=await owner.db.select().from(s.employment).where(q.eq(s.employment.id,actor.employmentId));check(user?.tenantId===base.tenantId&&user.personId===actor.personId&&!user.archivedAt&&person?.primaryEmail===EMAILS[key]&&employment?.personId===actor.personId&&employment.companyId===base.companyId&&!employment.terminatedOn,'Exact fictional source graph changed.');}
 const {readRecord}=await import('../lib/internal-auth/record-store');
 const {parseCredential,assertActiveCredential}=await import('../lib/internal-auth/credential'),{internalIssuer}=await import('../lib/internal-auth/config'),{readActiveRelayTx}=await import('../lib/internal-auth/active-relay');
 const {resolveEmployeeMasterRecipients}=await import('../core/notification-email');
 async function humanReadback(){
  // The root fixture owner may inspect only these declared binding rows. App Auth reads remain
  // through canonical readRecord/assertActiveCredential; this setup readback is not atomic send authority.
  const bindings=new Map<string,{issuer:string;subject:string}>();
  for(const [key,actor] of [['owner',base!.owner],['recipient',base!.recipient]] as const){const rows=await owner!.client`select issuer,subject from app_external_identity where app_user_id=${actor.userId}::uuid and issuer=${internalIssuer(base!.tenantId)} and revoked_at is null`;check(rows.length===1&&typeof rows[0].issuer==='string'&&typeof rows[0].subject==='string','Complete exact canonical human enrollment first.');bindings.set(key,{issuer:rows[0].issuer,subject:rows[0].subject});}
  const proof=await dbModule.client.begin('isolation level repeatable read read only',async tx=>{
   const identities=[];for(const [key,actor] of [['owner',base!.owner],['recipient',base!.recipient]] as const){const binding=bindings.get(key)!;const c=parseCredential(await readRecord(tx,'credential:'+binding.subject));check(c&&c.email===EMAILS[key]&&c.issuer===binding.issuer&&c.subject===binding.subject&&c.tenantId===base!.tenantId,'Canonical credential binding changed.');check((await assertActiveCredential(tx,c)).app_user_id===actor.userId,'Complete real password change/MFA before configuration.');identities.push({role:key,issuer:c.issuer,subject:c.subject,userId:actor.userId,version:c.version});}
   const active=await readActiveRelayTx(tx);check(active&&active.relay.config.host==='127.0.0.1'&&active.relay.config.port===SMTP_PORT&&!active.relay.config.auth&&active.relay.config.from===EMAILS.owner&&active.relay.config.security==='tls','Human SMTP Save/Test/receipt/Apply to the local sink is required.');return {identities,relayRevision:active.revision};
  });
  const allowed=await resolveEmployeeMasterRecipients(admin,{userId:base!.recipient.userId,employmentId:base!.recipient.employmentId});check(allowed.length===1,'Human policy and exact own-employment report-email opt-in required.');return {...proof,consent:allowed[0].consentAfterSequence,consentVerifiedAt:allowed[0].consentVerifiedAt};
 }
 sink=await startReportSmtpSink({key,cert,port:SMTP_PORT,recipients:Object.values(EMAILS)});
 if(mode==='configure'){
  console.log('Local TLS sink running. Use real enrollment/login/MFA and Email Save/Test/receipt/Apply, policy and own report-email consent. Create weekly/monthly reports in UI. No programmatic consent or Auth record is written.');
  let flushed=0;await boundedWait(async()=>{
   while(flushed<sink!.messages.length){const message=sink!.messages[flushed];await fs.writeFile(out+'/configuration-mail-'+flushed+'.eml',message.raw,{mode:0o600,flag:'wx'});flushed++;}
   try{await rootFile(out+'/human-ready.json');return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  },hardDeadline-60_000);
  const human=reportAcceptanceHumanReady.parse(await privateJson(out+'/human-ready.json'));check(human.runId===marker.runId&&human.candidateSha===marker.candidateSha,'Human receipt belongs to another journey.');
  const proof=await humanReadback();await fs.writeFile(out+'/configured.json',JSON.stringify({version:1,runId:marker.runId,candidateSha:marker.candidateSha,readinessSha256:hash(JSON.stringify(human)),...proof})+'\n',{mode:0o600,flag:'wx'});console.log('Canonical human readiness readback saved. No delivery PASS. Resume once with verify after reviewed internal installation and scheduling plan.');return;
 }
 const human=reportAcceptanceHumanReady.parse(await privateJson(out+'/human-ready.json')),configured=await privateJson(out+'/configured.json');
 check(human.runId===marker.runId&&human.candidateSha===marker.candidateSha&&configured.readinessSha256===hash(JSON.stringify(human))&&configured.runId===marker.runId&&configured.candidateSha===marker.candidateSha,'Exact configuration/readiness receipt required.');
 await humanReadback();
 check(!await fs.lstat(out+'/verification-started').then(()=>true,()=>false),'A verification already started; preserve it, never replay/reset automatically.');
 const {getEmployeeMasterReport,saveEmployeeMasterReport}=await import('../core/employee-master-reports'),{getEmployeeMasterSchedule,saveEmployeeMasterSchedule}=await import('../core/employee-master-schedules');
 disableOwnedSchedules=async()=>{
  check(ownedReports.size<=32&&fixtureTenant===admin.tenantId&&admin.userId===base!.owner.userId,'Owned schedule cleanup scope changed.');
  for(const reportId of [...ownedReports].sort()){
   const report=await getEmployeeMasterReport(admin,[base!.companyId],reportId),schedule=await getEmployeeMasterSchedule(admin,reportId);
   check(report.id===reportId&&report.ownerUserId===admin.userId&&JSON.stringify(report.spec.companyIds)===JSON.stringify([base!.companyId]),'Owned schedule cleanup report changed.');
   if(!schedule)continue;check(schedule.reportId===reportId&&schedule.tenantId===admin.tenantId,'Owned schedule cleanup identity changed.');
   if(schedule.enabled){const result=await saveEmployeeMasterSchedule(admin,[base!.companyId],{reportId,version:report.version,enabled:false,config:schedule.config,recipients:schedule.recipients});check(result.id===schedule.id,'Owned schedule cleanup changed identity.');}
   const after=await getEmployeeMasterSchedule(admin,reportId);check(after?.id===schedule.id&&!after.enabled&&after.nextRunAt===null&&JSON.stringify(after.config)===JSON.stringify(schedule.config)&&JSON.stringify(after.recipients)===JSON.stringify(schedule.recipients),'Owned schedule disable was not acknowledged.');
  }
 };
 const {PERSONNEL_FIELDS}=await import('../lib/personnel-field-registry'),{defaultMasterColumn}=await import('../lib/employee-master-report');
 const code=PERSONNEL_FIELDS.find(f=>f.owner==='employment'&&f.ownerField==='employeeCode')!,name=PERSONNEL_FIELDS.find(f=>f.owner==='person'&&f.ownerField==='fullName')!,salary=PERSONNEL_FIELDS.find(f=>f.owner==='compensation'&&f.ownerField==='basicSalary')!;
 const wanted=[code.id,name.id].sort();const ui=[];
 const expectedPeople=await owner.db.select({employmentId:s.employment.id,code:s.employment.employeeCode,fullName:s.person.fullName}).from(s.employment).innerJoin(s.person,q.eq(s.person.id,s.employment.personId)).where(q.and(q.eq(s.employment.tenantId,base.tenantId),q.eq(s.person.tenantId,base.tenantId),q.inArray(s.employment.id,[base.owner.employmentId,base.recipient.employmentId])));
 check(expectedPeople.length===2&&new Set(expectedPeople.map(person=>person.code)).size===2,'Exact fixture report subjects unavailable.');
 const expectedRows=expectedPeople.map(person=>{check(typeof person.code==='string','Exact fixture report subjects unavailable.');return {code:person.code,fullName:person.fullName};});
 for(const kind of ['weekly','monthly'] as const){const ref=human.reports[kind],report=await getEmployeeMasterReport(admin,[base.companyId],ref.reportId),schedule=await getEmployeeMasterSchedule(admin,ref.reportId);
  check(report.ownerUserId===base.owner.userId&&report.sharedRoleIds.includes('hr_admin')&&report.spec.asAt===base.date&&!report.spec.includeDrafts&&JSON.stringify(report.spec.companyIds)==JSON.stringify([base.companyId])&&JSON.stringify(report.spec.columns.map(c=>c.field).sort())===JSON.stringify(wanted),'UI report must select exactly Code/Name, this company and saved date, shared to HR Admin.');
  check(schedule?.id===ref.scheduleId&&schedule.enabled&&schedule.reportVersion===report.version&&schedule.config.frequency===kind&&schedule.recipients.length===1&&schedule.recipients[0].userId===base.recipient.userId&&schedule.recipients[0].employmentId===base.recipient.employmentId&&schedule.nextRunAt,'Review the exact UI-created weekly/monthly recipient pair.');
  check(new Date(schedule.nextRunAt).getTime()>=Date.now()+30_000&&new Date(schedule.nextRunAt).getTime()<=Date.now()+4*60_000,'Use actual UI schedule times 30seconds–4minutes ahead; never rewrite due rows.');
  ownedReports.add(report.id);ui.push({kind,report,schedule});
 }
 const installed=await fs.realpath(INTERNAL_NODE);check(hash(await rootExecutable(installed))===marker.nodeSha256,'Installed internal runtime differs from reviewed Node22.');
 const componentBytes=await rootFile(STAGING+'/components.json');check(hash(componentBytes)===marker.componentsSha256,'Root-reviewed component manifest differs.');const components=reportAcceptanceComponents.parse(JSON.parse(componentBytes.toString()));
 for(const [name,expected] of Object.entries(components)){const file='/usr/local/lib/aihr-identity-email/'+name;check(hash(await readTrustedDispatchFile(file,40_000_000,name==='internal-report-tick'?0o755:0o644))===expected,'Installed executable source differs from reviewed candidate bundle.');}
 managedUsed=true;check(await privateWorkersIdle(),'Unexpected active private worker before this verification.');
 await run('/usr/bin/python3',['-I','/usr/local/lib/aihr-identity-email/verify-internal-report-isolation.py','--web-unit',marker.webUnit],60_000);
 check((await delivery({op:'status'})).ready===true,'Installed sender/broker/renderer not ready; this alone proves no recipient delivery.');
 const inventory=await schedulingInventory();check(inventory.sha256===human.reviewedInventorySha256,'Reviewed actual scheduler inventory changed.');inventoryBefore=inventory.sha256;legacyUid=inventory.legacyUid;
 const plan=await run(INTERNAL_NODE,[SCHEDULE,'--plan',marker.webUnit]);check(plan.includes('Reviewed scheduler inventory SHA256: '+inventoryBefore),'Canonical scheduling plan differs.');
 const slice=command('systemctl',['show','aihrmanagedmail.slice','--property=ControlGroup','--value']);check(/^\/[a-zA-Z0-9_.\/-]+$/.test(slice)&&!slice.includes('..'),'Unknown managed cgroup.');const cgroup='/sys/fs/cgroup'+slice;
 const beforeEvents=await fs.readFile(cgroup+'/memory.events','utf8');check(/^oom_kill 0$/m.test(beforeEvents),'Existing managed OOM must be investigated before acceptance.');
 async function sampleMemory(){const read=async(file:string)=>Number((await fs.readFile(file,'utf8')).trim());memory.aggregate=Math.max(memory.aggregate,await read(cgroup+'/memory.peak'));
  const walk=async(dir:string,depth:number)=>{if(depth>3)return;for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(!entry.isDirectory()||!/^[-a-zA-Z0-9_.@\\]+$/.test(entry.name))continue;const child=dir+'/'+entry.name;let kind:keyof typeof memory|undefined;if(entry.name==='aihrmanagedmail-dispatch.slice')kind='dispatch';else if(entry.name==='aihr-internal-report.service')kind='sender';else if(entry.name.startsWith('aihr-report-auth@'))kind='broker';else if(entry.name.startsWith('aihr-report-renderer@'))kind='renderer';if(kind)try{memory[kind]=Math.max(memory[kind],await read(child+'/memory.peak'));}catch{}await walk(child,depth+1);}};await walk(cgroup,0);
 }
 let sampling=false;memoryTimer=setInterval(()=>{if(sampling)return;sampling=true;void sampleMemory().catch(()=>{}).finally(()=>{sampling=false;});},100);
 await fs.writeFile(out+'/verification-started',marker.candidateSha+'\n',{mode:0o600,flag:'wx'});
 const receipt={version:2,candidate:marker.candidateSha,runId:marker.runId,database:DATABASE,environment:{vm:marker.vm,platform:process.platform,arch:process.arch,node:process.version},results:[] as {name:string;status:'VERIFIED';details:Record<string,unknown>}[],limitations:['Canonical state readback does not replace parent-observed human password/MFA/SMTP receipt/consent interactions.','Controlled fault copies are fixture evidence; only declared weekly/monthly reports were actually created in UI.','No production/x86 deployment or full release gate is established.','Exact pre-SMTP broker process/EOF timing and hidden process environment denial need dedicated runtime proof beyond post-call idle/peak checks.','Identity disable/rebind races, inactive-owner and relay-Apply races require the separately reviewed owner regressions/actual interaction receipts; not claimed here.']};
 const record=(test:string,details:Record<string,unknown>={})=>receipt.results.push({name:test,status:'VERIFIED',details});
 stage='canonicalSchedulingHandoff';
 active();activationBaseline=await captureActivationBaseline(web);active();activationAttempted=true;await run(INTERNAL_NODE,[SCHEDULE,'--activate',marker.webUnit,inventoryBefore],16*60_000);
 const dispatch=internalReportDispatchMarker.parse(JSON.parse((await readTrustedDispatchFile(INTERNAL_REPORT_DISPATCH_MARKER,4096,0o644)).toString()));check(dispatch.state==='active'&&dispatch.runnerUid===legacyUid&&JSON.stringify(dispatch.sourcePins)===JSON.stringify(await readDispatchSourcePins()),'Actual canonical handoff not active.');scheduleInstallation=dispatch.installationId;managedUsed=true;
 active();command('systemctl',['start','cron.service']);cronStarted=true;stage='actualWeeklyMonthlyTicks';
 const occurrence=async(reportId:string)=>owner!.client`select id,status,report_version,schedule_revision,reviewed_digest,recipient_user_id,recipient_employment_id,row_count,artifact_sha256,artifact_byte_length,artifact_content_type,scheduled_for,started_at,finished_at from custom_report_occurrence where tenant_id=${base!.tenantId}::uuid and report_id=${reportId}::uuid order by scheduled_for limit 3`;
 for(const item of ui){await boundedWait(async()=>{const rows=await occurrence(item.report.id);return rows.length===1&&rows[0].status==='sent';},Date.now()+6*60_000);await preserveDeliveryMail();const rows=await occurrence(item.report.id),row=rows[0];ownedOccurrences.add(String(row.id));
  check(row.report_version===item.report.version&&row.schedule_revision===item.schedule.reviewedRevision&&row.reviewed_digest===item.schedule.reviewedDigest&&row.recipient_user_id===base.recipient.userId&&row.recipient_employment_id===base.recipient.employmentId&&row.row_count===2&&row.started_at&&row.finished_at,'Durable result not bound to exact UI review/recipient.');
  const messages=sink.messages.filter(message=>message.raw.toString('ascii').includes('<employee-master-'+row.id+'@localhost>'));check(messages.length===1&&JSON.stringify(messages[0].recipients)===JSON.stringify([EMAILS.recipient]),'Exact one-recipient SMTP receipt missing.');
  await fs.writeFile(out+'/'+item.kind+'-smtp.eml',messages[0].raw,{mode:0o600,flag:'wx'});
  const bytes=reportAttachment(messages[0].raw);await fs.writeFile(out+'/'+item.kind+'.xlsx',bytes,{mode:0o600,flag:'wx'});
  const XLSX=await import('xlsx'),book=XLSX.read(bytes,{type:'buffer'});
  assertManagedReportWorkbook(book,{title:item.report.name,asAt:item.report.spec.asAt,columns:item.report.spec.columns,fields:PERSONNEL_FIELDS,rows:expectedRows});
  check(hash(bytes)===row.artifact_sha256&&bytes.length===row.artifact_byte_length&&row.artifact_content_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Started artifact pin differs from actual MIME bytes.');
  record('actualUI-'+item.kind,{occurrenceId:row.id,reportId:item.report.id,scheduleId:item.schedule.id,rows:2,bytes:bytes.length,sha256:hash(bytes)});
 }
 const count=sink.messages.length;
 await boundedWait(async()=>{const [jobs]=await owner!.client`select count(*)::integer n from job_run where job_key='reports.employee-master.deliver' and ran_at>=${new Date(startedAt).toISOString()}::timestamptz`;return jobs.n>=2;},Date.now()+150_000);
 await sleep(65_000);for(const item of ui)check((await occurrence(item.report.id)).length===1,'Unchanged repeated tick duplicated an occurrence.');check(sink.messages.length===count,'Unchanged repeated tick sent duplicate SMTP.');record('twoRealTicksNoDuplicate');
 command('systemctl',['stop','cron.service']);cronStarted=false;await boundedWait(runnerIdle,Date.now()+120_000);
 // Active marker remains until final canonical rollback; stopped cron + idle proof isolates fault cases.
 stage='controlledFaultSetup';const template=ui[0].report;
 const {nextMasterScheduleAt}=await import('../lib/employee-master-schedule');
 const due=new Date(Date.now()+180_000);due.setUTCSeconds(0,0);const cases:Record<string,{reportId:string;version:number;scheduleId:string;config:{frequency:'weekly';day:number;hour:number;minute:number;timezone:string}}>= {};
 for(const key of ['permission','reportChanged','pendingCrash','startedCrash','smtpLost','smtpTemporary','artifactExpiry','oversized','consent',...Array.from({length:21},(_,i)=>'budget'+i)]){
  active();const saved=await saveEmployeeMasterReport(admin,[base.companyId],{name:'Controlled '+key,description:'Fixture-only fault case; not UI acceptance',sharedRoleIds:['hr_admin'],spec:key==='permission'?{...template.spec,columns:[defaultMasterColumn(code),defaultMasterColumn(salary)]}:template.spec});
  ownedReports.add(saved.id);active();const config={frequency:'weekly' as const,day:due.getUTCDay(),hour:due.getUTCHours(),minute:due.getUTCMinutes(),timezone:'UTC'},schedule=await saveEmployeeMasterSchedule(admin,[base.companyId],{reportId:saved.id,version:saved.version,enabled:true,config,recipients:[{userId:base.recipient.userId,employmentId:base.recipient.employmentId}]});
  check((await getEmployeeMasterSchedule(admin,saved.id))?.nextRunAt===due.toISOString(),'Fault setup crossed its genuine due minute; no timestamp rewrite.');cases[key]={reportId:saved.id,version:saved.version,scheduleId:schedule.id,config};
 }
 await boundedWait(async()=>Date.now()>=due.getTime(),Date.now()+190_000);
 async function queue(key:string){active();stage=key;const item=cases[key];check(item,'Unknown fixed fixture case.');const [queued]=await owner!.client`select identity_email.queue_report(${item.scheduleId}::uuid,${due.toISOString()}::timestamptz,${nextMasterScheduleAt(item.config,new Date()).toISOString()}::timestamptz) as added`;check(queued.added===1,'Canonical private queue refused exact fixture case.');const [job]=await owner!.client`select * from identity_email.claim_reports(1)`;check(job?.tenant_id===base!.tenantId,'Unexpected claimed tenant.');const [source]=await owner!.client`select report_id from custom_report_occurrence where id=${job.id}::uuid`;check(source.report_id===item.reportId,'Unexpected claimed report.');const pair={id:String(job.id),token:String(job.lease_token)};trackArtifact(pair);return pair;}
 const outcome=async(job:{id:string})=>(await owner!.client`select status,reason,lease_until from custom_report_occurrence where id=${job.id}::uuid and tenant_id=${base!.tenantId}::uuid`)[0];
 const liveLease=async(job:{id:string})=>{const row=await outcome(job);check(row.status==='pending'&&new Date(row.lease_until).getTime()>Date.now()+10_000,'Authority-change proof needs an unexpired pending lease.');};
 const finishSkipped=async(job:{id:string;token:string})=>{const [result]=await owner!.client`select identity_email.finish_report(${job.id}::uuid,${job.token}::uuid,'skipped','notEligible') as finished`;check(result?.finished===true&&(await outcome(job)).status==='skipped','Canonical fixture finish was not acknowledged.');};
 const deliver=(job:{id:string;token:string})=>delivery({op:'sendReport',occurrenceId:job.id,leaseToken:job.token});
 async function render(job:{id:string;token:string}){const inspected=reportBrokerResponse.parse(await peer(BROKER,{phase:'inspect',occurrenceId:job.id,leaseToken:job.token}));check('ok' in inspected&&inspected.ok&&inspected.phase==='inspect','Canonical broker inspection refused.');const result=await renderer({phase:'render',occurrenceId:job.id,leaseToken:job.token,expectedAccessStamp:inspected.target.accessStamp});if(result.ok===true)trackArtifact(job);return result;}
 async function authorityRefusal(job:{id:string;token:string},change:(validUntil:number)=>Promise<void>){
  try{await assertManagedReportAuthorityRefusal({
   prepare:async()=>{
    // Start the conservative lifetime before inspect; never count an expired proof as authority evidence.
    const lease=await outcome(job);check(lease.status==='pending','Authority-change proof requires pending source.');
    const validUntil=Math.min(Date.now()+REPORT_INSPECTION_LIFETIME_MS,new Date(lease.lease_until).getTime());
    const inspected=reportBrokerResponse.parse(await peer(BROKER,{phase:'inspect',occurrenceId:job.id,leaseToken:job.token}));
    check('ok' in inspected&&inspected.ok&&inspected.phase==='inspect','Canonical broker inspection refused.');
    const generated=await renderer({phase:'render',occurrenceId:job.id,leaseToken:job.token,expectedAccessStamp:inspected.target.accessStamp});check(generated.ok===true&&generated.accessStamp===inspected.target.accessStamp,'Pre-change actual generation failed.');
    const handle=await fs.open(ownedReportArtifactPath(job),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{return {validUntil,request:{phase:'start' as const,occurrenceId:job.id,leaseToken:job.token,inspectionProof:inspected.inspectionProof,expectedArtifact:await fingerprintOwnedReportArtifact(handle,Number(command('id',['-u','aihr-report-renderer'])))}};}finally{await handle.close();}
   },change,liveLease:()=>liveLease(job),start:body=>peer(BROKER,body),finishSkipped:()=>finishSkipped(job),
   outcome:async()=>{const row=await outcome(job);return {status:String(row.status),reason:typeof row.reason==='string'?row.reason:null};},smtpCount:()=>sink!.messages.length,now:Date.now,
  });}finally{await confirmOwnedReportArtifactRemoval(job,renderer);}
 }
 async function noResend(job:{id:string}){const before=sink!.messages.length;const claims=await owner!.client`select * from identity_email.claim_reports(1)`;check(claims.length===0&&sink!.messages.length===before,'Terminal/uncertain work was automatically retried.');}
 const {setPayrollPermissionGrant,listPayrollPermissionGrants,deletePayrollPermissionGrant}=await import('../packs/payroll/service');
 const permission={companyId:base.companyId,permissionKey:'report.read.compensation',role:'hr_admin'};
 const ownPermissionRows=async()=>(await listPayrollPermissionGrants(admin)).filter(row=>row.companyId===permission.companyId&&row.permissionKey===permission.permissionKey&&row.role===permission.role);
 for(const key of ['permission','reportChanged'] as const){
  const job=await queue(key),original=key==='permission'?await ownPermissionRows():[];check(original.length<=1,'Ambiguous fixture permission override.');let changedGrant:string|undefined;
  try{
   await authorityRefusal(job,async()=>{
    if(key==='permission')changedGrant=(await setPayrollPermissionGrant(admin,{...permission,allowed:false})).id;
    else await saveEmployeeMasterReport(admin,[base!.companyId],{id:cases[key].reportId,version:cases[key].version,name:'Controlled changed after generation',description:'Changed through canonical owner',sharedRoleIds:['hr_admin'],spec:template.spec});
   });
  }finally{
   if(key==='permission'&&changedGrant){
    const current=await ownPermissionRows();check(current.length===1&&current[0].id===changedGrant&&current[0].allowed===false&&(!original.length||original[0].id===changedGrant),'Fixture permission changed outside its owner operation.');
    if(original.length)check((await setPayrollPermissionGrant(admin,{...permission,allowed:original[0].allowed})).id===changedGrant,'Permission restore changed identity.');
    else check((await deletePayrollPermissionGrant(admin,{id:changedGrant})).deleted,'Temporary permission override removal refused.');
    const restored=await ownPermissionRows();check(original.length?restored.length===1&&restored[0].id===original[0].id&&restored[0].allowed===original[0].allowed:restored.length===0,'Original permission state was not restored.');
   }
  }
  record('controlled-afterGeneration-'+key,{boundary:'original-inspection/artifact broker-start refusal; canonical skipped/notEligible; no SMTP'});
 }
 for(const [key,mode,expected] of [['smtpLost','lost','uncertain'],['smtpTemporary','temporary','failed']] as const){const job=await queue(key);sink.setMode(mode);check((await deliver(job)).outcome===expected&&(await outcome(job)).status===expected,'SMTP terminal classification mismatch.');sink.setMode('accept');await noResend(job);record('controlled-'+key+'NoRetry');}
 const pending=await queue('pendingCrash'),pendingLease=(await outcome(pending)).lease_until;await boundedWait(async()=>Date.now()>new Date(pendingLease).getTime(),Date.now()+190_000);const [reclaimed]=await owner.client`select * from identity_email.claim_reports(1)`;check(String(reclaimed?.id)===pending.id&&reclaimed.lease_token!==pending.token,'Unstarted work did not reclaim exact fresh nonce.');const refusedOld=reportBrokerResponse.parse(await peer(BROKER,{phase:'inspect',occurrenceId:pending.id,leaseToken:pending.token}));check('ok' in refusedOld&&!refusedOld.ok&&refusedOld.reason==='notEligible','Old nonce refusal was not proven.');const freshPending={id:pending.id,token:String(reclaimed.lease_token)};trackArtifact(freshPending);check((await deliver(freshPending)).outcome==='sent','Fresh unstarted nonce did not send.');record('controlled-unstartedLeaseReclaim');
 const crash=await queue('startedCrash');sink.setMode('hold');const beforeCrash=sink.messages.length,attempt=deliver(crash).catch(()=>null);await boundedWait(async()=>sink!.messages.length===beforeCrash+1&&(await outcome(crash)).status==='started',Date.now()+110_000);command('systemctl',['kill','--kill-whom=main','--signal=KILL','aihr-internal-report.service']);sink.disconnect();await attempt;sink.setMode('accept');command('systemctl',['start','aihr-internal-report.service']);const lease=(await outcome(crash)).lease_until;await boundedWait(async()=>Date.now()>new Date(lease).getTime(),Date.now()+190_000);await noResend(crash);check((await outcome(crash)).status==='uncertain','Started crash did not become terminal uncertain.');record('controlled-actualSenderCrashNoRetry');
 const expiry=await queue('artifactExpiry');check((await render(expiry)).ok===true,'Actual expiry artifact generation failed.');const original=await fs.lstat(ownedReportArtifactPath(expiry));await boundedWait(async()=>Date.now()-original.mtimeMs>601_000,Date.now()+610_000);check((await renderer({phase:'status'})).ready===true,'Request-driven renderer cleanup refused.');await assertOwnedReportArtifactAbsent(expiry);const [expired]=await owner.client`select * from identity_email.claim_reports(1)`;check(String(expired?.id)===expiry.id,'Unexpected expired fixture claim.');await finishSkipped({id:expiry.id,token:String(expired.lease_token)});record('controlled-actualArtifactExpiry');
 const budget=[];try{for(let i=0;i<21;i++){const job=await queue('budget'+i);budget.push(job);const rendered=await render(job);check(i<20?rendered.ok===true:rendered.ok===false&&rendered.reason==='generationFailed','Twenty-artifact budget not enforced.');if(i===19)check((await fs.readdir('/var/lib/aihr-report-renderer/render')).filter(name=>name.endsWith('.xlsx')).length===20,'Actual twenty-artifact occupancy not proven.');await finishSkipped(job);}}finally{for(const job of budget)await confirmOwnedReportArtifactRemoval(job,renderer);}record('controlled-artifactBudgetAcknowledgementAndAbsence');
 // Preserve the original actual 20MB boundary case via the real Family owner, not a fabricated workbook.
 const {addDependentTx}=await import('../core/dependents');await dbModule.withTenant(admin,async tx=>{for(let i=0;i<1000;i++){check(!stopped&&Date.now()<hardDeadline,'Oversize setup deadline.');await addDependentTx(tx,admin,base!.recipient.personId,{fullName:'Fictional large row '+i,relationship:'child',remarks:randomBytes(22500).toString('base64')});}});
 const dependent=PERSONNEL_FIELDS.find(f=>f.owner==='dependent'&&f.ownerField==='remarks')!;const large=cases.oversized,largeSaved=await saveEmployeeMasterReport(admin,[base.companyId],{id:large.reportId,version:large.version,name:'Controlled real oversized register',description:'Canonical Family rows',sharedRoleIds:['hr_admin'],spec:{...template.spec,columns:[{...defaultMasterColumn(dependent),records:'all'}]}});
 const largeDue=new Date(Date.now()+90_000);largeDue.setUTCSeconds(0,0);const largeConfig={frequency:'weekly' as const,day:largeDue.getUTCDay(),hour:largeDue.getUTCHours(),minute:largeDue.getUTCMinutes(),timezone:'UTC'};await saveEmployeeMasterSchedule(admin,[base.companyId],{reportId:large.reportId,version:largeSaved.version,enabled:true,config:largeConfig,recipients:[{userId:base.recipient.userId,employmentId:base.recipient.employmentId}]});await boundedWait(async()=>Date.now()>=largeDue.getTime(),Date.now()+100_000);
 const [largeQueued]=await owner.client`select identity_email.queue_report(${large.scheduleId}::uuid,${largeDue.toISOString()}::timestamptz,${nextMasterScheduleAt(largeConfig,new Date()).toISOString()}::timestamptz) as added`;check(largeQueued.added===1,'Large canonical queue refused.');const [largeClaim]=await owner.client`select * from identity_email.claim_reports(1)`;check(largeClaim?.tenant_id===base.tenantId,'Unexpected oversized claim.');const [largeSource]=await owner.client`select report_id from custom_report_occurrence where id=${largeClaim.id}::uuid`;check(largeSource.report_id===large.reportId,'Wrong oversized source.');const largeJob={id:String(largeClaim.id),token:String(largeClaim.lease_token)},beforeLarge=sink.messages.length;trackArtifact(largeJob);check((await deliver(largeJob)).outcome==='failed'&&(await outcome(largeJob)).reason==='attachmentTooLarge'&&sink.messages.length===beforeLarge,'Actual oversized workbook sent or wrong refusal.');record('controlled-actualOversizedRefusal');
 const consent=await queue('consent');await authorityRefusal(consent,async validUntil=>{await fs.writeFile(out!+'/withdraw-request.json',JSON.stringify({runId:marker.runId,recipientUserId:base!.recipient.userId,employmentId:base!.recipient.employmentId,occurrenceId:consent.id,route:base!.routes.consent,proofDeadline:new Date(validUntil-15_000).toISOString()})+'\n',{mode:0o600,flag:'wx'});console.log('Human step: recipient withdraws Employee Master report email through own notification form now, within the original proof deadline; runner waits for canonical owner readback, never writes consent.');
 const consentLease=(await outcome(consent)).lease_until;await boundedWait(async()=>(await resolveEmployeeMasterRecipients(admin,{userId:base!.recipient.userId,employmentId:base!.recipient.employmentId})).length===0,Math.min(validUntil-15_000,new Date(consentLease).getTime()-15_000));});record('afterActualConsentWithdrawalNoSend',{boundary:'original-inspection/artifact broker-start refusal after actual own-form withdrawal; canonical skipped/notEligible; no SMTP'});
 await sampleMemory();for(const [kind,limit] of [['aggregate',768],['dispatch',192],['sender',192],['broker',192],['renderer',512]] as const)check(Number.isSafeInteger(memory[kind])&&memory[kind]>0&&memory[kind]<=limit*1024*1024,'Measured memory proof missing/exceeded.');check(/^oom_kill 0$/m.test(await fs.readFile(cgroup+'/memory.events','utf8')),'Actual managed OOM kill occurred.');record('actualCgroupPeaks',memory);
 stage='ownedCleanup';return {receipt,path:out+'/verification.json'};
}
async function rootExecutable(path:string){return readTrustedDispatchFile(path,256*1024*1024,0o755);}
main().then(async completed=>{await cleanup();check(!stopped,'Watchdog interrupted this journey.');if(completed){await fs.writeFile(completed.path,JSON.stringify({...completed.receipt,cleanup:'VERIFIED'},null,2)+'\n',{mode:0o600,flag:'wx'});console.log('Private internal report receipt saved after exact owned cleanup. Fixture evidence is not production or human Auth acceptance.');}}).catch(async(error:unknown)=>{if(out)try{await fs.writeFile(out+'/failure-'+mode+'.json',JSON.stringify({status:'FAILED',stage,error:failureFingerprint(error)})+'\n',{mode:0o600,flag:'wx'});}catch{}try{await preserveDeliveryMail();}catch{}console.error('Internal report acceptance REFUSED/FAILED. Preserve owned evidence; no completion claim or private error details.');process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);try{await cleanup();}catch{process.exitCode=1;}if(stopDeadline)clearTimeout(stopDeadline);process.exit(stopped||process.exitCode?1:0);});
