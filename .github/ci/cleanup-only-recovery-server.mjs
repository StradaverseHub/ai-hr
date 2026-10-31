/** Staging server: fresh cleanup-only authority; historical installation grant is immutable metadata. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,existsSync,mkdirSync,realpathSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {SELECTION,digest,historicalInstallMetadata,validateCleanupCertificate,finishCleanupCli} from './cleanup-only-recovery-policy.mjs';
import {runCleanupOnlySession} from './cleanup-only-recovery-session.mjs';
import {createCleanupReadonlyRuntime} from './cleanup-only-recovery-runtime.mjs';
import {toolDigest,privateBytes} from './cleanup-only-recovery-admission.mjs';
export function verifyPriorDiagnostics(directory,inventory,newAttempt){
 assert(Array.isArray(inventory)&&inventory.length>0&&inventory.length<=256,'All prior failed attempt diagnostics require independent reconciliation');
 const diagnosticPaths=new Set(inventory.map(v=>v.path));assert(diagnosticPaths.size===inventory.length,'Unique complete prior attempt inventory required');
 const roots=readdirSync(directory).filter(name=>(name==='normal-cleanup-ready.json'||/^(?:ready-recovery-e12-|cleanup-only-v1-)/.test(name))&&name!==newAttempt);
 assert(roots.length>0,'Actual previous failed attempt root required');
 for(const name of roots){const s=lstatSync(join(directory,name));assert(!s.isSymbolicLink()&&diagnosticPaths.has(name),'Every prior failed attempt root must be inventoried');assert(name==='normal-cleanup-ready.json'?s.isFile():s.isDirectory(),'Actual prior diagnostic root shape differs');}
 for(const wanted of inventory){
  assert(typeof wanted.path==='string'&&/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/.test(wanted.path)&&!wanted.path.split('/').some(v=>v==='.'||v==='..')&&wanted.path!==newAttempt&&roots.includes(wanted.path.split('/')[0]),'Bounded actual prior diagnostic path required');
  const path=join(directory,wanted.path),s=lstatSync(path);assert(!s.isSymbolicLink()&&s.uid===process.getuid()&&s.ino===wanted.inode&&s.dev===wanted.device,'Prior diagnostic identity changed');
  if(wanted.kind==='directory'){assert(s.isDirectory()&&(s.mode&0o777)===0o700);for(const child of readdirSync(path))assert(diagnosticPaths.has(wanted.path+'/'+child),'Prior diagnostic directory contents changed');}
  else{assert(wanted.kind==='file');const bytes=privateBytes(path);assert(bytes.length===wanted.bytes&&digest(bytes)===wanted.sha256,'Prior failed diagnostic bytes changed');}
 }
}
export async function serve({mode,source,controller,reconciliationPath,reconciliationSha256,attemptName,certificatePath}){
 assert(['inspect','cleanup'].includes(mode)&&source==='/opt/ai-hr'&&realpathSync(source)===source&&process.cwd()===source&&process.platform==='linux','Canonical staging server only');
 assert(/^[a-f0-9]{40}$/.test(controller)&&/^[a-f0-9]{64}$/.test(reconciliationSha256)&&/^cleanup-only-v1-[a-z0-9_-]{3,60}$/.test(attemptName),'Exact reviewed controller/reconciliation/attempt required');
 const load=name=>import(pathToFileURL(join(source,'.github/ci',name)).href);
 const {readPrivateInstall,withNormalCleanupLock,retainNormalCleanupAudit}=await load('staging-build-install.mjs');
 const {guardServerCli}=await import(pathToFileURL(join(source,'scripts/staging/lease.mjs')).href);
 const {durableCleanupRecord,readSingleCleanupCommit}=await load('normal-cleanup-io.mjs');
 const {captureNormalCleanupFences,canonicalSourceExclusions}=await load('normal-cleanup-fences.mjs');
 const {fingerprintStagingEnvironment}=await load('staging-environment.mjs');const {collectMigrationLedger}=await load('staging-migration-ledger.mjs');
 const {installJson,validateInstallGrant}=await load('ci-install-grant.mjs');
 const currentLease=()=>{guardServerCli(SELECTION.source);assert(process.env.AIHR_STAGING_BATCH===SELECTION.batch&&process.env.AIHR_STAGING_EPOCH===String(SELECTION.epoch),'Exact active original lease required');};
 currentLease();const reconciliationBytes=privateBytes(reconciliationPath),reconciled=JSON.parse(reconciliationBytes);assert(digest(reconciliationBytes)===reconciliationSha256&&reconciled.originalInstallerProcessPresent===false&&reconciled.ownedTrees.next===true&&reconciled.ownedTrees.packet===true,'Reviewed reconciliation required');
 const certificate=mode==='cleanup'?JSON.parse(privateBytes(certificatePath)):null,context=()=>({controller,toolSha256:toolDigest()});
 const permission=async()=>{currentLease();if(mode==='cleanup')validateCleanupCertificate(certificate,context());};await permission();
 const readMetadata=()=>{const p=readPrivateInstall(SELECTION.installId,{allowExpired:true,allowCleanup:true});historicalInstallMetadata(readFileSync(join(p.directory,'authorization.json')),{validateOriginal:validateInstallGrant});assert(p.grant.source===SELECTION.source&&p.grant.build.buildRecordId===SELECTION.buildRecordId,'Historical source differs');return p;};
 const p=readMetadata(),g=p.grant,activated=JSON.parse(privateBytes(join(p.directory,'activated.json'))),recordNames=['authorization.json','store.json','verified.json','activated.json','audit/system-testing.json','audit/successful-build.json','audit/build-provenance.json','audit/bytes/build-bundle-files.json'];
 const absent=['normal-cleanup-commit.json','normal-cleanup-consumed.json','cleanup-authorized.json','cleanup-intent.json','cleanup-result.json','normal-cleanup-owned-cleanup.json'];let authority=null;
 function originals(){for(const [name,wanted]of Object.entries(reconciled.files)){assert(/^[a-z0-9-]+\.json$/.test(name));const path=join(p.directory,name),bytes=privateBytes(path),s=lstatSync(path);assert(s.ino===wanted.inode&&s.dev===wanted.device&&bytes.length===wanted.bytes&&digest(bytes)===wanted.sha256&&bytes.equals(Buffer.from(wanted.base64,'base64')),'Original failed attempt record changed');}
   verifyPriorDiagnostics(p.directory,reconciled.priorDiagnostics,attemptName);
  }
 assert(!existsSync(join(p.directory,'normal-cleanup.lock')),'Existing cleanup lock requires reconciliation');originals();for(const n of absent)assert(!existsSync(join(p.directory,n)),'Existing authority/consume/result refuses replay');
 return withNormalCleanupLock(p.directory,{source:SELECTION.source,installId:SELECTION.installId,pid:process.pid,purpose:'cleanup-only-v1'},async()=>{
  originals();for(const n of absent)assert(!existsSync(join(p.directory,n)),'Concurrent authority/consume/result');
  const runtime=await createCleanupReadonlyRuntime({source,selection:SELECTION,permission,readMetadata});
  const imported=await import(pathToFileURL(join(source,'scripts/improve/release.ts')).href),official={...(imported.default??{}),...imported},exclude=canonicalSourceExclusions(official.deploymentRsyncArgs(source));
  const show=name=>execFileSync('systemctl',['show','aihr','--property='+name,'--value'],{encoding:'utf8',timeout:3000}).trim();
  const fences=()=>captureNormalCleanupFences({source,p,activated,exclude,recordNames,ports:{authority:async()=>{await permission();originals();readMetadata();if(authority)assert(privateBytes(join(p.directory,'cleanup-authorized.json')).equals(Buffer.from(installJson(authority)+'\n')),'New purpose authority changed');},lease:async()=>currentLease(),leaseIdentity:async()=>({batch:process.env.AIHR_STAGING_BATCH,epoch:process.env.AIHR_STAGING_EPOCH}),runtime:async()=>runtime.runtimeContract(source,g),service:async()=>({pid:show('MainPID'),started:show('ExecMainStartTimestampMonotonic'),active:execFileSync('systemctl',['is-active','aihr'],{encoding:'utf8',timeout:3000}).trim()==='active'}),boot:async()=>digest(readFileSync('/proc/sys/kernel/random/boot_id')),environment:async()=>fingerprintStagingEnvironment(source),ledger:async()=>collectMigrationLedger(source),health:async()=>{const response=await fetch('http://127.0.0.1:'+(process.env.PORT??'3000')+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});await response.arrayBuffer();return response.status;}}});
  if(mode==='inspect'){const before=await fences(),actual=await runtime.audit(),after=await fences();assert(isDeepStrictEqual(before,after),'Inspection drift');return {kind:'CLEANUP_ONLY_READONLY_PREPARATION',controller,toolSha256:toolDigest(),fences:after,runtime:actual,verifiedAt:new Date().toISOString()};}
  const attempt=join(p.directory,attemptName);assert(!existsSync(attempt),'Fresh diagnostic attempt required');mkdirSync(attempt,{mode:0o700});
  durableCleanupRecord(join(attempt,'certificate.json'),certificate);durableCleanupRecord(join(attempt,'preserved-originals.json'),{reconciliationSha256,originalFiles:Object.entries(reconciled.files).map(([name,v])=>({name,sha256:v.sha256,device:v.device,inode:v.inode})),expiredGrantIsMetadataOnly:true});
  const identity=path=>{const s=lstatSync(path);return {device:s.dev,inode:s.ino};};
  const result=await runCleanupOnlySession({certificate,...context(),retainAudit:async()=>retainNormalCleanupAudit(p,activated),audit:runtime.audit,fences,persist:async(name,value)=>durableCleanupRecord(join(attempt,name+'.json'),value),authorize:async request=>{await permission();authority={format:1,kind:'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL',sourceDirectory:source,source:g.source,installId:g.installId,buildRecordId:g.build.buildRecordId,nextBuildId:g.build.nextBuildId,authorizationSha256:p.authorizationSha256,witnessFingerprint:g.witnessFingerprint,directory:identity(p.directory),activeDirectory:activated.activation.activeDirectory,retainedDirectory:activated.activation.retainedDirectory,packetDirectory:identity(p.packet),sourceProof:request,sourceProofSha256:digest(request),authorizedAt:new Date().toISOString(),cleanupOnlyCertificateSha256:digest(certificate),permissionKind:certificate.kind};durableCleanupRecord(join(p.directory,'cleanup-authorized.json'),authority);},consume:async ready=>{await permission();durableCleanupRecord(join(p.directory,'normal-cleanup-consumed.json'),{kind:'CLEANUP_ONLY_V1_NONCE_CONSUMED',certificateSha256:digest(certificate),readySha256:digest(ready)});},removeOwned:async()=>{await permission();return JSON.parse(execFileSync('python3',[join(source,'.github/ci/cleanup-install.py'),p.directory],{encoding:'utf8',timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));},io:{ready:async ready=>process.stdout.write(installJson(ready)+'\n'),commit:()=>readSingleCleanupCommit(process.stdin)}});
  originals();return result;
 });
}
export {finishCleanupCli as finishCleanupServerCli} from './cleanup-only-recovery-policy.mjs';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,source,controller,reconciliationPath,reconciliationSha256,attemptName,certificatePath]=process.argv.slice(2);await finishCleanupCli(()=>serve({mode,source,controller,reconciliationPath,reconciliationSha256,attemptName,certificatePath}));
}
