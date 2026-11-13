/** aihr-resume-arrival/v1 — finish ONE interrupted staging CI installation.
 *
 * Admitted state, and nothing else: the normal `deploy` route transferred, migrated, activated and health-verified
 * the exact CI build (installer record CI_BUILD_ACTIVE_SERVICE_VERIFIED_NOT_FULL_ARRIVAL), then deploy/deploy.sh
 * failed at its final import-worker check, so the deploy record is failed at phase ci-build-health. Every later
 * route refuses that record (readyProductionBaseline, requireSuccessfulBuild, an expired installation grant), so this
 * versioned route re-proves the live facts, closes the deploy record through the lease guard and then runs the
 * normal post-build arrival steps. It never transfers source, migrates, activates, restarts or cleans anything.
 * Pure policy and sequencing only; operator-release.mjs supplies the actual SSH/rsync ports. */
import assert from 'node:assert/strict';
import {existsSync,readdirSync,readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {validateInstallGrant,installHash,installJson} from './ci-install-grant.mjs';
import {validateMigrationLedgerRows} from './staging-migration-ledger.mjs';

export const RESUME_ARRIVAL_POLICY='aihr-resume-arrival/v1';
export const RESUME_PHASE='ci-build-health';
/** deploy.sh's own message when AIHR_IMPORT_WORKER_REQUIRED=1 and scripts/check-import-worker.ts fails. */
export const WORKER_FAILURE_MARKER='Import worker check failed (status ';
const ACTIVE='CI_BUILD_ACTIVE_SERVICE_VERIFIED_NOT_FULL_ARRIVAL',ACTIVATED='CI_BUILD_BYTES_ACTIVATED_NOT_FULL_ARRIVAL';
const LEDGER_KIND='READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE';
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
export const RESUME_REQUIRED_EVIDENCE=['operator-preflight.json','installation-grant.json','installation-initialized.json','launch.json','remote-build-result.json'];
/** Any of these means the build already arrived (or a resume already ran); this route is then not applicable. */
export const RESUME_REFUSING_EVIDENCE=['source-arrival.json','installed-arrival.json','owned-cleanup.json','final-source-arrival.json','resume-arrival.json'];
/** Deploy-record fields that must be byte-identical to the operator's own terminal observation. */
export const DEPLOY_RECORD_IDENTITY=['state','phase','ref','pid','exit_code','started_at','finished_at','log','build_id','built_ref','built_build_id','stale_build'];
/** Pinned Node, the same check and wait deploy.sh runs. Exit 0 only when every bulk-job kind has a live worker. */
export const IMPORT_WORKER_CHECK_COMMAND='cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx scripts/check-import-worker.ts --wait 45';
/** Read-only service and loopback /health probe on the service's own configured port. */
export const SERVICE_HEALTH_COMMAND=[
 'set -eu','cd /opt/ai-hr',
 'printf \'service=%s\\n\' "$(systemctl is-active aihr || true)"',
 '/opt/node22/bin/node --env-file=.env.production --input-type=module -e \'const port=process.env.PORT??"3000";if(!/^[1-9][0-9]{0,4}$/.test(port))throw Error("Bounded service port required");const r=await fetch("http://127.0.0.1:"+port+"/health",{redirect:"manual",signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({healthStatus:r.status,body:(await r.text()).slice(0,4096)}));\'',
].join('\n');
export const DEPLOY_FINISH_COMMAND='cd /opt/ai-hr && deploy/deploy-state.sh finish 0';

const authorization=grant=>installHash(Buffer.from(installJson(grant)+'\n'));

/** The operator's own retained deploy evidence for this run: exactly one launched validated-ci directory. */
export function findResumeEvidenceDirectory(scratchpad,runId){
 assert(/^[1-9][0-9]*$/.test(String(runId??'')),'Exact original run ID required');
 const pattern=new RegExp('^validated-ci-'+runId+'-'+UUID+'$');
 const names=existsSync(scratchpad)?readdirSync(scratchpad).filter(name=>pattern.test(name)&&existsSync(join(scratchpad,name,'launch.json'))):[];
 assert(names.length===1,'Exactly one launched validated-ci-'+runId+' evidence directory required; found '+names.length);
 const directory=join(scratchpad,names[0]),st=lstatSync(directory);
 assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o077)===0,'Private operator-owned evidence directory required');
 return directory;
}
export function readResumeEvidence(directory){
 for(const name of RESUME_REFUSING_EVIDENCE)assert(!existsSync(join(directory,name)),'Retained evidence already records '+name+'; resume admits only an unarrived installation');
 const read=name=>{
  const path=join(directory,name);assert(existsSync(path),'Retained evidence missing: '+name);
  const st=lstatSync(path);assert(st.isFile()&&!st.isSymbolicLink()&&st.size>0&&st.size<=64*1024**2,'Bounded regular retained evidence required: '+name);
  return JSON.parse(readFileSync(path,'utf8'));
 };
 return {directory,preflight:read('operator-preflight.json'),grant:read('installation-grant.json'),initialized:read('installation-initialized.json'),launch:read('launch.json'),remoteBuild:read('remote-build-result.json')};
}

