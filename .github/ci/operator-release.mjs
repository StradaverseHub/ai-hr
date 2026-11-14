/** Parent-operated staging release. CI never receives the operator's SSH credentials. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {verifyCi,revalidateCi,cleanHead,controllerRoot} from './release-ci.mjs';
import {STAGING,bindStaging,stagingTransport,strictPendingCommand} from './staging-transport.mjs';
import {stagingInstallerCommand,transferAndLaunchCiBuild,installationGrantFromVerifiedFiles,validateInstalledArrival,validatePrelaunchState,validateFinalCleanup} from './staging-ci-promotion.mjs';
import {expectedMigrationLedger,expectedBaselineMigrationLedger,validateMigrationLedgerRows,stagingLedgerProbeCommand,LEDGER_QUERY,verifyBaselineMigrationPreflight} from './staging-migration-ledger.mjs';
import {stagingEnvironmentProbeCommand} from './staging-environment.mjs';
import {openNormalCleanupChannel,driveNormalCleanup} from './normal-cleanup-operator.mjs';
import {assertRsyncPacketCapability} from './rsync-packet-capability.mjs';
import {verifyRecoveredCi,revalidateRecoveredCi} from './focused-recovery.mjs';
import {verifyRepairedCi,revalidateRepairedCi} from './repair-recovery.mjs';
import {requireReviewedRepairController} from './repair-recovery-policy.mjs';
import {requireReviewedBrowserController} from './browser-recovery-policy.mjs';
import {verifyBrowserRecoveredCi,revalidateBrowserRecoveredCi} from './browser-recovery.mjs';
import {probeStagingProfile} from './staging-preflight.mjs';
import {readLease,guardCommand,guardedRsync,leasePhase,leaseAssert,redactLeaseError} from '../../scripts/staging/lease.mjs';
import {resumeArrival,findResumeEvidenceDirectory,readResumeEvidence,splitDeployFollow,IMPORT_WORKER_CHECK_COMMAND,SERVICE_HEALTH_COMMAND,DEPLOY_FINISH_COMMAND} from './resume-arrival.mjs';
export {STAGING,bindStaging};
// A full-tree --checksum dry run over SSH reads every candidate file on both sides; 120 s timed out on 12 Nov 2026
// after build activation (a manual rerun took 4.3 s on a warm cache). Match the source transfer's 600 s deadline.
export const CHECKSUM_TIMEOUT_MS=600000;
/** The one canonical full-tree source arrival proof: the candidate's own rsync filter, read-only, zero output required. */
export function sourceChecksumDryRun(official,transport,candidatePath,run=execFileSync){
 return run('rsync',['--dry-run','--checksum','--itemize-changes',...transport.rsyncArgs(official,candidatePath)],{encoding:'utf8',timeout:CHECKSUM_TIMEOUT_MS,maxBuffer:16*1024**2});
}
export function followStagingDeployment(official,ssh,observation={}){
 return official.followDeploy({...observation,run:offset=>ssh(official.buildFollowCommand(offset),{encoding:null,stdio:['ignore','pipe','inherit']})});
}
export function requireSuccessfulBuild(official,status,sha){
 if(!official.isSuccessState(status.state??'unknown')||status.built_ref!==sha||status.stale_build!=='0')throw Error('Remote build/migration failed; no arrival or deployed board state claimed');
 return status;
}
export async function operatorRelease(options){try{return await leasedOperatorRelease(options);}catch(error){throw redactLeaseError(error);}}
async function leasedOperatorRelease({candidatePath,runId,execute=false,recoveryRunIds=[],repair=null,browserRecovery=null}){
 candidatePath=resolve(candidatePath);bindStaging(process.env);
 if(browserRecovery&&(repair||recoveryRunIds.length))throw Error('Choose one explicitly versioned browser recovery route');
 if(browserRecovery)requireReviewedBrowserController({execute,controller:cleanHead(controllerRoot),reviewedController:process.env.AIHR_BROWSER_REVIEWED_CONTROLLER});
 if(execute&&repair)requireReviewedRepairController({execute,repair,controller:cleanHead(controllerRoot),reviewedController:process.env.AIHR_REPAIR_REVIEWED_CONTROLLER});
 const packetTransport=execute?assertRsyncPacketCapability():null;
 // Import the ACTUAL frozen candidate's official release helpers; never rewrite its gate code.
 const load=async path=>{const raw=await import(pathToFileURL(join(candidatePath,path)).href);return {...(raw.default??{}),...raw};};
 const official=await load('scripts/improve/release.ts');
 const baselineRules=await load('scripts/gate-impact-git.ts');
 const {recordReleaseLearning}=await load('scripts/improve/release-learning.ts');
 const transport=stagingTransport(candidatePath,process.env);
 const lease=execute?readLease(cleanHead(candidatePath)):null;
 const sshRaw=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024,...options});
 const ssh=(command,options={})=>sshRaw(lease?guardCommand(lease,command):command,options);
 const current=()=>official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
 const initial=current(),baseline=baselineRules.readyProductionBaseline(initial);
 cleanHead(candidatePath);cleanHead(controllerRoot);
 const profilePreflight=await probeStagingProfile({candidatePath,baseline,ssh});
 const expectedBaseline=expectedBaselineMigrationLedger(candidatePath,baseline);
 const baselineLedger=verifyBaselineMigrationPreflight({candidatePath,baseline,ssh});
 const recovering=recoveryRunIds.length>0;
 if(repair&&recovering)throw Error('Choose one explicitly versioned recovery route');
 const evidence=browserRecovery?await verifyBrowserRecoveredCi({...browserRecovery,candidatePath,runId,baseline}):repair?await verifyRepairedCi({...repair,candidatePath,runId,baseline}):recovering?await verifyRecoveredCi({candidatePath,runId,baseline,focusedRunIds:recoveryRunIds}):await verifyCi({candidatePath,runId,baseline});
 const save=(name,data)=>writeFileSync(join(evidence.evidenceDirectory,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 save('operator-preflight.json',{...evidence,target:STAGING,baselineLedger,profilePreflight,execute,packetTransport});
 if(!execute)return evidence;
 const frozen=()=>{if(cleanHead(candidatePath)!==evidence.sha||cleanHead(controllerRoot)!==(evidence.verificationController??evidence.controller))throw Error('Verified source changed');};
 const revalidate=async({announced=false}={})=>{await probeStagingProfile({candidatePath,baseline,announced,ssh});await (browserRecovery?revalidateBrowserRecoveredCi(evidence):repair?revalidateRepairedCi(evidence):recovering?revalidateRecoveredCi(evidence):revalidateCi(evidence));validatePrelaunchState(current(),{baseline,baselineBuildId:initial.built_build_id,candidate:evidence.sha,announced});
  if(!announced){const actual=JSON.parse(ssh(stagingLedgerProbeCommand(),{input:LEDGER_QUERY,timeout:20000,maxBuffer:4*1024**2}));const fresh=validateMigrationLedgerRows(expectedBaseline,actual);if(fresh.actualSha256!==baselineLedger.actualSha256)throw Error('Applied migration history changed before source transfer');}
 };
 frozen();await revalidate();
 leasePhase(lease,sshRaw,'installing');
 const snapshot=JSON.parse(ssh(stagingEnvironmentProbeCommand()));
 if(Object.keys(snapshot).sort().join(',')!=='baselineBuildId,environmentSha256'||snapshot.baselineBuildId!==initial.built_build_id)throw Error('Actual baseline build differs from ready deployment state');
 const grant=installationGrantFromVerifiedFiles({evidence,run:JSON.parse(readFileSync(join(evidence.evidenceDirectory,'run.json'))),
  jobs:JSON.parse(readFileSync(join(evidence.evidenceDirectory,'jobs.json'))),...snapshot});
 await transferAndLaunchCiBuild({grant,evidence,official,ssh,save,frozen,revalidate,pendingCommand:strictPendingCommand(evidence.sha),
  // Canonical transfer may need to apply thousands of source mtimes; retain a finite bundle-sized transport budget.
  transferSource:()=>execFileSync('rsync',guardedRsync(lease,transport.rsyncArgs(official,candidatePath)),{stdio:'inherit',timeout:600000}),
  transferPacket:(packet,destination)=>execFileSync('rsync',guardedRsync(lease,transport.packetRsyncArgs(packet,destination)),{stdio:'inherit',timeout:120000})});
 const status=followStagingDeployment(official,ssh);save('remote-build-result.json',status);
 requireSuccessfulBuild(official,status,evidence.sha);
 if(status.built_build_id!==grant.build.nextBuildId)throw Error('Actual installed build differs from original CI build');
 const {arrival}=await completeVerifiedArrival({official,ssh,sshRaw,lease,transport,candidatePath,evidence,grant,status,baseline,save,frozen,recordReleaseLearning});
 // Coordinating owner still performs alpha/board handback. Immutable original CI/audit evidence is retained.
 return {...evidence,remoteBuild:status,installId:grant.installId,testingBuildRecordId:grant.build.buildRecordId,arrival,
  arrivalVerified:true,ownedResourceCleanupVerified:true,releaseHandbackVerified:false};
}
/** Post-build arrival shared by `deploy` and `resume-arrival`: source checksum, installer runtime proof, optional owned
 * cleanup, lease phase `arrived`, then release learning. Callers have already required a successful deploy record. */
export async function completeVerifiedArrival({official,ssh,sshRaw,lease,transport,candidatePath,evidence,grant,status,baseline,save,frozen,recordReleaseLearning,installerStatusMode='status',ownedCleanup=true}){
 frozen();
 const checksum=sourceChecksumDryRun(official,transport,candidatePath);
 const checksumCheckedAt=new Date().toISOString();
 save('source-arrival.json',{source:evidence.sha,checksum:true,output:checksum,checkedAt:checksumCheckedAt});
 if(checksum.length!==0)throw Error('Source checksum arrival differs; owned previous build retained for explicit recovery');
 frozen();
 // Full read-only compiled-byte/runtime proof shares the installer's bounded verification budget.
 const installed=JSON.parse(ssh(stagingInstallerCommand(installerStatusMode,grant.source,grant.installId,grant.build.buildRecordId),{timeout:600000}));
 const expectedLedger=expectedMigrationLedger(candidatePath);
 const initialArrival=validateInstalledArrival(installed,grant,expectedLedger);save('installed-arrival.json',{...initialArrival,fullSourceChecksumVerified:true});frozen();
 let arrival=initialArrival;
 if(ownedCleanup){
  const cleanupCommand=stagingInstallerCommand('cleanup-session',grant.source,grant.installId,grant.build.buildRecordId);
  const channel=openNormalCleanupChannel(transport.sshArgs(guardCommand(lease,cleanupCommand)));
  const cleaned=await driveNormalCleanup({channel,grant,arrival:initialArrival,frozen,save,
   checksum:()=>sourceChecksumDryRun(official,transport,candidatePath)});
  arrival=validateFinalCleanup(cleaned,{grant,installed,expectedLedger});save('owned-cleanup.json',cleaned);frozen();
  const finalChecksum=sourceChecksumDryRun(official,transport,candidatePath);
  save('final-source-arrival.json',{source:evidence.sha,checksum:true,output:finalChecksum,checkedAt:new Date().toISOString()});
  if(finalChecksum.length!==0)throw Error('Final source checksum differs after cleanup; owner intervention required');frozen();
 }
 leasePhase(lease,sshRaw,'arrived',grant.build.nextBuildId);
 // Preserve official learning only after actual service/build/source/ledger arrival.
 try{
  const record=recordReleaseLearning({worktree:candidatePath,sha:evidence.sha,buildId:status.built_build_id,previousRef:baseline,receipt:{...evidence,tier:'ci',result:'PASS'},status,
   mirror:record=>ssh('cd /opt/ai-hr && AIHR_IMPACT_STATE_DIR=/var/tmp/aihr-deploy/impact-learning /opt/node22/bin/node --import tsx scripts/gate-learning-cli.ts record-release',{input:JSON.stringify(record)})});
  save('release-learning.json',record);
 }catch(error){save('release-learning-warning.json',{error:String(error)});console.warn('Release learning requires retry; arrival evidence is retained: '+String(error));}
 return {arrival,ownedResourceCleanupVerified:ownedCleanup};
}
/** aihr-resume-arrival/v1 (resume-arrival.mjs). Separate entry: the normal routes keep readyProductionBaseline and
 * requireSuccessfulBuild unchanged; this one admits only the activated-then-worker-check-failed record. */
export async function resumeArrivalRelease(options){try{return await leasedResumeArrival(options);}catch(error){throw redactLeaseError(error);}}
async function leasedResumeArrival({candidatePath,runId,execute=false}){
 candidatePath=resolve(candidatePath);bindStaging(process.env);
 const candidate=cleanHead(candidatePath),controller=cleanHead(controllerRoot);
 const load=async path=>{const raw=await import(pathToFileURL(join(candidatePath,path)).href);return {...(raw.default??{}),...raw};};
 const official=await load('scripts/improve/release.ts');
 const {recordReleaseLearning}=await load('scripts/improve/release-learning.ts');
 const transport=stagingTransport(candidatePath,process.env);
 const lease=execute?readLease(candidate):null;
 const sshRaw=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024,...options});
 const ssh=(command,options={})=>sshRaw(lease?guardCommand(lease,command):command,options);
 const evidence=readResumeEvidence(findResumeEvidenceDirectory(join(controllerRoot,'scratchpad'),runId));
 const save=(name,data)=>writeFileSync(join(evidence.directory,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 const frozen=()=>{if(cleanHead(candidatePath)!==candidate||cleanHead(controllerRoot)!==controller)throw Error('Verified source changed');};
 const {target:unusedTarget,baselineLedger:unusedLedger,profilePreflight:unusedProfile,execute:unusedExecute,packetTransport:unusedPacket,...verified}=evidence.preflight;
 const grant=evidence.grant;
 return resumeArrival({execute,candidate,controller,runId,target:STAGING,evidence,expectedLedger:expectedMigrationLedger(candidatePath),lease,save,frozen,ports:{
  leaseAssert:()=>leaseAssert(lease,sshRaw),
  follow:()=>splitDeployFollow(ssh(official.buildFollowCommand(0),{encoding:null,timeout:120000,maxBuffer:256*1024**2}),{sentinel:official.DEPLOY_STATE_SENTINEL,parse:official.parseDeployStatus}),
  status:()=>official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status')),
  worker:()=>ssh(IMPORT_WORKER_CHECK_COMMAND,{timeout:120000}),
  service:()=>ssh(SERVICE_HEALTH_COMMAND,{timeout:30000}),
  checksum:()=>sourceChecksumDryRun(official,transport,candidatePath),
  installer:()=>readFileSync(join(candidatePath,'.github/ci/staging-build-install.mjs'),'utf8'),
  ledger:()=>JSON.parse(ssh(stagingLedgerProbeCommand(),{input:LEDGER_QUERY,timeout:20000,maxBuffer:4*1024**2})),
  finish:()=>ssh(DEPLOY_FINISH_COMMAND,{timeout:60000}),
  requireBuilt:status=>requireSuccessfulBuild(official,status,candidate),
  // The installation grant expired long ago; the read-only resume-status proof replaces status, and owned cleanup
  // (which requires an unexpired grant) is NOT run: the previous build stays retained for explicit owner cleanup.
  arrive:status=>completeVerifiedArrival({official,ssh,sshRaw,lease,transport,candidatePath,evidence:verified,grant,status,baseline:grant.baseline,save,frozen,recordReleaseLearning,installerStatusMode:'resume-status',ownedCleanup:false}),
 }});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,candidatePath,runId,focused]=process.argv.slice(2),recovering=['verify-recovery','deploy-recovery'].includes(mode),repairing=['verify-repair','deploy-repair'].includes(mode);
 const done=promise=>promise.then(result=>{console.log(JSON.stringify(result,null,2));process.exit(0);}).catch(error=>{console.error(error);process.exit(1);});
 if(['verify-resume-arrival','resume-arrival'].includes(mode)){
  if(!candidatePath||!/^\d+$/.test(runId??'')||focused!==undefined)throw Error('Usage: node --import tsx operator-release.mjs <verify-resume-arrival|resume-arrival> <candidate-worktree> <original-run-id>');
  done(resumeArrivalRelease({candidatePath,runId,execute:mode==='resume-arrival'}));
 }else{
 if(!['verify','deploy','verify-recovery','deploy-recovery','verify-repair','deploy-repair','verify-browser-recovery','deploy-browser-recovery'].includes(mode)||!candidatePath||!/^\d+$/.test(runId??'')||((recovering||repairing||['verify-browser-recovery','deploy-browser-recovery'].includes(mode))?!focused:focused!==undefined))throw Error('Usage: node --import tsx operator-release.mjs <verify|deploy|verify-recovery|deploy-recovery|verify-repair|deploy-repair|verify-browser-recovery|deploy-browser-recovery> <candidate-worktree> <original-run-id> [JSON-focused-run-ids|JSON-repair-options|JSON-browser-recovery-options]');
 done(operatorRelease({candidatePath,runId,execute:mode.startsWith('deploy'),recoveryRunIds:recovering?JSON.parse(focused):[],repair:repairing?JSON.parse(focused):null,browserRecovery:['verify-browser-recovery','deploy-browser-recovery'].includes(mode)?JSON.parse(focused):null}));
 }
}
