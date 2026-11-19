/** Qualified operator-only bridge. Original evidence is immutable; canonical arrival owns every mutation. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,lstatSync,realpathSync,mkdirSync,mkdtempSync,existsSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {redactLeaseError} from '../../scripts/staging/lease.mjs';
export const POLICY='aihr-prelaunch-arrival-resume/v1';
export const BRANCH='codex/board-prelaunch-arrival-resume-20261119';
const MODULES=['format','installer_v2','fences_v1','ci_runtime_v1','operation_guard_v1','upgrade_v1','prepared_v1','published_v1','unstarted_v1'].map(n=>'deploy/systemd/bank_import_worker_'+n+'.py');
export const FILES=['prelaunch-request.json','parent-qualification.json','canonical-reauthentication.json','original-native-prelaunch-proof.json','fresh-original-ledger.json','installation-grant.json','installation-initialized.json','installation-linked.json','launch.json','remote-build-result.json'];
const hash=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(v,k)=>same(Object.keys(v??{}).sort(),k.slice().sort(),'Closed request/descriptor required');
const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',timeout:60000,maxBuffer:4*1024**2}).trim();
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
function privateDirectory(path){assert(isAbsolute(path)&&resolve(path)===realpathSync(path),'Canonical absolute directory required');const s=lstatSync(path);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077),'Private operator-owned directory required');return path;}
function privateBytes(path,limit=16*1024**2){assert(isAbsolute(path)&&resolve(path)===realpathSync(path),'Canonical absolute file required');const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&s.nlink===1&&!(s.mode&0o077)&&s.size>0&&s.size<=limit,'Bounded private owned regular file required');return readFileSync(path);}
function descriptor(d){keys(d,['path','sha256']);assert(digest(d.sha256));const b=privateBytes(d.path);assert(hash(b)===d.sha256,'Immutable evidence bytes changed');return {value:JSON.parse(b),bytes:b,path:d.path,sha256:d.sha256};}
export function validateConfiguration(c){
 keys(c,['format','policy','candidatePath','canonicalPath','prelaunchPath','prelaunchEvidenceDirectory','outputDirectory','canonicalRevision','prelaunchRevision','qualificationRunId','verification','oldPreflight','oldGrant','oldAcknowledgement','fileHashes','worker']);
 assert(c.format===1&&c.policy===POLICY&&sha(c.canonicalRevision)&&sha(c.prelaunchRevision)&&Number.isSafeInteger(c.qualificationRunId)&&c.qualificationRunId>0,'Versioned qualified wrapper required');keys(c.fileHashes,FILES);assert(Object.values(c.fileHashes).every(digest),'Every actual prelaunch record needs an independent hash');
 keys(c.worker,['receipt','approval','helper','assembly','helperRevision','qualificationRunId']);assert(sha(c.worker.helperRevision)&&Number.isSafeInteger(c.worker.qualificationRunId)&&c.worker.qualificationRunId>0,'Qualified native recovery helper required');return c;
}
export function qualified(run,{id,head,branch,path}){assert(run?.id===id&&run.head_sha===head&&run.head_branch===branch&&run.path===path&&run.event==='push'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success'&&run.repository?.id===1333414856&&run.head_repository?.id===1333414856,'Exact successful qualified code revision required');return run;}
/** Pure bridge: each compatibility field names its factual immutable source. No original file is rewritten. */
export function canonicalEvidenceView({c,records,verification,oldPreflight,oldGrant,oldAcknowledgement,owners,target,provenance}){
 const r=owners.validatePrelaunchRequest(records['prelaunch-request.json']),g=owners.validateInstallGrant(records['installation-grant.json'],{allowExpired:true});
 const auth=g=>owners.installHash(Buffer.from(owners.installJson(g)+'\n'));
 assert(r.verifier===c.canonicalRevision&&verification.verificationController===r.verifier&&verification.sha===r.source&&verification.baseline===r.baseline&&verification.fingerprint===r.witnessFingerprint&&verification.result==='PASS','Original canonical CI witness changed');
 owners.validateInstallGrant(oldGrant,{allowExpired:true});owners.validateNewAttempt(g,oldGrant,r);owners.validatePrelaunchObservation(records['original-native-prelaunch-proof.json'],r);
 assert(auth(oldGrant)===r.oldAuthorizationSha256&&oldGrant.installId===r.oldInstallId&&oldAcknowledgement.installId===r.oldInstallId&&oldAcknowledgement.authorizationSha256===r.oldAuthorizationSha256,'Actual original initialized attempt changed');
 assert(c.oldPreflight.sha256===r.oldPreflightSha256&&c.oldAcknowledgement.sha256===r.oldAcknowledgementSha256,'Original preflight/acknowledgement hash binding changed');
 assert(oldPreflight.execute===true&&oldPreflight.sha===r.source&&oldPreflight.fingerprint===r.witnessFingerprint&&oldPreflight.verificationController===r.verifier,'Original executed preflight changed');same(oldPreflight.target,target,'Staging target differs');
 const q=records['parent-qualification.json'];qualified(q,{id:r.qualificationRunId,head:c.prelaunchRevision,branch:'codex/board-prelaunch-resume-20261119',path:'.github/workflows/prelaunch-operator-development.yml'});
 const reauth=records['canonical-reauthentication.json'];assert(Number.isFinite(Date.parse(reauth.at))&&Date.parse(reauth.at)<=Date.parse(g.issuedAt),'Actual reauthentication must precede fresh installation authority');
 assert(reauth.policy===r.policy&&reauth.operatorHead===c.prelaunchRevision&&reauth.verifier===r.verifier&&reauth.witnessFingerprint===r.witnessFingerprint&&reauth.oldGrantNotRevoked===true,'Actual canonical prelaunch reauthentication changed');
 const linked=records['installation-linked.json'],initialized=records['installation-initialized.json'],launch=records['launch.json'];
 assert(linked.policy===r.policy&&linked.oldInstallId===r.oldInstallId&&linked.installId===g.installId&&linked.copyVerified===true&&linked.releaseAuthorized===false&&digest(linked.linkSha256),'Actual durable copy/link required');same(linked.acknowledgement,initialized,'Copy acknowledgement changed');
 assert(initialized.installId===g.installId&&initialized.authorizationSha256===auth(g)&&initialized.releaseAuthorized===false,'Actual new installation acknowledgement required');
 assert(launch.policy===r.policy&&launch.oldInstallId===r.oldInstallId&&launch.installId===g.installId&&launch.launchReserved===true&&launch.releaseAuthorized===false,'Actual one-time reserved launch required');
 const match=/^aihr-deploy-log=(\/var\/tmp\/aihr-deploy\/deploy-[A-Za-z0-9_-]+\.log)\n$/.exec(launch.output);assert(match,'Exact actual canonical launch output required');
 const remote=records['remote-build-result.json'];owners.admitInterruptedDeployRecord(remote,{grant:g,candidate:r.source});assert(remote.log===match[1],'Genuine terminal deployment is not the actually launched log');
 const view={directory:c.prelaunchEvidenceDirectory,preflight:{...verification,execute:true,target,evidenceDirectory:c.prelaunchEvidenceDirectory,canonicalView:{policy:POLICY,notOriginalRecord:true,provenance}},grant:g,initialized,launch:{installId:launch.installId,testingBuildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,canonicalView:{policy:POLICY,notOriginalRecord:true,provenance}},remoteBuild:remote};
 owners.admitRetainedEvidence({evidence:view,candidate:r.source,controller:r.verifier,runId:g.runId,target});return {view,request:r,grant:g,provenance};
}
export function workerReceiptReady({receipt,approval,approvalBytes,helperBytes,assembly,grant,owners,lease}){
 const auth=owners.installHash(Buffer.from(owners.installJson(grant)+'\n'));
 assert(hash(helperBytes)===approval.helperSha256&&assembly.helperSha256===approval.helperSha256&&assembly.bytes===helperBytes.length&&assembly.releaseAuthorized===false&&Object.keys(assembly.sourceFiles??{}).length===9,'Actual independently assembled nine-module helper required');
 same(Object.keys(assembly.sourceFiles).sort(),MODULES.slice().sort(),'Exact native module graph required');
 same(approval.lease,{...lease,candidate:grant.source},'Actual root approval belongs to another lease');assert(approval.identity?.source===grant.source&&approval.install?.id===grant.installId&&approval.install?.buildRecordId===grant.build.buildRecordId,'Actual root approval belongs to another native installation');
 assert(receipt.mode==='recover-unstarted-ci-runtime'&&receipt.policy==='aihr-worker-unstarted-recovery/v1'&&receipt.unstartedRecoveryPolicy==='aihr-worker-unstarted-recovery/v1'&&receipt.workerRecoveryOnly===true,'Only actual strict unstarted worker recovery success required');
 assert(receipt.source===grant.source&&receipt.webBuildId===grant.build.nextBuildId&&receipt.installId===grant.installId&&receipt.installationAuthorizationSha256===auth&&receipt.authorizationSha256===hash(approvalBytes),'Actual worker receipt does not bind this installation/approval');
 assert(receipt.serviceStable===true&&receipt.journeyVerified===false&&receipt.nativeRuntimeVerified===true&&receipt.fullSourceContentInventoryVerified===true&&receipt.fullNativeAudits===2&&receipt.completeMetadataFences===10&&!receipt.error&&!receipt.failure,'Complete actual successful native graph required');same(receipt.transitionStages,Array(10).fill('F'),'Only genuine failed-stage graph required');same(receipt.leasePhases,Array(10).fill('installing'),'Installing lease throughout native graph required');return receipt;
}
export function sshCommand(args,options,run=execFileSync){try{return run('ssh',args,options);}catch(error){throw redactLeaseError(error);}}
export async function runArrivalResume(c,options={}){try{return await leasedArrivalResume(c,options);}catch(error){throw redactLeaseError(error);}}
async function leasedArrivalResume(c,{execute=false}={}){
 validateConfiguration(c);for(const p of [c.candidatePath,c.canonicalPath,c.prelaunchPath])assert(isAbsolute(p)&&resolve(p)===realpathSync(p),'Exact canonical checkout path required');privateDirectory(c.prelaunchEvidenceDirectory);
 const load=async(root,file)=>{const m=await import(pathToFileURL(join(root,file)).href);return {...(m.default??{}),...m};};
 const ci=await load(c.canonicalPath,'.github/ci/release-ci.mjs'),operatorHead=ci.cleanHead(ROOT);assert(git(ROOT,'branch','--show-current')===BRANCH,'Dedicated arrival operator branch required');
 const frozen=()=>{assert(ci.cleanHead(ROOT)===operatorHead&&ci.cleanHead(c.canonicalPath)===c.canonicalRevision&&ci.cleanHead(c.prelaunchPath)===c.prelaunchRevision,'Wrapper/canonical/parent source changed');};frozen();
 const api=p=>JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/'+p],{encoding:'utf8',timeout:60000,maxBuffer:4*1024**2}));
 const wrapperQualification=qualified(api('actions/runs/'+c.qualificationRunId),{id:c.qualificationRunId,head:operatorHead,branch:BRANCH,path:'.github/workflows/prelaunch-arrival-development.yml'});
 const verification=descriptor(c.verification),oldPreflight=descriptor(c.oldPreflight),oldGrant=descriptor(c.oldGrant),oldAck=descriptor(c.oldAcknowledgement),records={},provenance={policy:POLICY,verification:c.verification,oldPreflight:c.oldPreflight,oldGrant:c.oldGrant,oldAcknowledgement:c.oldAcknowledgement,prelaunchFiles:{}};
 for(const name of FILES){const d=descriptor({path:join(c.prelaunchEvidenceDirectory,name),sha256:c.fileHashes[name]});records[name]=d.value;provenance.prelaunchFiles[name]={path:d.path,sha256:d.sha256};}
 const request=records['prelaunch-request.json'];assert(ci.cleanHead(c.candidatePath)===request.source,'Frozen application source changed');
 const parentRun=qualified(api('actions/runs/'+request.qualificationRunId),{id:request.qualificationRunId,head:c.prelaunchRevision,branch:'codex/board-prelaunch-resume-20261119',path:'.github/workflows/prelaunch-operator-development.yml'});assert(parentRun.id===records['parent-qualification.json'].id,'Retained parent qualification differs');
 const grantOwner=await load(c.canonicalPath,'.github/ci/ci-install-grant.mjs'),resume=await load(c.canonicalPath,'.github/ci/resume-arrival.mjs'),parent=await load(c.prelaunchPath,'.github/ci/prelaunch-recovery-policy.mjs'),transportOwner=await load(c.canonicalPath,'.github/ci/staging-transport.mjs');
 const owners={...grantOwner,...resume,...parent},admitted=canonicalEvidenceView({c,records,verification:verification.value,oldPreflight:oldPreflight.value,oldGrant:oldGrant.value,oldAcknowledgement:oldAck.value,owners,target:transportOwner.STAGING,provenance});
 for(const name of resume.RESUME_REFUSING_EVIDENCE)assert(!existsSync(join(c.prelaunchEvidenceDirectory,name)),'Original installation already records arrival: '+name);
 keys(c.worker.helper,['path','sha256']);
 const receipt=descriptor(c.worker.receipt),approval=descriptor(c.worker.approval),helper=privateBytes(c.worker.helper.path,1024**2),assembly=descriptor(c.worker.assembly);assert(hash(helper)===c.worker.helper.sha256,'Qualified native helper bytes changed');
 qualified(api('actions/runs/'+c.worker.qualificationRunId),{id:c.worker.qualificationRunId,head:c.worker.helperRevision,branch:'codex/board-worker-prepared-unstarted-recovery-20261119',path:'.github/workflows/worker-prepared-development.yml'});
 for(const [path,expected]of Object.entries(assembly.value.sourceFiles)){assert(/^deploy\/systemd\/bank_import_worker_[a-z0-9_]+\.py$/.test(path)&&digest(expected),'Closed native source module path required');const bytes=execFileSync('git',['show',c.worker.helperRevision+':'+path],{cwd:ROOT,maxBuffer:1024**2});assert(hash(bytes)===expected,'Qualified native module bytes changed');}
 workerReceiptReady({receipt:receipt.value,approval:approval.value,approvalBytes:approval.bytes,helperBytes:helper,assembly:assembly.value,grant:admitted.grant,owners,lease:request.lease});
 transportOwner.bindStaging(process.env);const leaseOwner=await load(c.canonicalPath,'scripts/staging/lease.mjs'),lease=leaseOwner.readLease(request.source);same({batch:lease.batch,epoch:lease.epoch},request.lease,'Actual held installing lease differs');
 const official=await load(c.candidatePath,'scripts/improve/release.ts'),learning=await load(c.candidatePath,'scripts/improve/release-learning.ts'),arrival=await load(c.canonicalPath,'.github/ci/operator-release.mjs'),ledger=await load(c.canonicalPath,'.github/ci/staging-migration-ledger.mjs');
 const transport=transportOwner.stagingTransport(c.candidatePath),sshRaw=(cmd,o={})=>sshCommand(transport.sshArgs(cmd),{encoding:'utf8',timeout:30000,maxBuffer:64*1024**2,...o}),ssh=(cmd,o={})=>sshRaw(leaseOwner.guardCommand(lease,cmd),o);
 try{mkdirSync(c.outputDirectory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}privateDirectory(c.outputDirectory);const attemptDirectory=mkdtempSync(join(c.outputDirectory,execute?'execute-':'verify-'));const save=(n,v)=>writeFileSync(join(attemptDirectory,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
 save('canonical-view-provenance.json',{policy:POLICY,wrapperRevision:operatorHead,wrapperQualificationRunId:wrapperQualification.id,canonicalVerifier:c.canonicalRevision,originalEvidenceDirectory:verification.value.evidenceDirectory,actualPrelaunchDirectory:c.prelaunchEvidenceDirectory,workerReceipt:c.worker.receipt,workerApproval:c.worker.approval,provenance,originalFilesUnchanged:true,releaseAuthorized:false});
 const retained=[c.verification,c.oldPreflight,c.oldGrant,c.oldAcknowledgement,c.worker.receipt,c.worker.approval,c.worker.helper,c.worker.assembly];
 const frozenAll=()=>{frozen();for(const d of retained)assert(hash(privateBytes(d.path))===d.sha256,'Retained authority/worker proof changed');assert(ci.cleanHead(c.candidatePath)===request.source,'Application source changed');for(const [n,d]of Object.entries(provenance.prelaunchFiles))assert(hash(privateBytes(d.path))===d.sha256,'Original prelaunch record changed: '+n);};
 return resume.resumeArrival({execute,candidate:request.source,controller:c.canonicalRevision,runId:admitted.grant.runId,target:transportOwner.STAGING,evidence:admitted.view,expectedLedger:ledger.expectedMigrationLedger(c.candidatePath),lease,save,frozen:frozenAll,ports:{
  leaseAssert:()=>leaseOwner.leaseAssert(lease,sshRaw),follow:()=>resume.splitDeployFollow(ssh(official.buildFollowCommand(0),{encoding:null,timeout:120000,maxBuffer:256*1024**2}),{sentinel:official.DEPLOY_STATE_SENTINEL,parse:official.parseDeployStatus}),status:()=>official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status')),
  worker:()=>ssh(resume.IMPORT_WORKER_CHECK_COMMAND,{timeout:120000}),service:()=>ssh(resume.SERVICE_HEALTH_COMMAND),checksum:()=>arrival.sourceChecksumDryRun(official,transport,c.candidatePath),installer:()=>readFileSync(join(c.candidatePath,'.github/ci/staging-build-install.mjs'),'utf8'),ledger:()=>JSON.parse(ssh(ledger.stagingLedgerProbeCommand(),{input:ledger.LEDGER_QUERY,timeout:20000,maxBuffer:4*1024**2})),finish:()=>ssh(resume.DEPLOY_FINISH_COMMAND,{timeout:60000}),requireBuilt:status=>arrival.requireSuccessfulBuild(official,status,request.source),
  arrive:status=>arrival.completeVerifiedArrival({official,ssh,sshRaw,lease,transport,candidatePath:c.candidatePath,evidence:verification.value,grant:admitted.grant,status,baseline:admitted.grant.baseline,save,frozen:frozenAll,recordReleaseLearning:learning.recordReleaseLearning,installerStatusMode:'resume-status',ownedCleanup:false}),
 }});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,path]=process.argv.slice(2);assert(['verify','execute'].includes(mode)&&path&&process.argv.length===4,'Usage: prelaunch-arrival-resume.mjs <verify|execute> <private-request.json>');
 runArrivalResume(JSON.parse(privateBytes(path)),{execute:mode==='execute'}).then(v=>console.log(JSON.stringify(v,null,2))).catch(e=>{console.error(redactLeaseError(e).message);process.exitCode=1;});
}