/** The deploy record shape this route exists for. Anything else (pending, running, earlier failure, other source/build) refuses. */
export function admitInterruptedDeployRecord(status,{grant,candidate}){
 assert(status&&status.state==='failed'&&status.phase===RESUME_PHASE&&status.exit_code==='1','Only a deploy that failed (exit 1) at phase '+RESUME_PHASE+' can resume arrival');
 assert(status.ref===candidate&&status.build_id===grant.build.nextBuildId,'Failed deploy must name the candidate and the running .next/BUILD_ID must be its original CI build');
 assert(status.built_ref===grant.baseline&&status.built_build_id===grant.baselineBuildId&&status.stale_build==='1','Last successful deploy must still be the grant baseline');
 return status;
}
export function admitRetainedEvidence({evidence,candidate,controller,runId,target}){
 const {directory,preflight:p,grant:g,initialized:i,launch:l,remoteBuild:r}=evidence;
 validateInstallGrant(g,{allowExpired:true});
 assert(p?.execute===true&&isDeepStrictEqual(p.target,target)&&p.evidenceDirectory===directory,'Retained preflight is not this executed staging deployment');
 assert(p.sha===candidate&&Number(p.runId)===Number(runId)&&(p.verificationController??p.controller)===controller,'Retained evidence candidate/run/controller differs');
 assert(g.source===candidate&&g.runId===Number(runId)&&g.controller===p.controller&&g.baseline===p.baseline,'Installation grant differs from retained evidence');
 assert(i?.installId===g.installId&&i.releaseAuthorized===false&&i.authorizationSha256===authorization(g),'Installation acknowledgement differs from installation grant');
 assert(l?.installId===g.installId&&l.testingBuildRecordId===g.build.buildRecordId&&l.nextBuildId===g.build.nextBuildId,'Launch record differs from installation grant');
 admitInterruptedDeployRecord(r,{grant:g,candidate});
 return {installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,baseline:g.baseline,baselineBuildId:g.baselineBuildId,authorizationSha256:authorization(g)};
}
/** The live record must still be the operator's own terminal observation: no other deploy, finish or pending since. */
export function admitLiveDeployRecord(status,{evidence,candidate}){
 admitInterruptedDeployRecord(status,{grant:evidence.grant,candidate});
 for(const key of DEPLOY_RECORD_IDENTITY)assert(status[key]===evidence.remoteBuild[key],'Live deploy record differs from the retained remote-build result: '+key);
 return Object.fromEntries(DEPLOY_RECORD_IDENTITY.map(key=>[key,status[key]]));
}
/** One `deploy-state.sh follow 0` reply: the current deploy log, the sentinel, then the status block. */
export function splitDeployFollow(bytes,{sentinel,parse}){
 assert(Buffer.isBuffer(bytes),'Binary follow reply required');
 const i=bytes.lastIndexOf(sentinel);assert(i>=0,'Deploy follow reply has no status sentinel');
 return {log:bytes.subarray(0,i).toString('utf8'),status:parse(bytes.subarray(i+Buffer.byteLength(sentinel)).toString('utf8'))};
}
/** The installer's own JSON lines in the remote deploy log. The LAST one must be this installation's active-service
 * record with health 200 and the verified candidate ledger, preceded by exactly one matching byte activation, and the
 * only failure after it must be deploy.sh's import-worker check. */
