/** Private copied controller. Never installs, restarts or changes source, schema or original receipts. */
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,readdirSync,existsSync,mkdirSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {selection as S,digest,canonical,runtimeBinding,validateCertificate,validateCommit,parseServiceSnapshot,createCleanupAuthority} from './ui-audit-arrival-recovery-policy.mjs';
import {createCleanupReadonlyRuntime} from './ui-audit-arrival-recovery-runtime.mjs';
export const toolFiles=['policy','runtime','fences','server'].map(n=>'ui-audit-arrival-recovery-'+n+'.mjs');
export const toolHash=()=>digest(toolFiles.map(n=>[n,digest(readFileSync(new URL(n,import.meta.url)))]));
const originals=['activate-intent.json','activate-result.json','activated.json','authorization.json','runtime.json','store.json','verified.json'].sort();
async function serve(mode,certPath){
 const source='/opt/ai-hr',directory='/home/ubuntu/.aihr-ci-builds/'+S.installId;
 assert(['inspect','cleanup'].includes(mode)&&process.cwd()===source&&realpathSync(source)===source&&process.platform==='linux');
 const load=n=>import(pathToFileURL(join(source,'.github/ci',n)).href);
 const {guardServerCli}=await import(pathToFileURL(join(source,'scripts/staging/lease.mjs')).href);
 const lease=()=>{guardServerCli(S.source);assert(process.env.AIHR_STAGING_BATCH===S.batch&&process.env.AIHR_STAGING_EPOCH===String(S.epoch));};lease();
 const {readPrivateInstall,withNormalCleanupLock,retainNormalCleanupAudit}=await load('staging-build-install.mjs');
 const {durableCleanupRecord,readSingleCleanupCommit}=await load('normal-cleanup-io.mjs');
 const {captureNormalCleanupFences,canonicalSourceExclusions}=await import('./ui-audit-arrival-recovery-fences.mjs');
 const {fingerprintStagingEnvironment}=await load('staging-environment.mjs');
 const {collectMigrationLedger}=await load('staging-migration-ledger.mjs');
 const cert=mode==='cleanup'?JSON.parse(readFileSync(certPath)):null,tool=toolHash();
 const permission=async()=>{lease();if(cert)validateCertificate(cert,tool);};
 const readMetadata=()=>{const p=readPrivateInstall(S.installId,{allowExpired:true,allowCleanup:true});assert(p.authorizationSha256===S.authorizationSha256&&p.grant.source===S.source&&p.grant.build.buildRecordId===S.buildRecordId&&p.grant.build.nextBuildId===S.nextBuildId&&Date.parse(p.grant.expiresAt)<Date.now());return p;};
 const p=readMetadata(),activated=JSON.parse(readFileSync(join(directory,'activated.json')));
 const records=()=>{assert(JSON.stringify(readdirSync(directory).filter(n=>n.endsWith('.json')).sort())===JSON.stringify(originals),'Original authority/records changed or cleanup previously started');return originals.map(n=>{const path=join(directory,n),s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&511)===384&&s.size>0&&s.size<1024**2);return [n,{device:s.dev,inode:s.ino,bytes:s.size,sha256:digest(readFileSync(path))}];});};
 const initial=records();
 assert(!existsSync(join(directory,'normal-cleanup.lock')),'Uncertain cleanup lock retained');
 assert(!readdirSync(directory).some(n=>n.startsWith('ui-audit-arrival-recovery-')),'Prior recovery needs reconciliation');
 for(const pid of readdirSync('/proc').filter(n=>/^[1-9][0-9]*$/.test(n))){try{const args=readFileSync('/proc/'+pid+'/cmdline').toString().split('\0');assert(!args.some(a=>a===S.installId||a==='--ci-build='+S.installId),'Original operation still running');}catch(e){if(e.code!=='ENOENT'&&e.code!=='EACCES')throw e;}}
 return withNormalCleanupLock(directory,{source:S.source,installId:S.installId,pid:process.pid,purpose:'explicit-reauthenticated-installed-arrival-cleanup-only'},async()=>{
  const runtime=await createCleanupReadonlyRuntime({source,selection:S,permission,readMetadata});
  const imported=await import(pathToFileURL(join(source,'scripts/improve/release.ts')).href),official={...(imported.default??{}),...imported},exclude=canonicalSourceExclusions(official.deploymentRsyncArgs(source));
  const service=()=>parseServiceSnapshot(execFileSync('systemctl',['show','aihr','--property=MainPID,ExecMainStartTimestampMonotonic,ActiveState'],{encoding:'utf8',timeout:3000}));
  const fences=()=>captureNormalCleanupFences({source,p,activated,exclude,recordNames:[...originals,'packet/system-testing.json','packet/successful-build.json','packet/build-provenance.json','packet/bytes/build-bundle-files.json'],ports:{authority:async()=>{await permission();assert(digest(records())===digest(initial));readMetadata();},lease:async()=>lease(),leaseIdentity:async()=>({batch:S.batch,epoch:String(S.epoch)}),runtime:async()=>runtime.runtimeContract(source,p.grant),service:async()=>service(),boot:async()=>digest(readFileSync('/proc/sys/kernel/random/boot_id')),environment:async()=>fingerprintStagingEnvironment(source),ledger:async()=>collectMigrationLedger(source),health:async()=>{const r=await fetch('http://127.0.0.1:3000/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});await r.arrayBuffer();return r.status;}}});
  const before=await fences(),actual=await runtime.audit(),after=await fences();assert(digest(before)===digest(after),'Full audit drift');
  const inspection={fences:digest(after),originals:digest(initial),runtime:digest(runtimeBinding(actual))};
  if(mode==='inspect')return {kind:'UI_AUDIT_CLEANUP_READ_ONLY_INSPECTION',selection:S,tool,inspection,runtime:actual,fences:after,originals:initial,verifiedAt:new Date().toISOString()};
  assert(canonical(inspection)===canonical(cert.inspection),'Certified full inspection changed');await permission();
  const attempt=join(directory,'ui-audit-arrival-recovery-'+randomBytes(8).toString('hex'));mkdirSync(attempt,{mode:448});
  const save=(n,v)=>durableCleanupRecord(join(attempt,n+'.json'),v);save('certificate',cert);save('preserved-originals',initial);
  const ready={kind:'UI_AUDIT_CLEANUP_READY',certificate:digest(cert),nonce:randomBytes(32).toString('hex'),readyAt:new Date().toISOString()};save('ready',ready);process.stdout.write(JSON.stringify(ready)+'\n');
  const commit=await readSingleCleanupCommit(process.stdin);validateCommit(commit,ready,cert,tool);assert(digest(await fences())===digest(after),'Commit fences changed');save('commit',commit);
  validateCommit(commit,ready,cert,tool);save('consumed',{certificate:digest(cert),nonce:ready.nonce});await permission();
  retainNormalCleanupAudit(p,activated);
  // A fresh, scope-limited certificate and one-use checksum authorize cleanup now.
  // The original expired installation grant and seven original receipts remain byte-identical.
  const identity=path=>{const s=lstatSync(path);return {device:s.dev,inode:s.ino};};
  const authority=createCleanupAuthority({grant:p.grant,authorizationSha256:p.authorizationSha256,directory:identity(p.directory),packetDirectory:identity(p.packet),activated,certificate:cert,commit,ready,tool});
  durableCleanupRecord(join(directory,'cleanup-authorized.json'),authority);await permission();
  const cleanup=JSON.parse(execFileSync('python3',[join(source,'.github/ci/cleanup-install.py'),directory],{encoding:'utf8',timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));save('actual-cleanup',cleanup);
  assert(cleanup.kind==='OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED'&&cleanup.authorizationSha256===S.authorizationSha256&&cleanup.source===S.source&&cleanup.installId===S.installId&&cleanup.nextBuildId===S.nextBuildId&&canonical(cleanup.verifiedAbsent)==='["next","packet"]'&&cleanup.auditEvidenceRetained===true);
  const finalRuntime=await runtime.audit();assert(digest(runtimeBinding(finalRuntime))===cert.inspection.runtime,'Final full runtime changed');await permission();
  for(const [n,v]of initial){const st=lstatSync(join(directory,n));assert(st.ino===v.inode&&st.dev===v.device&&digest(readFileSync(join(directory,n)))===v.sha256,'Original receipt changed');}
  const result={kind:'UI_AUDIT_CLEANUP_RECOVERED_NOT_ORIGINAL_OPERATOR_PASS',selection:S,certificate:digest(cert),cleanup,runtime:finalRuntime,originalFailuresPreserved:true,attempt,ownedResourceCleanupVerified:true,releaseHandbackVerified:false};save('result',result);return result;
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{const value=await serve(...process.argv.slice(2));await new Promise((ok,fail)=>process.stdout.write(JSON.stringify(value)+'\n',e=>e?fail(e):ok()));process.exit(0);}catch(e){console.error(e);process.exit(1);}
}
