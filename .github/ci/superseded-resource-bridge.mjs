/** Fixed staging read-only checks for a distinct current runtime and obsolete resources. */
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,readdirSync,realpathSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {SELECTION,hash,validateLease,validateTargets,validateCertificate,validateRuntime,runtimeBody} from './superseded-resource-policy.mjs';
import {createCleanupReadonlyRuntime} from './superseded-resource-runtime.mjs';
export const TOOL_FILES=['superseded-resource-policy.mjs','superseded-resource-runtime.mjs','superseded-resource-bridge.mjs','superseded-resource-operator.mjs','superseded-resource-cleanup.py'];
export const toolHash=()=>hash(TOOL_FILES.map(name=>[name,hash(readFileSync(new URL(name,import.meta.url)))]));
export function privateBytes(path,bound=16*1024**2){const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&511)===384&&s.size>0&&s.size<=bound&&realpathSync(path)===path,'Bounded canonical private input required');return readFileSync(path);}
export const identity=path=>{const s=lstatSync(path);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&realpathSync(path)===path,'Canonical owned directory required');return {device:s.dev,inode:s.ino};};
export function retainedRecords(directory){
 const result=[];function walk(path,relative=''){
  const s=lstatSync(path);assert(s.uid===process.getuid()&&!s.isSymbolicLink(),'Original retained record owner/type differs');
  if(s.isDirectory()){assert((s.mode&511)===448,'Retained record directory must be0700');result.push([relative,{device:s.dev,inode:s.ino,mode:s.mode,uid:s.uid}]);for(const name of readdirSync(path).sort()){if(!relative&&['next','packet'].includes(name))continue;assert(/^[a-zA-Z0-9_.-]+$/.test(name)&&!['.','..'].includes(name),'Bounded retained path required');walk(join(path,name),relative?relative+'/'+name:name);}}
  else{assert(s.isFile()&&s.nlink===1&&s.size>0&&s.size<=16*1024**2&&(s.mode&511)===384,'Bounded immutable original record required');result.push([relative,{device:s.dev,inode:s.ino,mode:s.mode,uid:s.uid,bytes:s.size,sha256:hash(readFileSync(path))}]);}
  assert(result.length<=256,'Retained audit inventory exceeds bound');
 }walk(directory);return result;
}
export function assertExclusiveLease(run=execFileSync){const fd=Number(process.env.AIHR_SUPERSEDED_EXCLUSIVE_FD);assert(Number.isSafeInteger(fd)&&fd>=3,'Actual inherited exclusive descriptor required');run('python3',[new URL('superseded-resource-cleanup.py',import.meta.url).pathname,'assert-exclusive'],{stdio:['ignore','ignore','pipe',fd],env:{...process.env,AIHR_SUPERSEDED_EXCLUSIVE_FD:'3'},timeout:15000,maxBuffer:1024**2});}
export function assertRemaining(directory,certificate,remaining){
 assert(Array.isArray(remaining)&&isDeepStrictEqual(remaining,['next','packet'].filter(n=>remaining.includes(n)))&&new Set(remaining).size===remaining.length,'Exact canonical remaining-resource set required');
 for(const name of ['next','packet'])if(remaining.includes(name)){assert(isDeepStrictEqual(identity(join(directory,name)),certificate.targets[name]),'Selected obsolete resource replaced');if(name==='next')assert(readFileSync(join(directory,name,'BUILD_ID'),'utf8').trim()===SELECTION.obsolete.retainedBuildId,'Retained194e build differs');}
 else{try{lstatSync(join(directory,name));assert.fail('A removed selected resource reappeared');}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export async function bridge({mode,controller,observationPath,certificatePath,remaining=['next','packet']}){
 assert(['inspect','check','post','authority'].includes(mode)&&/^[a-f0-9]{40}$/.test(controller),'Exact read-only bridge mode/controller required');
 const raw=privateBytes(observationPath),observation=JSON.parse(raw),certificate=mode==='inspect'?null:JSON.parse(privateBytes(certificatePath));
 const context=()=>({controller,toolSha256:toolHash(),deleting:mode==='check'});if(certificate){validateCertificate(certificate,context());assert(certificate.observationSha256===hash(raw),'Original independent observation changed');}
 if(mode==='authority')return certificate;
 const source='/opt/ai-hr';assert(process.platform==='linux'&&process.cwd()===source&&realpathSync(source)===source,'Canonical staging read-only bridge required');
 const load=name=>import(pathToFileURL(join(source,name)).href),{guardServerCli}=await load('scripts/staging/lease.mjs');
 const lease={batch:process.env.AIHR_STAGING_BATCH,epoch:Number(process.env.AIHR_STAGING_EPOCH)};validateLease(lease);
 const permission=async()=>{if(mode==='inspect')guardServerCli(SELECTION.current.source);else assertExclusiveLease();assert(process.env.AIHR_STAGING_CANDIDATE===SELECTION.current.source,'Current lease source differs');if(certificate){assert(isDeepStrictEqual(lease,certificate.lease),'Certificate lease differs');validateCertificate(certificate,context());}};await permission();
 const {readPrivateInstall}=await load('.github/ci/staging-build-install.mjs'),{validateInstallGrant}=await load('.github/ci/ci-install-grant.mjs');
 function removalRecord(name){
  assert(certificate&&['next','packet'].includes(name),'Purpose authority required for an absent obsolete child');
  const root=join(resolve(current.directory,'../..'),'.aihr-superseded-cleanup',certificate.certificateId),s=lstatSync(root);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&511)===448,'Exact private purpose journal required');
  const consumed=JSON.parse(privateBytes(join(root,'consumed.json'))),removed=JSON.parse(privateBytes(join(root,'removed-'+name+'.json')));
  for(const r of [consumed,removed])assert(r.certificateSha256===hash(certificate)&&isDeepStrictEqual(r.selection,SELECTION)&&isDeepStrictEqual(r.targets,certificate.targets),'Distinct purpose consumption/removed record differs');
  assert(consumed.kind==='SUPERSEDED_RESOURCE_NONCE_CONSUMED'&&removed.kind==='EXACT_SELECTED_RESOURCE_ABSENT'&&removed.child===name&&isDeepStrictEqual(removed.identity,certificate.targets[name]),'Exact purpose-only absent-child record required');
 }
 function metadata(selected){
  let p;if(selected===SELECTION.current)p=readPrivateInstall(selected.installId,{allowExpired:true,allowCleanup:true});
  else{
   // Separate obsolete ownership reader: the normal installer correctly refuses an absent packet
   // without its OWN normal authority. We never invent that authority for this different purpose.
   const directory=join(resolve(current.directory,'../..'),'.aihr-ci-builds',selected.installId);identity(directory);const s=lstatSync(directory);assert((s.mode&511)===448,'Private obsolete installation required');
   const grant=validateInstallGrant(JSON.parse(privateBytes(join(directory,'authorization.json'),32768)),{allowExpired:true});p={directory,next:join(directory,'next'),packet:join(directory,'packet'),grant};
   const store=JSON.parse(privateBytes(join(directory,'store.json')));assert(store.installId===selected.installId&&isDeepStrictEqual(store.directory,identity(directory)),'Original obsolete store directory differs');
   if(existsSync(p.packet))assert(isDeepStrictEqual(store.packetDirectory,identity(p.packet)),'Original obsolete packet replaced');
   else{assert(certificate&&!remaining.includes('packet')&&isDeepStrictEqual(store.packetDirectory,certificate.targets.packet),'Unplanned original packet absence');removalRecord('packet');}
  }
  const bytes=privateBytes(join(p.directory,'authorization.json'),32768);assert(hash(bytes)===selected.grantSha256,'Immutable original grant differs');const g=validateInstallGrant(JSON.parse(bytes),{allowExpired:true});assert(g.source===selected.source&&g.installId===selected.installId&&g.build.buildRecordId===selected.buildRecordId&&g.build.nextBuildId===selected.nextBuildId,'Historical ownership metadata differs');return p;
 }
 const current=metadata(SELECTION.current),old=metadata(SELECTION.obsolete),activated=JSON.parse(privateBytes(join(current.directory,'activated.json')));
 const assertOld=()=>{
  metadata(SELECTION.current);metadata(SELECTION.obsolete);assert(!existsSync('/proc/'+SELECTION.obsolete.deadPid),'Old PID exists/reused; explicit reconciliation required');
  for(const name of ['normal-cleanup-commit.json','normal-cleanup-consumed.json','cleanup-authorized.json','cleanup-intent.json','cleanup-result.json','normal-cleanup-owned-cleanup.json']){try{lstatSync(join(old.directory,name));assert.fail('Original interrupted session has new authority/result');}catch(error){if(error.code!=='ENOENT')throw error;}}
  for(const[name,wanted]of Object.entries(observation.oldOriginals)){assert(/^[a-z0-9.-]+$/.test(name),'Exact original record name required');const p=join(old.directory,name),s=lstatSync(p);assert(s.dev===wanted.device&&s.ino===wanted.inode&&hash(privateBytes(p))===wanted.sha256,'Original lock/READY/audit record changed');}
  assert(readFileSync(join(old.directory,'normal-cleanup.lock'),'utf8').includes(String(SELECTION.obsolete.deadPid)),'Original dead-lock record missing');
 };
 const {cleanupTreeFence,canonicalSourceExclusions}=await load('.github/ci/normal-cleanup-fences.mjs'),{fingerprintStagingEnvironment}=await load('.github/ci/staging-environment.mjs'),{collectMigrationLedger}=await load('.github/ci/staging-migration-ledger.mjs');
 const imported=await load('scripts/improve/release.ts'),official={...(imported.default??{}),...imported},exclude=canonicalSourceExclusions(official.deploymentRsyncArgs(source));
 const show=name=>execFileSync('systemctl',['show','aihr','--property='+name,'--value'],{encoding:'utf8',timeout:10000}).trim();
 async function fence(){const started=Date.now();await permission();assertOld();const pid=show('MainPID'),start=show('ExecMainStartTimestampMonotonic'),ledger={...collectMigrationLedger(source)};delete ledger.verifiedAt;
  const active=identity(join(source,'.next'));assert(isDeepStrictEqual(active,activated.activation.activeDirectory)&&readFileSync(join(source,'.next/BUILD_ID'),'utf8').trim()===SELECTION.current.nextBuildId,'Current active compiled tree changed');
  assert(!existsSync(current.next)&&!existsSync(current.packet),'Current accepted installation cleanup changed');
  const health=await fetch('http://127.0.0.1:'+(process.env.PORT??'3000')+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});await health.arrayBuffer();assert(health.status===200&&execFileSync('systemctl',['is-active','aihr'],{encoding:'utf8',timeout:10000}).trim()==='active'&&show('MainPID')===pid,'Current health/stable service PID required');
  const value={source:SELECTION.current.source,installId:SELECTION.current.installId,grantSha256:SELECTION.current.grantSha256,lease,active,directory:identity(current.directory),pid,started:start,boot:hash(readFileSync('/proc/sys/kernel/random/boot_id')),environment:fingerprintStagingEnvironment(source),sourceMetadata:cleanupTreeFence(source,exclude),compiledMetadata:cleanupTreeFence(join(source,'.next'),p=>p==='cache'),records:retainedRecords(current.directory),ledger};assert(Date.now()-started<=30000,'Fast current fence exceeded30seconds');return value;
 }
 const auditor=await createCleanupReadonlyRuntime({source,selection:SELECTION.current,permission,readMetadata:()=>metadata(SELECTION.current)});
 const targets=()=>validateTargets({active:identity(join(source,'.next')),currentInstall:identity(current.directory),oldInstall:identity(old.directory),next:identity(old.next),packet:identity(old.packet)});
 if(mode==='inspect'){
  assertOld();const before=await fence(),records=retainedRecords(old.directory),selected=targets();
  for(const[key,wanted]of [['active',observation.active],['currentInstall',observation.currentInstall],['oldInstall',observation.oldInstall],['next',observation.oldNext],['packet',observation.oldPacket]])assert(selected[key].device===wanted.device&&selected[key].inode===wanted.inode,'Independent resource/current observation differs');
  assert(readFileSync(join(old.next,'BUILD_ID'),'utf8').trim()===SELECTION.obsolete.retainedBuildId,'Old retained baseline build differs');
  for(const[name,key]of [['system-testing.json','preparedSha256'],['successful-build.json','successfulObservationSha256'],['build-provenance.json','provenanceSha256'],['bytes/build-bundle-files.json','manifestSha256']])assert(hash(privateBytes(join(old.packet,name)))===old.grant.build[key]&&privateBytes(join(old.packet,name)).equals(privateBytes(join(old.directory,'audit',name))),'Obsolete packet/audit provenance changed');
  const runtime=validateRuntime(await auditor.audit()),after=await fence();assert(isDeepStrictEqual(before,after)&&isDeepStrictEqual(records,retainedRecords(old.directory))&&isDeepStrictEqual(selected,targets()),'State changed during full read-only inspection');
  return {kind:'READONLY_SUPERSEDED_RESOURCE_INSPECTION',controller,toolSha256:toolHash(),observationSha256:hash(raw),lease,currentFence:after,oldRecords:records,targets:selected,runtime,verifiedAt:new Date().toISOString(),releaseAuthorized:false};
 }
 assertRemaining(old.directory,certificate,remaining);for(const name of ['next','packet'])if(!remaining.includes(name))removalRecord(name);const currentFence=await fence(),oldRecords=retainedRecords(old.directory);assert(hash(currentFence)===certificate.currentFenceSha256&&hash(oldRecords)===certificate.oldRecordsSha256,'Current fences or original records changed');assert(isDeepStrictEqual(identity(old.directory),certificate.targets.oldInstall),'Obsolete install directory changed');
 if(mode==='check')return {kind:'SUPERSEDED_RESOURCE_BOUNDARY_VERIFIED',certificate,oldDirectory:old.directory,source,remaining};
 assert(remaining.length===0,'Post-audit requires both selected children absent');const runtime=validateRuntime(await auditor.audit());assert(hash(runtimeBody(runtime))===certificate.runtimeSha256&&hash(await fence())===certificate.currentFenceSha256&&hash(retainedRecords(old.directory))===certificate.oldRecordsSha256,'Current runtime/original audit changed after deletion');
 return {kind:'SUPERSEDED_RESOURCES_REMOVED_CURRENT_RUNTIME_VERIFIED',selection:SELECTION,certificateSha256:hash(certificate),runtime,verifiedAbsent:['next','packet'],originalLockReadyAndAuditsPreserved:true,originalOperatorExit:null,originalOperatorPass:false,releaseAuthorized:false,releaseHandbackVerified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const[mode,controller,observationPath,certificatePath,remaining]=process.argv.slice(2);bridge({mode,controller,observationPath,certificatePath,remaining:remaining?JSON.parse(remaining):undefined}).then(value=>process.stdout.write(JSON.stringify(value)+'\n',()=>process.exit(0))).catch(()=>{process.stderr.write('Superseded-resource bridge refused; preserve all records and lease.\n',()=>process.exit(1));});
}