export function validateActivationLog(log,{grant,expectedLedger}){
 assert(typeof log==='string'&&log.length>0,'Remote deploy log required');
 const records=[];let end=0;
 for(const match of log.matchAll(/^\{.*\}$/gm)){
  let value;try{value=JSON.parse(match[0]);}catch{continue;}
  if(typeof value?.kind==='string'&&value.kind.startsWith('CI_BUILD_')){records.push(value);end=match.index+match[0].length;}
 }
 const active=records.at(-1),auth=authorization(grant);
 assert(active?.kind===ACTIVE,'Last installer record must be '+ACTIVE);
 assert(active.format===1&&active.source===grant.source&&active.installId===grant.installId&&active.buildRecordId===grant.build.buildRecordId&&active.nextBuildId===grant.build.nextBuildId&&active.authorizationSha256===auth,'Activation record differs from the original installation');
 assert(active.healthStatus===200&&active.releaseAuthorized===false&&active.fullMigrationLedgerVerified===true&&/^[1-9][0-9]*$/.test(active.pid??''),'Activation record must show the healthy restarted service');
 const ledger=active.migrationLedger;
 assert(ledger?.kind===LEDGER_KIND&&ledger.releaseAuthorized===false&&ledger.rows===expectedLedger.length&&ledger.expectedSha256===installHash(installJson(expectedLedger))&&/^[a-f0-9]{64}$/.test(ledger.actualSha256??''),'Activation record must carry the verified candidate migration ledger');
 const activated=records.filter(r=>r.kind===ACTIVATED&&r.installId===grant.installId);
 assert(activated.length===1&&activated[0].source===grant.source&&activated[0].nextBuildId===grant.build.nextBuildId&&activated[0].authorizationSha256===auth&&activated[0].activation?.activeBuildId===grant.build.nextBuildId,'Exactly one matching byte activation must precede the active-service record');
 const after=log.slice(end);
 assert(after.includes(WORKER_FAILURE_MARKER),'Only a failure at the final import-worker check can resume arrival');
 return {activeRecord:active,activatedAt:activated[0].activatedAt??null,failureAfterActivation:after.slice(-4096)};
}
export function validateWorkerCheck(output){
 assert(typeof output==='string'&&/^Import worker ready for: .+\.$/m.test(output),'Import worker check must report every kind served');
 return {output:output.trim().slice(-4096)};
}
export function validateServiceHealth(output){
 const lines=String(output??'').trim().split('\n');
 assert(lines.length===2&&lines[0]==='service=active','Service aihr is not active');
 const probe=JSON.parse(lines[1]);let body;try{body=JSON.parse(probe.body);}catch{body=null;}
 assert(probe.healthStatus===200&&body?.status==='ok','/health must return 200 {"status":"ok"}');
 return {service:'active',healthStatus:200,body};
}
export function validateZeroDifferenceChecksum(output){
 assert(typeof output==='string','Checksum dry-run output required');
 const differences=output.split('\n').filter(line=>line.trim()).length;
 assert(output.length===0,'Source checksum differs from the frozen candidate ('+differences+' entries)');
 return {checksum:true,differences:0,output};
}
/** Fresh full ledger, unchanged since the activation record proved it. */
export function validateResumeLedger(rows,{expectedLedger,activeRecord}){
 const ledger=validateMigrationLedgerRows(expectedLedger,rows);
 assert(ledger.expectedSha256===activeRecord.migrationLedger.expectedSha256&&ledger.actualSha256===activeRecord.migrationLedger.actualSha256,'Applied migration ledger changed since activation');
 return ledger;
}
export function validateHeldLease(held,{lease,candidate}){
 assert(lease&&lease.candidate===candidate,'Matching held staging lease required');
 assert(held?.releaseAuthorized===false&&held.batch===lease.batch&&held.epoch===lease.epoch&&held.candidate===candidate,'Held lease batch/epoch/candidate differs');
 assert(held.phase==='installing','Resume requires the lease still in phase installing; found '+held.phase);
 return {batch:held.batch,epoch:held.epoch,candidate:held.candidate,phase:held.phase};
}

