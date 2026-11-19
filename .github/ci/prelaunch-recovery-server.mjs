/** SSH-owner-only prelaunch operations. Executed under the existing queue SH guard; no global EX nesting.
 * The old installation is never written. O_EXCL records serialize this route, not arbitrary privileged SSH.
 */
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync,existsSync,mkdirSync,writeFileSync,copyFileSync,constants,chmodSync,fsyncSync,openSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {PRELAUNCH_POLICY,validatePrelaunchRequest,validatePrelaunchObservation,validateNewAttempt} from './prelaunch-recovery-policy.mjs';
const ROOT='/opt/ai-hr',STATE='/var/tmp/aihr-deploy';
const members=['build-provenance.json','successful-build.json','system-testing.json','bytes/build-bundle-files.json','bytes/build-bundle.tar.gz'];
function regularMetadata(path,max=16*1024**2,owned=false){
 const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size>0&&s.size<=max,'Bounded real file required');
 if(owned)assert(s.uid===process.getuid()&&(s.mode&0o777)===0o600,'Private owner0600 file required');
 return s;
}
function regular(path,max=16*1024**2,owned=false){regularMetadata(path,max,owned);return readFileSync(path);}
function directory(path,create=false){
 if(create&&!existsSync(path))mkdirSync(path,{mode:0o700});const s=lstatSync(path);
 assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(path)===path&&s.uid===process.getuid()&&(s.mode&0o777)===0o700,'Private owner0700 directory required');return path;
}
/** Durable publication precedes any new installation or launch; a partial/lost result never permits a retry. */
export function exclusiveRecord(path,bytes){
 const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(join(path,'..'),constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
}
export function reserveLaunchOnce(path,bytes,launch){exclusiveRecord(path,bytes);return launch();}
export function copyRetainedPacket(from,to){
 directory(from);directory(to);directory(join(to,'bytes'),true);
 for(const member of members){regularMetadata(join(from,member),member.endsWith('.gz')?3*1024**3:16*1024**2,true);copyFileSync(join(from,member),join(to,member),constants.COPYFILE_EXCL);chmodSync(join(to,member),0o600);}
}
export async function runPrelaunchServer(input){
 const {request:r,mode}=input;validatePrelaunchRequest(r);
 assert(['observe','fence','copy','launch'].includes(mode),'Closed server operation required');
 assert(Object.keys(input).sort().join(',')===(mode==='observe'?'mode,request':mode==='fence'?'before,mode,request':mode==='copy'?'before,grant,mode,operator,request':'before,grant,mode,request'),'Closed server envelope required');
 assert(process.platform==='linux'&&realpathSync(ROOT)===ROOT&&process.cwd()===ROOT,'Existing Linux staging root required');
 assert(process.env.AIHR_STAGING_CANDIDATE===r.source&&process.env.AIHR_STAGING_BATCH===r.lease.batch&&Number(process.env.AIHR_STAGING_EPOCH)===r.lease.epoch,'Actual queue guard identity required');
 execFileSync('python3',[STATE+'/staging-release-queue/coordinator.py','assert-env'],{stdio:['ignore','ignore','inherit'],timeout:10000});
 const load=async name=>import(pathToFileURL(join(ROOT,'.github/ci',name+'.mjs')).href);
 const {installHash:hash,installJson:json,validateInstallGrant}=await load('ci-install-grant');
 const {readPrivateInstall,initializePrivateInstall}=await load('staging-build-install');
 const {inspectCiBuildPacket}=await load('build-artifact');
 const {cleanupTreeFence}=await load('normal-cleanup-fences');
 const {fingerprintStagingEnvironment}=await load('staging-environment');
 const old=readPrivateInstall(r.oldInstallId,{allowExpired:true}),baseline=readPrivateInstall(r.baselineInstallId,{allowExpired:true});
 assert(old.authorizationSha256===r.oldAuthorizationSha256&&baseline.authorizationSha256===r.baselineAuthorizationSha256,'Independently pinned original authorizations required');
 assert(old.grant.source===r.source&&old.grant.baseline===r.baseline&&old.grant.witnessFingerprint===r.witnessFingerprint
  &&baseline.grant.source===r.baseline&&baseline.grant.build.nextBuildId===old.grant.baselineBuildId,'Original baseline/build/witness chain differs');
 const parent=join(realpathSync(homedir()),'.aihr-prelaunch-recoveries');
 // Read-only observation does not create this directory.
 if(existsSync(parent))directory(parent);
 const linkPath=join(parent,r.oldInstallId+'.json'),reservation=join(parent,r.oldInstallId+'.launch.json');
 const encode=value=>Buffer.from(json(value)+'\n');
 const readLink=()=>JSON.parse(regular(linkPath,128*1024,true));
 const expectedPacket=g=>({candidate:g.source,controller:g.controller,runId:g.runId,controllerBranch:g.controllerBranch,producerStartedAt:g.producerStartedAt,producerCompletedAt:g.producerCompletedAt});
 const packetProof=p=>{const v=inspectCiBuildPacket(p.packet,expectedPacket(p.grant));for(const key of Object.keys(p.grant.build))assert(isDeepStrictEqual(v[key],p.grant.build[key]),'Original packet/build differs: '+key);return v;};
 const noLaunch=()=>{
  assert(!existsSync(reservation),'Launch was already reserved; inspect, never resend');
  for(const name of ['next','verified.json','activated.json','activate-intent.json','activate-result.json','runtime.json','cleanup-authorized.json'])assert(!existsSync(join(old.directory,name)),'Original attempt has native state; prelaunch recovery refused');
  const processes=execFileSync('ps',['-eo','args='],{encoding:'utf8',timeout:5000,maxBuffer:4*1024**2});
  assert(!processes.split('\n').some(v=>/(?:^|\s)(?:\.\/|\/opt\/ai-hr\/)deploy\/deploy\.sh(?:\s|$)/.test(v)),'Native deploy process exists');
  const current=regular(join(STATE,'current'),128*1024),last=regular(join(STATE,'last-ok'),128*1024),pending=regular(join(STATE,'pending'),4096).toString();
  assert(hash(current)===r.currentSha256&&hash(last)===r.lastOkSha256&&pending.split('\n').filter(v=>v.startsWith('ref=')).join('')==='ref='+r.source,'Original deployment records/source pending changed');
  assert(readFileSync(join(ROOT,'.next/BUILD_ID'),'utf8').trim()===old.grant.baselineBuildId,'Live compiled baseline changed');
 };
 const compiledFence=()=>cleanupTreeFence(join(ROOT,'.next'),p=>p==='cache');
 const environment=()=>fingerprintStagingEnvironment(ROOT);
 noLaunch();
 if(mode==='observe'){
  assert(!existsSync(linkPath),'Original attempt already linked; no second new UUID');
  const packet=packetProof(old),manifest=join(baseline.packet,'bytes/build-bundle-files.json');
  assert(hash(regular(manifest))===baseline.grant.build.manifestSha256,'Original baseline manifest differs');
  const owner=join(ROOT,'.github/ci/build-bundle.py');assert(hash(regular(owner,1024**2))===r.bundleOwnerSha256,'Canonical compiled-byte owner differs');
  const before=compiledFence();
  const output=JSON.parse(execFileSync('python3',[owner,'verify-active-directory',join(ROOT,'.next'),manifest,ROOT,baseline.grant.build.buildSourcePath],{encoding:'utf8',timeout:600000,maxBuffer:1024**2}));
  assert(output.runtimeCacheExcluded===true,'Canonical compiled-byte verification did not complete');
  const after=compiledFence();assert(before===after,'Baseline metadata changed during full byte proof');noLaunch();
  return validatePrelaunchObservation({policy:PRELAUNCH_POLICY,source:r.source,baseline:r.baseline,oldInstallId:r.oldInstallId,oldAuthorizationSha256:old.authorizationSha256,baselineAuthorizationSha256:baseline.authorizationSha256,currentSha256:r.currentSha256,lastOkSha256:r.lastOkSha256,lease:r.lease,
   noNativeBegin:true,noNativeProcess:true,oldUnlaunched:true,oldGrantNotRevoked:true,pending:r.source,compiledMetadataSha256:after,compiledBytesVerified:true,baselineManifestSha256:baseline.grant.build.manifestSha256,packetSha256:hash(json(packet)),environmentSha256:environment(),releaseAuthorized:false},r);
 }
 validatePrelaunchObservation(input.before,r);assert(compiledFence()===input.before.compiledMetadataSha256&&environment()===input.before.environmentSha256,'Native compiled/environment fence changed');
 assert(input.before.environmentSha256===old.grant.environmentSha256,'Original grant environment changed');
 if(mode==='fence')return {unchanged:true};
 const grant=validateInstallGrant(input.grant);validateNewAttempt(grant,old.grant,r);
 if(mode==='copy'){
  assert(input.operator&&Object.keys(input.operator).sort().join(',')==='qualificationRunId,revision,verifier'&&/^[a-f0-9]{40}$/.test(input.operator.revision)&&input.operator.qualificationRunId===r.qualificationRunId&&input.operator.verifier===r.verifier,'Separately qualified parent operator identity required');
  assert(!existsSync(linkPath),'Original attempt already has its sole new identity');directory(parent,true);
  const packet=packetProof(old);assert(hash(json(packet))===input.before.packetSha256,'Old packet changed after observation');
  // Claim the ONE new identity before side effects. Failure after this point requires inspection, not automatic retry.
  const link={policy:PRELAUNCH_POLICY,request:r,before:input.before,grant,operator:input.operator,oldGrantNotRevoked:true,releaseAuthorized:false};
  exclusiveRecord(linkPath,encode(link));
  const ack=initializePrivateInstall(grant);copyRetainedPacket(old.packet,ack.packetDirectory);
  const copied=readPrivateInstall(grant.installId);const fresh=packetProof(copied);
  assert(isDeepStrictEqual({...fresh,packetDirectory:old.packet},packet),'Copied packet bytes differ');
  const result={policy:PRELAUNCH_POLICY,oldInstallId:r.oldInstallId,installId:grant.installId,acknowledgement:ack,linkSha256:hash(regular(linkPath,128*1024,true)),copyVerified:true,releaseAuthorized:false};
  exclusiveRecord(join(parent,r.oldInstallId+'.copied.json'),encode(result));return result;
 }
 const link=readLink();assert(isDeepStrictEqual(link.request,r)&&isDeepStrictEqual(link.before,input.before)&&isDeepStrictEqual(link.grant,grant),'Durable one-attempt link changed');
 const copied=JSON.parse(regular(join(parent,r.oldInstallId+'.copied.json'),32*1024,true));
 assert(copied.installId===grant.installId&&copied.copyVerified===true&&copied.linkSha256===hash(regular(linkPath,128*1024,true)),'Authenticated copy acknowledgement missing');
 // O_EXCL reservation is intentionally never removed, including when the launcher/SSH reply fails.
 const raw=await import(pathToFileURL(join(ROOT,'scripts/improve/release.ts')).href),official={...(raw.default??{}),...raw};
 const command=official.buildLaunchCommand(grant.source,ROOT,STATE,grant.build.buildRecordId,grant.installId);
 assert(command.split('--ci-build='+grant.installId).length===2&&command.split('--testing-build-record='+grant.build.buildRecordId).length===2,'Actual candidate canonical launch owner required');
 const output=reserveLaunchOnce(reservation,encode({policy:PRELAUNCH_POLICY,oldInstallId:r.oldInstallId,installId:grant.installId,linkSha256:copied.linkSha256,at:new Date().toISOString(),releaseAuthorized:false}),()=>execFileSync('bash',['-c',command],{encoding:'utf8',timeout:30000,maxBuffer:1024**2}));
 const result={policy:PRELAUNCH_POLICY,installId:grant.installId,oldInstallId:r.oldInstallId,launchReserved:true,output,releaseAuthorized:false};
 exclusiveRecord(join(parent,r.oldInstallId+'.launched.json'),encode(result));return result;
}
