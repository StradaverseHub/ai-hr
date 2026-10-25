/** Parent-operated staging release. CI never receives the operator's SSH credentials. */
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {verifyCi,revalidateCi,cleanHead,controllerRoot} from './release-ci.mjs';
export const STAGING=Object.freeze({host:'203.142.6.241',port:'8288',user:'ubuntu',directory:'/opt/ai-hr',stateDirectory:'/var/tmp/aihr-deploy'});
export function bindStaging(env){
 const values={IMPROVE_SSH_HOST:STAGING.host,IMPROVE_SSH_PORT:STAGING.port,IMPROVE_SSH_USER:STAGING.user,IMPROVE_REMOTE_DIR:STAGING.directory,AIHR_DEPLOY_STATE_DIR:STAGING.stateDirectory};
 for(const [key,value] of Object.entries(values)){if(env[key]&&env[key]!==value)throw Error('Staging target mismatch: '+key);env[key]=value;}
 return values;
}
export function followStagingDeployment(official,ssh,observation={}){
 return official.followDeploy({...observation,run:offset=>ssh(official.buildFollowCommand(offset),{encoding:null,stdio:['ignore','pipe','inherit']})});
}
export function requireSuccessfulBuild(official,status,sha){
 if(!official.isSuccessState(status.state??'unknown')||status.built_ref!==sha||status.stale_build!=='0')throw Error('Remote build/migration failed; no arrival or deployed board state claimed');
 return status;
}
export async function operatorRelease({candidatePath,runId,execute=false}){
 candidatePath=resolve(candidatePath);bindStaging(process.env);
 // Node must be launched with --import tsx from the candidate's installed toolchain.
 // Import the ACTUAL frozen candidate's official release helpers; never rewrite its gate code.
 const load=async path=>{const raw=await import(pathToFileURL(join(candidatePath,path)).href);return {...(raw.default??{}),...raw};};
 const official=await load('scripts/improve/release.ts');
 const baselineRules=await load('scripts/gate-impact-git.ts');
 const testing=await load('scripts/improve/system-testing-manifest.ts');
 const {stableTestingJson}=await load('lib/system-testing/hash.ts');
 const {recordReleaseLearning}=await load('scripts/improve/release-learning.ts');
 const ssh=(command,options={})=>execFileSync('ssh',official.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024,...options});
 const current=()=>official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
 const baseline=baselineRules.readyProductionBaseline(current());
 const evidence=verifyCi({candidatePath,runId,baseline});
 const save=(name,data)=>writeFileSync(join(evidence.evidenceDirectory,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 save('operator-preflight.json',{...evidence,target:STAGING,execute});
 if(!execute)return evidence;
 const frozen=()=>{if(cleanHead(candidatePath)!==evidence.sha||cleanHead(controllerRoot)!==evidence.controller)throw Error('Verified source changed');};
 frozen();revalidateCi(evidence);
 if(baselineRules.readyProductionBaseline(current())!==baseline)throw Error('Staging baseline moved before deployment');
 const build=testing.prepareSystemTestingBuild({worktree:candidatePath,candidate:evidence.sha,buildRecordId:randomUUID()});
 const localDirectory=testing.systemTestingBuildDirectory('local');testing.ensurePrivateReleaseDirectory(localDirectory);testing.publishSystemTestingBuild(build,localDirectory);
 frozen();
 if(stableTestingJson(testing.prepareSystemTestingBuild({worktree:candidatePath,candidate:evidence.sha,buildRecordId:build.identity.buildRecordId}))!==stableTestingJson(build))throw Error('System Testing source changed');
 // Strict announcement, canonical rsync filter, immutable record transfer, detached launch and poll.
 ssh(official.buildPendingCommand(evidence.sha),{stdio:'inherit'});
 frozen();execFileSync('rsync',official.deploymentRsyncArgs(candidatePath),{stdio:'inherit'});
 ssh(official.buildTestingRecordCommand(evidence.sha,build.identity.buildRecordId),{input:stableTestingJson(build)+'\n',stdio:['pipe','inherit','inherit']});
 const launch=ssh(official.buildLaunchCommand(evidence.sha,STAGING.directory,STAGING.stateDirectory,build.identity.buildRecordId));
 save('launch.json',{output:launch,testingBuildRecordId:build.identity.buildRecordId});
 const status=followStagingDeployment(official,ssh);save('remote-build-result.json',status);
 requireSuccessfulBuild(official,status,evidence.sha);
 // Preserve the official durable learning + outside-source mirror. CI remains tier=ci throughout.
 try{
  const record=recordReleaseLearning({worktree:candidatePath,sha:evidence.sha,buildId:status.built_build_id,previousRef:baseline,receipt:{...evidence,tier:'ci',result:'PASS'},status,
   mirror:record=>ssh('cd /opt/ai-hr && AIHR_IMPACT_STATE_DIR=/var/tmp/aihr-deploy/impact-learning /opt/node20/bin/node --import tsx scripts/gate-learning-cli.ts record-release',{input:JSON.stringify(record)})});
  save('release-learning.json',record);
 }catch(error){save('release-learning-warning.json',{error:String(error)});console.warn('Release learning requires retry; actual remote build result is retained: '+String(error));}
 // Restart, active health, zero-checksum arrival, full ledger proof, alpha advance and board writes
 // remain the coordinating parent's existing required completion steps; this reports only build result.
 return {...evidence,remoteBuild:status,testingBuildRecordId:build.identity.buildRecordId,arrivalVerified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,candidatePath,runId]=process.argv.slice(2);
 if(!['verify','deploy'].includes(mode)||!candidatePath||!/^\d+$/.test(runId??''))throw Error('Usage: node --import tsx operator-release.mjs <verify|deploy> <candidate-worktree> <run-id>');
 operatorRelease({candidatePath,runId,execute:mode==='deploy'}).then(result=>{console.log(JSON.stringify(result,null,2));process.exit(0);}).catch(error=>{console.error(error);process.exit(1);});
}