/** Sequencing. `ports` are the only side effects; execute adds the lease check, the guarded finish and arrival. */
export async function resumeArrival({execute,candidate,controller,runId,target,evidence,expectedLedger,lease,ports,save,frozen,now=()=>new Date()}){
 const mode=execute?'resume-arrival':'verify-resume-arrival',startedAt=now().toISOString();
 const record={format:1,kind:'RESUME_ARRIVAL_ATTEMPT',policy:RESUME_ARRIVAL_POLICY,mode,candidate,controller,runId:Number(runId),evidenceDirectory:evidence.directory,startedAt,checks:{},releaseAuthorized:false};
 const check=async(name,run)=>{
  try{const value=await run();record.checks[name]={result:'PASS',...value};return value;}
  catch(error){record.checks[name]={result:'FAIL',error:String(error?.message??error)};throw error;}
 };
 const live=async name=>{
  const {log,status}=ports.follow();
  const deployRecord=await check(name+'DeployRecord',()=>({record:admitLiveDeployRecord(status,{evidence,candidate})}));
  const activation=await check(name+'ActivationLog',()=>validateActivationLog(log,{grant:evidence.grant,expectedLedger}));
  return {deployRecord,activation};
 };
 try{
  if(execute)assert(lease,'resume-arrival requires the matching held staging lease');
  await check('retainedEvidence',()=>admitRetainedEvidence({evidence,candidate,controller,runId,target}));
  frozen();
  if(execute)await check('lease',()=>validateHeldLease(ports.leaseAssert(),{lease,candidate}));
  const {activation}=await live('admission');
  await check('importWorker',()=>validateWorkerCheck(ports.worker()));
  await check('serviceHealth',()=>validateServiceHealth(ports.service()));
  frozen();
  await check('sourceChecksum',()=>validateZeroDifferenceChecksum(ports.checksum()));
  await check('migrationLedger',()=>validateResumeLedger(ports.ledger(),{expectedLedger,activeRecord:activation.activeRecord}));
  if(!execute){record.result='ADMISSIBLE_NOT_EXECUTED';return record;}
  // Immediately before the only mutation, the record must still be exactly the one admitted above.
  await live('prefinish');frozen();
  await check('deployFinish',()=>({output:String(ports.finish()??'').slice(-4096)}));
  const status=ports.status();
  await check('deployRecordOk',()=>{ports.requireBuilt(status);assert(status.built_build_id===evidence.grant.build.nextBuildId&&status.build_id===evidence.grant.build.nextBuildId,'Finished deploy record build differs from original CI build');return {state:status.state,ref:status.ref,built_ref:status.built_ref,build_id:status.build_id,stale_build:status.stale_build};});
  const arrived=await check('arrival',async()=>{const value=await ports.arrive(status);return {arrival:value.arrival,ownedResourceCleanupVerified:value.ownedResourceCleanupVerified};});
  record.result='ARRIVED';record.remoteBuild=status;
  save('resume-arrival.json',{...record,arrival:arrived.arrival});
  return {...record,arrival:arrived.arrival};
 }catch(error){record.result='REFUSED';record.error=String(error?.message??error);throw error;}
 finally{record.finishedAt=now().toISOString();save('resume-arrival-'+mode+'-'+startedAt.replace(/[^0-9]/g,'')+'.json',record);}
}
