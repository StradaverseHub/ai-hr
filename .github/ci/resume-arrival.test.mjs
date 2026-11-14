/** aihr-resume-arrival/v1 policy and sequencing. Fabricated fixtures and fake ports only; never SSH, rsync or staging. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installationFixture} from './staging-install-test-fixture.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
import {STAGING} from './staging-transport.mjs';
import {stagingInstallerCommand} from './staging-ci-promotion.mjs';
import {CHECKSUM_TIMEOUT_MS,sourceChecksumDryRun,requireSuccessfulBuild} from './operator-release.mjs';
import {leaseAssert,guardCommand} from '../../scripts/staging/lease.mjs';
import {resumeArrival,requireResumeStatusInstaller,findResumeEvidenceDirectory,readResumeEvidence,splitDeployFollow,validateActivationLog,admitRetainedEvidence,
 RESUME_ARRIVAL_POLICY,RESUME_REQUIRED_EVIDENCE,RESUME_REFUSING_EVIDENCE,WORKER_FAILURE_MARKER,IMPORT_WORKER_CHECK_COMMAND,SERVICE_HEALTH_COMMAND,DEPLOY_FINISH_COMMAND} from './resume-arrival.mjs';

const UUID='12345678-1234-4234-9234-123456789abc';
const expectedLedger=[{tag:'0001_fixture',hash:'f'.repeat(64),created_at:'1'},{tag:'0002_fixture',hash:'e'.repeat(64),created_at:'2'}];
const rows=[{id:'1',hash:'f'.repeat(64),created_at:'1'},{id:'2',hash:'e'.repeat(64),created_at:'2'}];
const official={isSuccessState:state=>state==='ok'};
function fixture(){
 const f=installationFixture(Date.now()-3*3600000),grant=f.grant,directory='/private/operator/scratchpad/validated-ci-123-'+UUID;
 const auth=installHash(Buffer.from(installJson(grant)+'\n'));
 const tuple={source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,authorizationSha256:auth};
 const ledger={format:1,kind:'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE',rows:2,expectedSha256:installHash(installJson(expectedLedger)),actualSha256:installHash(installJson(rows)),releaseAuthorized:false,verifiedAt:new Date().toISOString()};
 const activated={format:1,kind:'CI_BUILD_BYTES_ACTIVATED_NOT_FULL_ARRIVAL',...tuple,activation:{activeBuildId:grant.build.nextBuildId,retainedBuildId:grant.baselineBuildId},migrationLedger:ledger,activatedAt:new Date().toISOString(),releaseAuthorized:false,activeServiceVerified:false};
 const active={format:1,kind:'CI_BUILD_ACTIVE_SERVICE_VERIFIED_NOT_FULL_ARRIVAL',...tuple,pid:'4321',startedMonotonicUs:200,healthStatus:200,compiledByteInventory:{format:2},migrationLedger:ledger,verifiedAt:new Date().toISOString(),releaseAuthorized:false,fullSourceChecksumVerified:false,fullMigrationLedgerVerified:true};
 const log=['▸ Activating the verified CI build…',JSON.stringify(activated),'▸ Restarting service…','✅ Deployed + restarted. Logs: journalctl -u aihr -f',JSON.stringify(active),
  'Import worker missing for "employee_import": last heartbeat 2026-11-13T01:00:00.000Z.','    aihr-bank-import.service: active',WORKER_FAILURE_MARKER+'2). New background imports would stay queued.',''].join('\n');
 const remoteBuild={state:'failed',phase:'ci-build-health',ref:grant.source,pid:'777',exit_code:'1',started_at:'1000',finished_at:'2000',now:'2001',log:'/var/tmp/aihr-deploy/deploy-fixture.log',log_size:String(Buffer.byteLength(log)),
  build_id:grant.build.nextBuildId,built_ref:grant.baseline,built_build_id:grant.baselineBuildId,stale_build:'1'};
 const evidence={directory,grant,
  preflight:{...f.evidence,evidenceDirectory:directory,target:{...STAGING},execute:true,baselineLedger:{rows:1},profilePreflight:{},packetTransport:{}},
  initialized:{installId:grant.installId,packetDirectory:'/home/fixture/.aihr-ci-builds/'+grant.installId+'/packet',authorizationSha256:auth,releaseAuthorized:false},
  launch:{output:'aihr-deploy-log=/var/tmp/aihr-deploy/deploy-fixture.log',installId:grant.installId,testingBuildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId},remoteBuild};
 const lease={protocol:'aihr-staging-queue/v1',candidate:grant.source,batch:'01234567-1234-4234-9234-0123456789ab',epoch:7,token:'9'.repeat(64),releaseAuthorized:false};
 const held={protocol:'aihr-staging-queue/v1',releaseAuthorized:false,batch:lease.batch,epoch:lease.epoch,candidate:grant.source,phase:'installing'};
 const okStatus={...remoteBuild,state:'ok',exit_code:'0',built_ref:grant.source,built_build_id:grant.build.nextBuildId,stale_build:'0'};
 const events=[],saved={};
 const state={live:[{log,status:{...remoteBuild}}],held,worker:'Import worker ready for: bank_import, employee_import.\n',service:'service=active\n{"healthStatus":200,"body":"{\\"status\\":\\"ok\\"}"}\n',checksum:'',installer:readFileSync(new URL('./staging-build-install.mjs',import.meta.url),'utf8'),ledger:rows,after:okStatus};
 const ports={
  leaseAssert:()=>{events.push('lease');if(state.held instanceof Error)throw state.held;return state.held;},
  follow:()=>{events.push('follow');return structuredClone(state.live.length>1?state.live.shift():state.live[0]);},
  worker:()=>{events.push('worker');if(state.worker instanceof Error)throw state.worker;return state.worker;},
  service:()=>{events.push('service');return state.service;},
  checksum:()=>{events.push('checksum');return state.checksum;},
  installer:()=>{events.push('installer');return state.installer;},
  ledger:()=>{events.push('ledger');return structuredClone(state.ledger);},
  finish:()=>{events.push('finish');return 'state=ok';},
  status:()=>{events.push('status');return {...state.after};},
  requireBuilt:status=>requireSuccessfulBuild(official,status,grant.source),
  arrive:async status=>{events.push(['arrive',status.state]);return {arrival:{nextBuildId:grant.build.nextBuildId,healthStatus:200},ownedResourceCleanupVerified:false};},
 };
 const options=(execute=true)=>({execute,candidate:grant.source,controller:f.evidence.controller,runId:'123',target:{...STAGING},evidence,expectedLedger,lease:execute?lease:null,ports,
  save:(name,value)=>{assert(!(name in saved),'write-once evidence: '+name);saved[name]=structuredClone(value);},frozen:()=>events.push('frozen')});
 return {f,grant,evidence,lease,held,log,active,activated,remoteBuild,okStatus,events,saved,state,ports,options};
}
const attempt=saved=>Object.entries(saved).find(([name])=>name.startsWith('resume-arrival-'))?.[1];
const mutations=events=>events.filter(e=>e==='finish'||Array.isArray(e));

test('admitted state: verify is read-only and records every check; execute finishes through the record then arrives',async()=>{
 const v=fixture(),checked=await resumeArrival(v.options(false));
 assert.equal(checked.result,'ADMISSIBLE_NOT_EXECUTED');assert.equal(checked.policy,RESUME_ARRIVAL_POLICY);
 assert.deepEqual(mutations(v.events),[]);assert(!v.events.includes('lease'));
 assert.deepEqual(Object.keys(attempt(v.saved).checks),['retainedEvidence','admissionDeployRecord','admissionActivationLog','importWorker','serviceHealth','sourceChecksum','resumeInstaller','migrationLedger']);
 assert(Object.values(attempt(v.saved).checks).every(c=>c.result==='PASS'));assert.equal(v.saved['resume-arrival.json'],undefined);
 const s=fixture(),result=await resumeArrival(s.options(true));
 assert.equal(result.result,'ARRIVED');
 assert.deepEqual(s.events.filter(e=>e!=='frozen'),['lease','follow','worker','service','checksum','installer','ledger','follow','finish','status',['arrive','ok']]);
 const record=attempt(s.saved);assert.equal(record.result,'ARRIVED');assert.equal(record.checks.sourceChecksum.differences,0);
 assert.equal(record.checks.migrationLedger.actualSha256,s.active.migrationLedger.actualSha256);assert.equal(record.checks.lease.epoch,7);
 assert.equal(record.checks.admissionActivationLog.activeRecord.healthStatus,200);assert.equal(record.releaseAuthorized,false);
 assert.equal(s.saved['resume-arrival.json'].result,'ARRIVED');
});

test('refuses every deploy record other than failed-after-activation for this candidate and build',async()=>{
 const patches={pending:{state:'incomplete'},running:{state:'running'},died:{state:'died'},alreadyOk:{state:'ok',stale_build:'0'},unknown:{state:'unknown'},
  beforeActivation:{phase:'migrate'},duringActivation:{phase:'ci-build-activate'},restart:{phase:'restart'},otherExit:{exit_code:'2'},
  otherCandidate:{ref:'c'.repeat(40)},otherBuild:{build_id:'another-build'},movedBaseline:{built_ref:'e'.repeat(40)},movedBaselineBuild:{built_build_id:'other'},notStale:{stale_build:'0'}};
 for(const [name,patch]of Object.entries(patches)){
  const s=fixture();s.state.live=[{log:s.log,status:{...s.remoteBuild,...patch}}];
  await assert.rejects(resumeArrival(s.options(true)),Error,name);assert.deepEqual(mutations(s.events),[],name);
  assert.equal(attempt(s.saved).result,'REFUSED',name);assert.equal(attempt(s.saved).checks.admissionDeployRecord.result,'FAIL',name);
 }
});

test('refuses a remote log without the healthy activation, verified ledger and worker-only failure for this installation',async()=>{
 const base=fixture(),line=v=>JSON.stringify(v);
 const logs={
  noActiveRecord:base.log.replace(line(base.active)+'\n',''),
  unhealthy:base.log.replace(line(base.active),line({...base.active,healthStatus:503})),
  ledgerNotVerified:base.log.replace(line(base.active),line({...base.active,fullMigrationLedgerVerified:false})),
  ledgerRows:base.log.replace(line(base.active),line({...base.active,migrationLedger:{...base.active.migrationLedger,rows:1}})),
  otherInstall:base.log.replace(line(base.active),line({...base.active,installId:UUID})),
  otherBuild:base.log.replace(line(base.active),line({...base.active,nextBuildId:'other'})),
  forgedAuthorization:base.log.replace(line(base.active),line({...base.active,authorizationSha256:'0'.repeat(64)})),
  noActivation:base.log.replace(line(base.activated)+'\n',''),
  laterRecord:base.log+line({...base.activated,installId:UUID})+'\n',
  failureNotWorker:base.log.replace(WORKER_FAILURE_MARKER,'✗ Some other failure (status '),
  empty:'',
 };
 for(const [name,log]of Object.entries(logs)){
  const s=fixture();s.state.live=[{log,status:{...s.remoteBuild}}];
  await assert.rejects(resumeArrival(s.options(true)),Error,name);assert.deepEqual(mutations(s.events),[],name);
  assert.equal(attempt(s.saved).checks.admissionActivationLog?.result,'FAIL',name);
 }
});

test('retained evidence mismatch refuses before any staging read',async()=>{
 const cases={
  notExecuted:e=>e.preflight.execute=false,otherTarget:e=>e.preflight.target={...STAGING,host:'other'},otherDirectory:e=>e.preflight.evidenceDirectory='/elsewhere',
  otherCandidate:e=>e.preflight.sha='c'.repeat(40),otherRun:e=>e.preflight.runId=124,otherController:e=>e.preflight.controller='c'.repeat(40),
  launchBuild:e=>e.launch.nextBuildId='other',launchInstall:e=>e.launch.installId=UUID,launchRecord:e=>e.launch.testingBuildRecordId=UUID,
  acknowledgement:e=>e.initialized.authorizationSha256='0'.repeat(64),grantShape:e=>e.grant.extra=true,grantBaseline:e=>e.grant.baseline='c'.repeat(40),
  observedSuccess:e=>Object.assign(e.remoteBuild,{state:'ok',stale_build:'0'}),observedEarlierFailure:e=>e.remoteBuild.phase='migrate',
 };
 for(const [name,mutate]of Object.entries(cases)){
  const s=fixture();mutate(s.evidence);
  await assert.rejects(resumeArrival(s.options(true)),Error,name);
  assert.deepEqual(s.events.filter(e=>e!=='frozen'),[],name);assert.equal(attempt(s.saved).checks.retainedEvidence.result,'FAIL',name);
 }
 const s=fixture();assert.throws(()=>admitRetainedEvidence({evidence:s.evidence,candidate:s.grant.source,controller:s.f.evidence.controller,runId:'999',target:{...STAGING}}));
});

test('live record must still be the retained terminal observation, at admission and immediately before finish',async()=>{
 for(const key of ['pid','started_at','finished_at','log']){
  const s=fixture();s.state.live=[{log:s.log,status:{...s.remoteBuild,[key]:'9999'}}];
  await assert.rejects(resumeArrival(s.options(true)),new RegExp(key));assert.deepEqual(mutations(s.events),[]);
 }
 const s=fixture();s.state.live=[{log:s.log,status:{...s.remoteBuild}},{log:s.log,status:{...s.remoteBuild,finished_at:'3000'}}];
 await assert.rejects(resumeArrival(s.options(true)),/finished_at/);assert.deepEqual(mutations(s.events),[]);
 assert.equal(attempt(s.saved).checks.prefinishDeployRecord.result,'FAIL');
});

test('zero-difference canonical checksum is mandatory',async()=>{
 const s=fixture();s.state.checksum='>f.st...... app/page.tsx\n';
 await assert.rejects(resumeArrival(s.options(true)),/Source checksum differs/);
 assert.deepEqual(mutations(s.events),[]);assert.equal(attempt(s.saved).checks.sourceChecksum.result,'FAIL');assert(!s.events.includes('ledger'));
 const calls=[],transport={rsyncArgs:(o,source)=>['-a','--exclude','/.improve/',source+'/','aihr-staging:/opt/ai-hr/']};
 assert.equal(sourceChecksumDryRun({},transport,'/candidate',(command,args,options)=>{calls.push({command,args,options});return '';}),'');
 assert.equal(calls[0].command,'rsync');assert.deepEqual(calls[0].args.slice(0,3),['--dry-run','--checksum','--itemize-changes']);
 assert.equal(calls[0].options.timeout,CHECKSUM_TIMEOUT_MS);assert.equal(CHECKSUM_TIMEOUT_MS,600000);
});

test('worker, service, health and ledger are re-proved at resume time',async()=>{
 const cases={
  workerFails:s=>s.state.worker=Error('Command failed: check-import-worker exit 2'),workerSilent:s=>s.state.worker='',
  serviceInactive:s=>s.state.service='service=failed\n{"healthStatus":200,"body":"{\\"status\\":\\"ok\\"}"}\n',
  healthDown:s=>s.state.service='service=active\n{"healthStatus":503,"body":"{\\"status\\":\\"error\\"}"}\n',
  healthBody:s=>s.state.service='service=active\n{"healthStatus":200,"body":"<html>"}\n',
  ledgerChanged:s=>s.state.ledger=[rows[0],{...rows[1],id:'3'}],ledgerShort:s=>s.state.ledger=[rows[0]],ledgerHash:s=>s.state.ledger=[rows[0],{...rows[1],hash:'d'.repeat(64)}],
 };
 for(const [name,mutate]of Object.entries(cases)){
  const s=fixture();mutate(s);await assert.rejects(resumeArrival(s.options(true)),Error,name);
  assert.deepEqual(mutations(s.events),[],name);assert(Object.values(attempt(s.saved).checks).some(c=>c.result==='FAIL'),name);
 }
});

test('lease must be held for this exact batch, epoch and candidate, still installing',async()=>{
 const cases={epoch:h=>({...h,epoch:8}),batch:h=>({...h,batch:'01234567-1234-4234-9234-0123456789ac'}),candidate:h=>({...h,candidate:'c'.repeat(40)}),
  arrived:h=>({...h,phase:'arrived'}),claimed:h=>({...h,phase:'claimed'}),coordinatorRefuses:()=>Error('Lease identity/fencing epoch differs')};
 for(const [name,make]of Object.entries(cases)){
  const s=fixture();s.state.held=make(s.held);
  await assert.rejects(resumeArrival(s.options(true)),Error,name);assert.deepEqual(s.events.filter(e=>e!=='frozen'),['lease'],name);
  assert.equal(attempt(s.saved).checks.lease.result,'FAIL',name);
 }
 const s=fixture();await assert.rejects(resumeArrival({...s.options(true),lease:null}),/held staging lease/);assert.deepEqual(s.events,[]);
 const other=fixture();await assert.rejects(resumeArrival({...other.options(true),lease:{...other.lease,candidate:'c'.repeat(40)}}),/Matching held staging lease/);
 assert.deepEqual(mutations(other.events),[]);
 const requests=[];const reply=leaseAssert(s.lease,(command,options)=>{requests.push({command,request:JSON.parse(options.input)});return JSON.stringify(s.held);});
 assert.deepEqual(reply,s.held);assert.match(requests[0].command,/coordinator\.py$/);
 assert.deepEqual(requests[0].request,{protocol:s.lease.protocol,action:'assert',actor:'ci-operator',batch:s.lease.batch,epoch:7,token:s.lease.token,candidate:s.grant.source});
});

test('a finish that does not yield the exact successful record never claims arrival',async()=>{
 for(const patch of [{state:'failed'},{stale_build:'1'},{built_ref:'c'.repeat(40)},{built_build_id:'other'},{build_id:'other'}]){
  const s=fixture();s.state.after={...s.okStatus,...patch};
  await assert.rejects(resumeArrival(s.options(true)));assert(s.events.includes('finish'));assert(!s.events.some(Array.isArray));
  assert.equal(attempt(s.saved).checks.deployRecordOk.result,'FAIL');assert.equal(s.saved['resume-arrival.json'],undefined);
 }
});

test('evidence discovery needs exactly one private launched directory and no prior arrival',()=>{
 const root=mkdtempSync(join(tmpdir(),'resume-evidence-'));
 try{
  const scratch=join(root,'scratchpad');mkdirSync(scratch,{mode:0o700});
  assert.throws(()=>findResumeEvidenceDirectory(scratch,'123'),/found 0/);
  const dir=join(scratch,'validated-ci-123-'+UUID);mkdirSync(dir,{mode:0o700});
  mkdirSync(join(scratch,'validated-ci-123-'+UUID.replace('abc','abd')),{mode:0o700});
  assert.throws(()=>findResumeEvidenceDirectory(scratch,'123'),/found 0/);
  const s=fixture();
  for(const name of RESUME_REQUIRED_EVIDENCE){
   const value={'operator-preflight.json':s.evidence.preflight,'installation-grant.json':s.grant,'installation-initialized.json':s.evidence.initialized,'launch.json':s.evidence.launch,'remote-build-result.json':s.remoteBuild}[name];
   writeFileSync(join(dir,name),JSON.stringify(value),{mode:0o600});
  }
  assert.equal(findResumeEvidenceDirectory(scratch,'123'),dir);
  assert.throws(()=>findResumeEvidenceDirectory(scratch,'12'),/found 0/);assert.throws(()=>findResumeEvidenceDirectory(scratch,'x'));
  const read=readResumeEvidence(dir);assert.equal(read.grant.installId,s.grant.installId);assert.equal(read.remoteBuild.phase,'ci-build-health');
  writeFileSync(join(scratch,'validated-ci-123-'+UUID.replace('abc','abd'),'launch.json'),'{}',{mode:0o600});
  assert.throws(()=>findResumeEvidenceDirectory(scratch,'123'),/found 2/);rmSync(join(scratch,'validated-ci-123-'+UUID.replace('abc','abd')),{recursive:true});
  for(const name of RESUME_REFUSING_EVIDENCE){writeFileSync(join(dir,name),'{}',{mode:0o600});assert.throws(()=>readResumeEvidence(dir),new RegExp(name.replace('.','\\.')));rmSync(join(dir,name));}
  rmSync(join(dir,'remote-build-result.json'));assert.throws(()=>readResumeEvidence(dir),/missing: remote-build-result\.json/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('follow reply splits at the last sentinel; commands are pinned, read-only and guarded only for finish',()=>{
 const sentinel='<<<AIHR-DEPLOY-STATE-9d3f41>>>',parse=text=>Object.fromEntries(text.trim().split('\n').map(l=>l.split('=')));
 const {log,status}=splitDeployFollow(Buffer.from('line '+sentinel+' echoed\nlast\n'+sentinel+'\nstate=failed\nphase=ci-build-health\n'),{sentinel,parse});
 assert.equal(log,'line '+sentinel+' echoed\nlast\n');assert.deepEqual(status,{state:'failed',phase:'ci-build-health'});
 assert.throws(()=>splitDeployFollow(Buffer.from('no sentinel'),{sentinel,parse}));assert.throws(()=>splitDeployFollow('text',{sentinel,parse}));
 assert.equal(IMPORT_WORKER_CHECK_COMMAND,'cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx scripts/check-import-worker.ts --wait 45');
 assert.match(SERVICE_HEALTH_COMMAND,/systemctl is-active aihr/);assert.match(SERVICE_HEALTH_COMMAND,/\/opt\/node22\/bin\/node --env-file=\.env\.production/);
 assert.match(SERVICE_HEALTH_COMMAND,/http:\/\/127\.0\.0\.1:/);assert.doesNotMatch(SERVICE_HEALTH_COMMAND,/restart|finish|deploy-state/);
 assert.equal(DEPLOY_FINISH_COMMAND,'cd /opt/ai-hr && deploy/deploy-state.sh finish 0');
 assert.match(guardCommand({batch:'b',epoch:1,token:'t',candidate:'c'},DEPLOY_FINISH_COMMAND),/coordinator\.py guard -- bash -c 'cd \/opt\/ai-hr && deploy\/deploy-state\.sh finish 0'$/);
 const g=installationFixture().grant;
 assert.match(stagingInstallerCommand('resume-status',g.source,g.installId,g.build.buildRecordId),/staging-build-install\.mjs resume-status /);
 assert.throws(()=>stagingInstallerCommand('resume-status',';exit',g.installId,g.build.buildRecordId));
 // Operator wiring: resume uses a guarded ssh when the lease is held, the expired-grant read-only proof and no owned cleanup.
 const source=readFileSync(new URL('./operator-release.mjs',import.meta.url),'utf8'),resume=source.slice(source.indexOf('async function leasedResumeArrival'));
 assert.match(resume,/const ssh=\(command,options=\{\}\)=>sshRaw\(lease\?guardCommand\(lease,command\):command,options\);/);
 assert.match(resume,/finish:\(\)=>ssh\(DEPLOY_FINISH_COMMAND/);assert.match(resume,/installerStatusMode:'resume-status',ownedCleanup:false/);
 assert.match(resume,/const lease=execute\?readLease\(candidate\):null;/);assert.doesNotMatch(resume,/readyProductionBaseline/);
 // The normal routes keep their strict baseline and successful-build admission.
 const normal=source.slice(source.indexOf('async function leasedOperatorRelease'),source.indexOf('export async function completeVerifiedArrival'));
 assert.match(normal,/baselineRules\.readyProductionBaseline\(initial\)/);assert.match(normal,/requireSuccessfulBuild\(official,status,evidence\.sha\);/);
});

test('validateActivationLog reports the activation and the worker-only failure tail',()=>{
 const s=fixture(),proof=validateActivationLog(s.log,{grant:s.grant,expectedLedger});
 assert.equal(proof.activeRecord.installId,s.grant.installId);assert.match(proof.failureAfterActivation,/Import worker check failed/);
});

test('a candidate whose installer predates resume-status refuses before finish',async()=>{
 const current=readFileSync(new URL('./staging-build-install.mjs',import.meta.url),'utf8');
 assert.deepEqual(requireResumeStatusInstaller(current),{resumeStatusInstaller:true});
 const older=current.replace("'status','resume-status',","'status',").replace("{allowExpired:mode==='resume-status'}","{}");
 for(const [name,text]of Object.entries({older,missing:undefined,empty:''})){
  const s=fixture();s.state.installer=text;
  await assert.rejects(resumeArrival(s.options(true)),/predates aihr-resume-arrival/,name);
  assert.deepEqual(mutations(s.events),[],name);assert(!s.events.includes('ledger'),name);
  assert.equal(attempt(s.saved).checks.resumeInstaller.result,'FAIL',name);
 }
 const source=readFileSync(new URL('./operator-release.mjs',import.meta.url),'utf8'),resume=source.slice(source.indexOf('async function leasedResumeArrival'));
 assert.match(resume,/installer:\(\)=>readFileSync\(join\(candidatePath,'\.github\/ci\/staging-build-install\.mjs'\),'utf8'\)/);
});
