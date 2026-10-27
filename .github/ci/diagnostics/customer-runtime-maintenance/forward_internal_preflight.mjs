/** Bounded forward recovery of the original9541 build after internal-auth module interop refusal. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
export const ORIGINAL=`  node --import tsx --input-type=module -e 'import { internalConfig } from "./lib/internal-auth/config.ts"; internalConfig();'`;
export const REPAIRED=`  node --import tsx --input-type=module -e 'const imported=await import("./lib/internal-auth/config.ts"); const {internalConfig}=imported.default??imported; internalConfig();'`;
export function repairDeployScript(source){
 assert(source.split(ORIGINAL).length===2,'Exactly one frozen internal-auth preflight required');
 const result=source.replace(ORIGINAL,REPAIRED);
 assert(result.replace(REPAIRED,ORIGINAL)===source,'Only the reviewed import expression may change');return result;
}
export const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function recoveryWrapper(source){return '#!/bin/bash\nset -euo pipefail\nexec /bin/bash -c '+quote(repairDeployScript(source))+' /opt/ai-hr/deploy/deploy.sh "$@"\n';}
const hash=b=>createHash('sha256').update(b).digest('hex');
const SOURCE='9541b1686d7941f89e564723271e48bf85a21a89',BASELINE='2127b1a7ebd40e5b9ee7d010e72e75d4b1cb3e9f';
export function requireOriginalFailedAttempt(state,grant){
 assert(state.state==='failed'&&state.phase==='preflight'&&state.ref===SOURCE&&state.built_ref===BASELINE
  &&state.build_id===grant.baselineBuildId&&state.built_build_id===grant.baselineBuildId&&state.stale_build==='1'&&state.exit_code==='1',
 'Exact terminal preflight failure with retained original build required');
}
async function main(){
 const[candidate,execution,planPath,sshConfig,output]=process.argv.slice(2);assert(output&&process.argv.length===7);
 const root=resolve(candidate),old=resolve(execution),out=resolve(output);mkdirSync(out,{mode:0o700});
 const save=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 const load=async name=>{const raw=await import(pathToFileURL(join(root,name)).href);return{...(raw.default??{}),...raw};};
 const official=await load('scripts/improve/release.ts');
 const {cleanHead,revalidateCi}=await load('.github/ci/release-ci.mjs');
 const {validateInstallGrant,installHash,installJson}=await load('.github/ci/ci-install-grant.mjs');
 const {stagingTransport}=await load('.github/ci/staging-transport.mjs');
 const {probeStagingProfile}=await load('.github/ci/staging-preflight.mjs');
 const {stagingEnvironmentProbeCommand}=await load('.github/ci/staging-environment.mjs');
 const {verifyBaselineMigrationPreflight,expectedMigrationLedger}=await load('.github/ci/staging-migration-ledger.mjs');
 const {stagingInstallerCommand,validateInstalledArrival,validateFinalCleanup}=await load('.github/ci/staging-ci-promotion.mjs');
 const {createCleanupRequest}=await load('.github/ci/staging-cleanup-protocol.mjs');
 const {followStagingDeployment,requireSuccessfulBuild}=await load('.github/ci/operator-release.mjs');
 const evidence=JSON.parse(readFileSync(join(old,'verification.json'))),grant=validateInstallGrant(JSON.parse(readFileSync(join(old,'installation-grant.json'))));
 const plan=JSON.parse(readFileSync(planPath));
 assert(cleanHead(root)===SOURCE&&evidence.sha===SOURCE&&evidence.controller===SOURCE&&evidence.runId===40373362234
  &&grant.source===SOURCE&&grant.controller===SOURCE&&grant.baseline===BASELINE&&grant.installId==='bf819bdf-7798-4d2d-9a8b-2cff83989b83'
  &&plan.candidate===SOURCE&&plan.baseline===BASELINE,'Exact original source and installation required');
 const transport=stagingTransport(root,{...process.env,AIHR_SSH_CONFIG:resolve(sshConfig)});
 const ssh=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:8*1024**2,...options});
 const state=()=>official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
 const checksum=()=>execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...transport.rsyncArgs(official,root)],{encoding:'utf8',timeout:120000,maxBuffer:8*1024**2});
 const originalScript=readFileSync(join(root,'deploy/deploy.sh'),'utf8');
 assert(originalScript===execFileSync('git',['show',SOURCE+':deploy/deploy.sh'],{cwd:root,encoding:'utf8'}));
 const wrapper=recoveryWrapper(originalScript);execFileSync('/bin/bash',['-n'],{input:wrapper});
 const recoveryId=randomUUID(),remote='/var/tmp/aihr-forward-'+recoveryId,remoteScript=remote+'/run.sh';
 const moduleCheck='const imported=await import("./lib/internal-auth/config.ts");const {internalConfig}=imported.default??imported;internalConfig();console.log("INTERNAL_AUTH_PREFLIGHT_PASS");';
 async function guard(){
  assert(cleanHead(root)===SOURCE);requireOriginalFailedAttempt(state(),grant);await revalidateCi(evidence);
  validateInstallGrant(grant);await probeStagingProfile({candidatePath:root,ssh});
  const env=JSON.parse(ssh(stagingEnvironmentProbeCommand()));assert(env.environmentSha256===grant.environmentSha256&&env.baselineBuildId===grant.baselineBuildId);
  const ledger=verifyBaselineMigrationPreflight({candidatePath:root,baseline:BASELINE,ssh});
  assert(ledger.actualSha256===JSON.parse(readFileSync(join(old,'operator-preflight.json'))).baselineLedger.actualSha256);
  const db=JSON.parse(ssh('cd /opt/ai-hr && env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /opt/node22/bin/node --input-type=module',{input:plan.databaseProgram,timeout:60000}));assert.deepEqual(db,plan.database);
  const inspect=`import{readPrivateInstall}from'./.github/ci/staging-build-install.mjs';import{readFileSync,existsSync}from'node:fs';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';const p=readPrivateInstall(${JSON.stringify(grant.installId)});for(const n of['next','verified.json','activated.json','runtime.json','cleanup-authorized.json'])if(existsSync(p.directory+'/'+n))throw Error('Attempt advanced');for(const k of['MainPID','ControlPID'])if(execFileSync('/usr/bin/systemctl',['show','aihr','--property='+k,'--value']).toString().trim()!=='0')throw Error('Service process active');if(execFileSync('/usr/bin/systemctl',['show','aihr','--property=ActiveState','--value']).toString().trim()!=='inactive')throw Error('Service not inactive');const bytes=readFileSync(p.packet+'/bytes/build-bundle.tar.gz');if(bytes.length!==${grant.build.archiveBytes}||createHash('sha256').update(bytes).digest('hex')!==${JSON.stringify(grant.build.archiveSha256)})throw Error('Archive differs');console.log(JSON.stringify({authorizationSha256:p.authorizationSha256,archiveBytes:bytes.length}));`;
  const recipient=JSON.parse(ssh('cd /opt/ai-hr && /opt/node22/bin/node --input-type=module',{input:inspect,timeout:60000}));assert(recipient.authorizationSha256===installHash(Buffer.from(installJson(grant)+'\n')));
  assert(ssh('cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx --input-type=module -e '+quote(moduleCheck)).trim()==='INTERNAL_AUTH_PREFLIGHT_PASS');
  assert(checksum()==='','Exact source checksum differs');assert(cleanHead(root)===SOURCE);requireOriginalFailedAttempt(state(),grant);
  return{environment:env,ledger,recipient,databaseCustodyUnchanged:true};
 }
 const checked=await guard();
 save('forward-recovery-preflight.json',{...checked,kind:'EXPLICIT_FORWARD_RECOVERY_NOT_ORIGINAL_OPERATOR_SUCCESS',source:SOURCE,installId:grant.installId,originalExecutionDirectory:old,originalScriptSha256:hash(originalScript),repairedScriptSha256:hash(repairDeployScript(originalScript)),wrapperSha256:hash(wrapper),recoveryId,onlyChangedExpression:{before:ORIGINAL,after:REPAIRED},databaseRollback:false});
 // A private external executable retains the complete original spine and argv/$0 semantics.
 const upload=`import os,sys,hashlib;parent=${JSON.stringify(remote)};data=sys.stdin.buffer.read(200001);assert 0<len(data)<=200000 and hashlib.sha256(data).hexdigest()==${JSON.stringify(hash(wrapper))};os.mkdir(parent,0o700);fd=os.open(parent+'/run.sh',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700)\nwith os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())`;
 ssh('python3 -I -c '+quote(upload),{input:wrapper});
 let launch=official.buildLaunchCommand(SOURCE,'/opt/ai-hr','/var/tmp/aihr-deploy',grant.build.buildRecordId,grant.installId);
 assert(launch.split('setsid nohup ./deploy/deploy.sh').length===2);launch=launch.replace('setsid nohup ./deploy/deploy.sh','setsid nohup '+remoteScript);
 // Recheck mutating admission immediately before the detached launch. No new source transfer/grant/initialization.
 requireOriginalFailedAttempt(state(),grant);validateInstallGrant(grant);assert(cleanHead(root)===SOURCE);
 const launched=ssh(launch);save('forward-launch.json',{output:launched,source:SOURCE,installId:grant.installId,remoteScript});
 const status=followStagingDeployment(official,ssh);save('remote-build-result.json',status);requireSuccessfulBuild(official,status,SOURCE);assert(status.built_build_id===grant.build.nextBuildId);
 assert(cleanHead(root)===SOURCE);const raw=checksum(),checkedAt=new Date().toISOString();save('source-arrival.json',{source:SOURCE,output:raw,checkedAt});assert(raw==='');
 const installed=JSON.parse(ssh(stagingInstallerCommand('status',SOURCE,grant.installId,grant.build.buildRecordId),{timeout:60000}));
 const expectedLedger=expectedMigrationLedger(root);const initial=validateInstalledArrival(installed,grant,expectedLedger);save('installed-arrival.json',initial);
 const request=createCleanupRequest(grant,{output:raw,checkedAt,arrival:initial});
 const cleaned=JSON.parse(ssh(stagingInstallerCommand('cleanup',SOURCE,grant.installId,grant.build.buildRecordId),{input:JSON.stringify(request),timeout:180000}));
 const arrival=validateFinalCleanup(cleaned,{grant,installed,expectedLedger});save('owned-cleanup.json',cleaned);assert(cleanHead(root)===SOURCE);
 const final=checksum();save('final-source-arrival.json',{source:SOURCE,output:final,checkedAt:new Date().toISOString()});assert(final==='');
 save('accepted-forward-recovery.json',{kind:'EXPLICIT_FORWARD_RECOVERY_ACCEPTED',arrival,ownedResourceCleanupVerified:true,originalFailedAttemptRetained:true,productionDeployed:false,reportsSchedulingActivated:false});
 console.log(JSON.stringify({forwardRecoveryAccepted:true,arrival,ownedResourceCleanupVerified:true}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
