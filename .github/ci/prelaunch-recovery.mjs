/** Separately qualified parent operator. The original complete-unit verifier remains a clean independent checkout. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,lstatSync,realpathSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {recoverPrelaunch,validatePrelaunchRequest,PRELAUNCH_POLICY} from './prelaunch-recovery-policy.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:4*1024**2}).trim();
function privateFile(path,max=2*1024**2){const s=lstatSync(path);assert(realpathSync(path)===path&&s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&s.nlink===1&&(s.mode&0o777)===0o600&&s.size>0&&s.size<=max,'Private canonical bounded input required');return readFileSync(path);}
export function remotePrelaunchSource(serverBytes,policyBytes){
 const owner="const {PRELAUNCH_POLICY,validatePrelaunchRequest,validatePrelaunchObservation,validateNewAttempt}=await import('data:text/javascript;base64,"+Buffer.from(policyBytes).toString('base64')+"');";
 const original="import {PRELAUNCH_POLICY,validatePrelaunchRequest,validatePrelaunchObservation,validateNewAttempt} from './prelaunch-recovery-policy.mjs';";
 const text=serverBytes.toString();assert(text.split(original).length===2,'Exact server policy owner import required');
 return text.replace(original,owner)+"\nconst requestBytes=readFileSync(0);assert(requestBytes.length<=262144,'Bounded private request required');console.log(JSON.stringify(await runPrelaunchServer(JSON.parse(requestBytes))));\n";
}
export const remotePrelaunchCommand=(serverBytes,policyBytes)=>'cd /opt/ai-hr && /opt/node22/bin/node --import tsx --input-type=module -e '+quote(remotePrelaunchSource(serverBytes,policyBytes));
export async function prelaunchRecovery(config){
 assert(config&&Object.keys(config).sort().join(',')==='candidatePath,evidenceDirectory,failedEvidenceDirectory,failureLog,requestPath,verificationPath,verifierPath','Closed private operator configuration required');
 const request=validatePrelaunchRequest(JSON.parse(privateFile(config.requestPath)));
 const candidatePath=resolve(config.candidatePath),verifierPath=resolve(config.verifierPath);
 const load=async(root,file)=>{const v=await import(pathToFileURL(join(root,file)).href);return {...(v.default??{}),...v};};
 const canonical=await load(verifierPath,'.github/ci/release-ci.mjs');
 const operatorHead=canonical.cleanHead(ROOT);
 assert(git(ROOT,'branch','--show-current')==='codex/board-prelaunch-resume-20261119','Dedicated operator branch required');
 const frozen=()=>{assert(canonical.cleanHead(ROOT)===operatorHead&&canonical.cleanHead(candidatePath)===request.source&&canonical.cleanHead(verifierPath)===request.verifier,'Parent/operator/candidate/verifier changed');};frozen();
 assert(verifierPath!==ROOT&&candidatePath!==ROOT&&candidatePath!==verifierPath,'Independent canonical verifier and application checkout required');
 const api=p=>JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/'+p],{encoding:'utf8',timeout:60000,maxBuffer:4*1024**2}));
 const qualification=api('actions/runs/'+request.qualificationRunId);
 assert(qualification.head_sha===operatorHead&&qualification.head_branch===git(ROOT,'branch','--show-current')&&qualification.path==='.github/workflows/prelaunch-operator-development.yml'
  &&qualification.event==='push'&&qualification.run_attempt===1&&qualification.status==='completed'&&qualification.conclusion==='success'
  &&qualification.repository?.id===1333414856&&qualification.head_repository?.id===1333414856,'Actual successful exact parent-operator qualification required');
 const {installHash:hash,installJson:json,validateInstallGrant}=await load(verifierPath,'.github/ci/ci-install-grant.mjs');
 const evidence=JSON.parse(privateFile(config.verificationPath));
 assert(evidence.fingerprint===request.witnessFingerprint&&evidence.verificationController===request.verifier&&evidence.sha===request.source&&evidence.baseline===request.baseline,'Existing official witness differs');
 const oldGrantBytes=privateFile(join(config.failedEvidenceDirectory,'installation-grant.json')),oldGrant=validateInstallGrant(JSON.parse(oldGrantBytes),{allowExpired:true});
 const oldAckBytes=privateFile(join(config.failedEvidenceDirectory,'installation-initialized.json'));
 const oldAck=JSON.parse(oldAckBytes),preflightBytes=privateFile(join(config.failedEvidenceDirectory,'operator-preflight.json'));
 const preflight=JSON.parse(preflightBytes),failure=privateFile(config.failureLog,16*1024**2);
 assert(oldGrant.installId===request.oldInstallId&&hash(Buffer.from(json(oldGrant)+'\n'))===request.oldAuthorizationSha256&&oldAck.authorizationSha256===request.oldAuthorizationSha256&&oldAck.installId===request.oldInstallId&&oldAck.releaseAuthorized===false,'Actual failed initialized attempt differs');
 assert(hash(oldAckBytes)===request.oldAcknowledgementSha256&&hash(preflightBytes)===request.oldPreflightSha256&&hash(failure)===request.failureSha256&&preflight.fingerprint===request.witnessFingerprint&&preflight.execute===true,'Actual immutable failure/preflight bytes required');
 assert(failure.toString().includes('HTTP 502')&&failure.toString().includes('/artifacts?per_page=100&page=1'),'Only the observed prelaunch artifact transport failure is admitted');
 const originalProcess=join(verifierPath,'.github/ci/operator-release.mjs');
 const {stagingTransport}=await load(verifierPath,'.github/ci/staging-transport.mjs');
 const {readLease,guardCommand,leaseAssert}=await load(verifierPath,'scripts/staging/lease.mjs');
 const {revalidateUnitRecoveredCi}=await load(verifierPath,'.github/ci/unit-recovery.mjs');
 const {sourceChecksumDryRun,followStagingDeployment,requireSuccessfulBuild,completeVerifiedArrival}=await load(verifierPath,'.github/ci/operator-release.mjs');
 const {probeStagingProfile}=await load(verifierPath,'.github/ci/staging-preflight.mjs');
 const {verifyBaselineMigrationPreflight}=await load(verifierPath,'.github/ci/staging-migration-ledger.mjs');
 const {installationGrantFromVerifiedFiles}=await load(verifierPath,'.github/ci/staging-ci-promotion.mjs');
 const official=await load(candidatePath,'scripts/improve/release.ts'),{recordReleaseLearning}=await load(candidatePath,'scripts/improve/release-learning.ts');
 const lease=readLease(request.source),transport=stagingTransport(candidatePath);
 assert(isDeepStrictEqual({batch:lease.batch,epoch:lease.epoch},request.lease),'Actual sole held lease differs');
 const sshRaw=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:64*1024**2,...options});
 const ssh=(command,options={})=>sshRaw(guardCommand(lease,command),options);
 const server=remotePrelaunchCommand(readFileSync(join(ROOT,'.github/ci/prelaunch-recovery-server.mjs')),readFileSync(join(ROOT,'.github/ci/prelaunch-recovery-policy.mjs')));
 const remote=(mode,extra={})=>JSON.parse(ssh(server,{input:json({request,mode,...extra})+'\n',timeout:mode==='observe'?660000:180000}));
 mkdirSync(config.evidenceDirectory,{mode:0o700});
 const save=(name,value)=>writeFileSync(join(config.evidenceDirectory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 save('prelaunch-request.json',request);save('parent-qualification.json',qualification);
 const assertLease=()=>{const v=leaseAssert(lease,sshRaw);assert(v.phase==='installing','Same installing lease required');};
 const localFailure=()=>{
  for(const name of ['launch.json','remote-build-result.json','installed-arrival.json']){try{lstatSync(join(config.failedEvidenceDirectory,name));throw Error('Original operator advanced past prelaunch');}catch(e){if(e.code!=='ENOENT')throw e;}}
  const processes=execFileSync('ps',['-ww','-axo','args='],{encoding:'utf8',timeout:10000,maxBuffer:4*1024**2});
  assert(!processes.split('\n').some(line=>line.includes(originalProcess)&&line.includes('deploy-unit-recovery')),'Original operator is still running');assertLease();
 };
 let before;
 const cheapFence=async b=>{frozen();assertLease();assert(sourceChecksumDryRun(official,transport,candidatePath)==='','Actual already transferred candidate source differs');await probeStagingProfile({candidatePath,baseline:request.baseline,announced:true,ssh});assert(remote('fence',{before:b}).unchanged===true);};
 const result=await recoverPrelaunch({request,oldGrant,ports:{
  frozen,proveLocalFailure:localFailure,
  observe:async()=>{assert(sourceChecksumDryRun(official,transport,candidatePath)==='','Transferred source differs');await probeStagingProfile({candidatePath,baseline:request.baseline,announced:true,ssh});const v=remote('observe');before=v;save('original-native-prelaunch-proof.json',v);return v;},
  reauthenticate:async()=>{await revalidateUnitRecoveredCi(evidence);const ledger=verifyBaselineMigrationPreflight({candidatePath,baseline:request.baseline,ssh});save('fresh-original-ledger.json',ledger);save('canonical-reauthentication.json',{policy:PRELAUNCH_POLICY,operatorHead,verifier:request.verifier,witnessFingerprint:evidence.fingerprint,at:new Date().toISOString(),oldGrantNotRevoked:true});return evidence;},
  cheapFence,
  newGrant:async()=>{const grant=installationGrantFromVerifiedFiles({evidence,run:JSON.parse(readFileSync(join(evidence.evidenceDirectory,'run.json'))),jobs:JSON.parse(readFileSync(join(evidence.evidenceDirectory,'jobs.json'))),baselineBuildId:oldGrant.baselineBuildId,environmentSha256:before.environmentSha256});save('installation-grant.json',grant);return grant;},
  linkAndCopy:async({grant,before:b})=>{const v=remote('copy',{grant,before:b,operator:{revision:operatorHead,qualificationRunId:request.qualificationRunId,verifier:request.verifier}});save('installation-linked.json',v);save('installation-initialized.json',v.acknowledgement);return v;},
  reserveAndLaunch:async({grant,before:b})=>{const v=remote('launch',{grant,before:b});save('launch.json',v);return v;},
  arrive:async({grant})=>{const status=followStagingDeployment(official,ssh);save('remote-build-result.json',status);requireSuccessfulBuild(official,status,request.source);assert(status.built_build_id===grant.build.nextBuildId,'Actual installed build differs');const arrival=await completeVerifiedArrival({official,ssh,sshRaw,lease,transport,candidatePath,evidence,grant,status,baseline:request.baseline,save,frozen,recordReleaseLearning});return {policy:PRELAUNCH_POLICY,operatorRevision:operatorHead,originalInstallId:request.oldInstallId,installId:grant.installId,source:request.source,witnessFingerprint:evidence.fingerprint,...arrival};}
 }});save('prelaunch-recovery-result.json',result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert(process.argv.length===3,'Usage: node --import tsx prelaunch-recovery.mjs PRIVATE_CONFIG_JSON');
 try{console.log(JSON.stringify(await prelaunchRecovery(JSON.parse(privateFile(resolve(process.argv[2]))))));}
 catch(error){console.error('Prelaunch recovery stopped; retain lease and reconcile durable link/reservation before any new action. '+String(error?.message??error).replace(/[a-f0-9]{64}/g,'<digest>'));process.exitCode=1;}
}
