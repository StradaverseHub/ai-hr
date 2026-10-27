/** Parent-operated staging release. CI never receives the operator's SSH credentials. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {verifyCi,revalidateCi,cleanHead,controllerRoot} from './release-ci.mjs';
import {STAGING,bindStaging,stagingTransport,strictPendingCommand} from './staging-transport.mjs';
import {stagingInstallerCommand,transferAndLaunchCiBuild,installationGrantFromVerifiedFiles,validatePrelaunchState} from './staging-ci-promotion.mjs';
import {expectedMigrationLedger,expectedBaselineMigrationLedger,validateMigrationLedgerRows,stagingLedgerProbeCommand,LEDGER_QUERY,verifyBaselineMigrationPreflight} from './staging-migration-ledger.mjs';
import {stagingEnvironmentProbeCommand} from './staging-environment.mjs';
import {createSourceChecksumObservation} from './staging-cleanup-protocol.mjs';
import {validateArrivalAndCleanupResult} from './arrival-cleanup-flow.mjs';
import {assertRsyncPacketCapability} from './rsync-packet-capability.mjs';
import {probeStagingProfile} from './staging-preflight.mjs';
export {STAGING,bindStaging};
export function followStagingDeployment(official,ssh,observation={}){
 return official.followDeploy({...observation,run:offset=>ssh(official.buildFollowCommand(offset),{encoding:null,stdio:['ignore','pipe','inherit']})});
}
export function requireSuccessfulBuild(official,status,sha){
 if(!official.isSuccessState(status.state??'unknown')||status.built_ref!==sha||status.stale_build!=='0')throw Error('Remote build/migration failed; no arrival or deployed board state claimed');
 return status;
}
export async function operatorRelease({candidatePath,runId,execute=false}){
 candidatePath=resolve(candidatePath);bindStaging(process.env);
 const packetTransport=execute?assertRsyncPacketCapability():null;
 // Import the ACTUAL frozen candidate's official release helpers; never rewrite its gate code.
 const load=async path=>{const raw=await import(pathToFileURL(join(candidatePath,path)).href);return {...(raw.default??{}),...raw};};
 const official=await load('scripts/improve/release.ts');
 const baselineRules=await load('scripts/gate-impact-git.ts');
 const {recordReleaseLearning}=await load('scripts/improve/release-learning.ts');
 const transport=stagingTransport(candidatePath,process.env);
 const ssh=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024,...options});
 const current=()=>official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
 const initial=current(),baseline=baselineRules.readyProductionBaseline(initial);
 cleanHead(candidatePath);cleanHead(controllerRoot);
 const profilePreflight=await probeStagingProfile({candidatePath,ssh});
 const expectedBaseline=expectedBaselineMigrationLedger(candidatePath,baseline);
 const baselineLedger=verifyBaselineMigrationPreflight({candidatePath,baseline,ssh});
 const evidence=await verifyCi({candidatePath,runId,baseline});
 const save=(name,data)=>writeFileSync(join(evidence.evidenceDirectory,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 save('operator-preflight.json',{...evidence,target:STAGING,baselineLedger,profilePreflight,execute,packetTransport});
 if(!execute)return evidence;
 const frozen=()=>{if(cleanHead(candidatePath)!==evidence.sha||cleanHead(controllerRoot)!==evidence.controller)throw Error('Verified source changed');};
 const revalidate=async({announced=false}={})=>{await probeStagingProfile({candidatePath,ssh});await revalidateCi(evidence);validatePrelaunchState(current(),{baseline,baselineBuildId:initial.built_build_id,candidate:evidence.sha,announced});
  if(!announced){const actual=JSON.parse(ssh(stagingLedgerProbeCommand(),{input:LEDGER_QUERY,timeout:20000,maxBuffer:4*1024**2}));const fresh=validateMigrationLedgerRows(expectedBaseline,actual);if(fresh.actualSha256!==baselineLedger.actualSha256)throw Error('Applied migration history changed before source transfer');}
 };
 frozen();await revalidate();
 const snapshot=JSON.parse(ssh(stagingEnvironmentProbeCommand()));
 if(Object.keys(snapshot).sort().join(',')!=='baselineBuildId,environmentSha256'||snapshot.baselineBuildId!==initial.built_build_id)throw Error('Actual baseline build differs from ready deployment state');
 const grant=installationGrantFromVerifiedFiles({evidence,run:JSON.parse(readFileSync(join(evidence.evidenceDirectory,'run.json'))),
  jobs:JSON.parse(readFileSync(join(evidence.evidenceDirectory,'jobs.json'))),...snapshot});
 await transferAndLaunchCiBuild({grant,evidence,official,ssh,save,frozen,revalidate,pendingCommand:strictPendingCommand(evidence.sha),
  transferSource:()=>execFileSync('rsync',transport.rsyncArgs(official,candidatePath),{stdio:'inherit',timeout:120000}),
  transferPacket:(packet,destination)=>execFileSync('rsync',transport.packetRsyncArgs(packet,destination),{stdio:'inherit',timeout:120000})});
 const status=followStagingDeployment(official,ssh);save('remote-build-result.json',status);
 requireSuccessfulBuild(official,status,evidence.sha);
 if(status.built_build_id!==grant.build.nextBuildId)throw Error('Actual installed build differs from original CI build');
 frozen();
 const checksum=execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...transport.rsyncArgs(official,candidatePath)],{encoding:'utf8',timeout:120000,maxBuffer:16*1024**2});
 const checksumCheckedAt=new Date().toISOString();
 save('source-arrival.json',{source:evidence.sha,checksum:true,output:checksum,checkedAt:checksumCheckedAt});
 if(checksum.length!==0)throw Error('Source checksum arrival differs; owned previous build retained for explicit recovery');
 frozen();
 const expectedLedger=expectedMigrationLedger(candidatePath);
 const observation=createSourceChecksumObservation(grant,{output:checksum,checkedAt:checksumCheckedAt});
 const combined=JSON.parse(ssh(stagingInstallerCommand('arrive-and-cleanup',grant.source,grant.installId,grant.build.buildRecordId),{input:JSON.stringify(observation),timeout:180000}));
 save('combined-arrival-cleanup.json',combined);
 const {initialArrival,arrival}=validateArrivalAndCleanupResult(combined,{grant,observation,expectedLedger});
 save('installed-arrival.json',{...initialArrival,fullSourceChecksumVerified:true});save('owned-cleanup.json',combined.cleaned);frozen();
 const finalChecksum=execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...transport.rsyncArgs(official,candidatePath)],{encoding:'utf8',timeout:120000,maxBuffer:16*1024**2});
 save('final-source-arrival.json',{source:evidence.sha,checksum:true,output:finalChecksum,checkedAt:new Date().toISOString()});
 if(finalChecksum.length!==0)throw Error('Final source checksum differs after cleanup; owner intervention required');frozen();
 // Preserve official learning only after actual service/build/source/ledger arrival.
 try{
  const record=recordReleaseLearning({worktree:candidatePath,sha:evidence.sha,buildId:status.built_build_id,previousRef:baseline,receipt:{...evidence,tier:'ci',result:'PASS'},status,
   mirror:record=>ssh('cd /opt/ai-hr && AIHR_IMPACT_STATE_DIR=/var/tmp/aihr-deploy/impact-learning /opt/node22/bin/node --import tsx scripts/gate-learning-cli.ts record-release',{input:JSON.stringify(record)})});
  save('release-learning.json',record);
 }catch(error){save('release-learning-warning.json',{error:String(error)});console.warn('Release learning requires retry; arrival evidence is retained: '+String(error));}
 // Coordinating owner still performs alpha/board handback. Immutable original CI/audit evidence is retained.
 return {...evidence,remoteBuild:status,installId:grant.installId,testingBuildRecordId:grant.build.buildRecordId,arrival,
  arrivalVerified:true,ownedResourceCleanupVerified:true,releaseHandbackVerified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,candidatePath,runId]=process.argv.slice(2);
 if(!['verify','deploy'].includes(mode)||!candidatePath||!/^\d+$/.test(runId??''))throw Error('Usage: node --import tsx operator-release.mjs <verify|deploy> <candidate-worktree> <run-id>');
 operatorRelease({candidatePath,runId,execute:mode==='deploy'}).then(result=>{console.log(JSON.stringify(result,null,2));process.exit(0);}).catch(error=>{console.error(error);process.exit(1);});
}
