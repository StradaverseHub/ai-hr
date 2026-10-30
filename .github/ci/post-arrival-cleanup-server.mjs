/** External, single-install finalizer. Invoke only through a separately approved staging queue guard. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync,mkdirSync,readdirSync,readlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {guardServerCli,COORDINATOR} from '../../scripts/staging/lease.mjs';
import {installJson} from './ci-install-grant.mjs';
import {fingerprintStagingEnvironment} from './staging-environment.mjs';
import {collectMigrationLedger} from './staging-migration-ledger.mjs';
import {CLEANUP_SELECTION as selected,digest,historicalCleanupSelection,validateCleanupExecutionApproval,stableCleanupLedger} from './post-arrival-cleanup-policy.mjs';
import {completeOwnedCleanup} from './post-arrival-cleanup-session.mjs';
import {auditHistoricalCleanupRuntime} from './post-arrival-cleanup-runtime.mjs';
import {readCleanupCommit,acquireCleanupLock,consumeCleanupChallenge,publishCleanupRecord as publish} from './post-arrival-cleanup-io.mjs';

const ROOT='/opt/ai-hr',TOOL=resolve(fileURLToPath(new URL('../../',import.meta.url)));
function bytes(path,bound=65536){
 const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&s.size>0&&s.size<=bound,'Bounded owned regular record required');
 return readFileSync(path);
}
function identity(path){const s=lstatSync(path);assert(s.isDirectory()&&!s.isSymbolicLink(),'Real directory required');return {device:s.dev,inode:s.ino};}
function metadata(path){const s=lstatSync(path,{bigint:true});return [s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).concat(s.isSymbolicLink()?readlinkSync(path):'');}
function compiledMetadata(){
 const rows=[];
 function walk(path,relative=''){
  assert(rows.length<=200000,'Compiled metadata bound exceeded');rows.push([relative,metadata(path)]);
  if(lstatSync(path).isDirectory())for(const name of readdirSync(path).sort()){
   if(relative===''&&name==='cache')continue; // Same sole mutable-runtime exclusion as verify-active-directory.
   walk(join(path,name),relative?relative+'/'+name:name);
  }
 }
 walk(join(ROOT,'.next'));return digest(installJson(rows));
}
export function verifyTool(toolRoot=TOOL){
 assert(toolRoot!==ROOT&&!toolRoot.startsWith(ROOT+'/')&&realpathSync(toolRoot)===toolRoot,'Reviewed tool must remain outside application source');
 assert(lstatSync(toolRoot).uid===process.getuid()&&(lstatSync(toolRoot).mode&0o777)===0o700,'Private owned tool directory required');
 const manifestBytes=bytes(join(toolRoot,'post-arrival-tool.json'),4*1024**2),manifest=JSON.parse(manifestBytes);
 assert(manifest.format===1&&manifest.kind==='REVIEWED_EXTERNAL_SINGLE_INSTALL_CLEANUP_TOOL'&&/^[a-f0-9]{40}$/.test(manifest.controller)&&Array.isArray(manifest.files)&&manifest.files.length<=1500,'Exact reviewed package manifest required');
 const seen=new Set();for(const row of manifest.files){
  assert(typeof row.path==='string'&&!row.path.startsWith('/')&&!row.path.split('/').some(p=>!p||p==='.'||p==='..')&&!seen.has(row.path),'Unsafe or repeated tool member');seen.add(row.path);
  assert((lstatSync(join(toolRoot,row.path)).mode&0o777)===0o600&&digest(bytes(join(toolRoot,row.path),16*1024**2))===row.sha256,'Reviewed private tool bytes changed');
 }
 for(const required of ['source-files.json','.github/ci/post-arrival-cleanup-server.mjs','.github/ci/post-arrival-cleanup-policy.mjs','.github/ci/post-arrival-cleanup-session.mjs','.github/ci/post-arrival-cleanup-runtime.mjs'])assert(seen.has(required),'Required tool member is not hash bound');
 const actual=[];function inventory(directory,prefix=''){
  for(const name of readdirSync(directory).sort()){
   const relative=prefix?prefix+'/'+name:name,path=join(directory,name),st=lstatSync(path);assert(!st.isSymbolicLink(),'Tool links refuse');
   if(st.isDirectory()){assert(st.uid===process.getuid()&&(st.mode&0o777)===0o700,'Private tool subdirectory required');inventory(path,relative);}else{assert(st.isFile()&&actual.length<1500,'Tool inventory differs');if(relative!=='post-arrival-tool.json')actual.push(relative);}
  }
 }inventory(toolRoot);assert(actual.sort().join('\n')===[...seen].sort().join('\n'),'Unbound or missing tool files');
 const source=JSON.parse(bytes(join(toolRoot,'source-files.json'),4*1024**2)),paths=source.files;
 assert(source.source===selected.source&&Array.isArray(paths)&&paths.length>0&&paths.length<=20000&&new Set(paths.map(r=>r.path)).size===paths.length&&paths.every(r=>typeof r.path==='string'&&!r.path.startsWith('/')&&!r.path.includes('\n')&&!r.path.split('/').some(s=>!s||s==='.'||s==='..')&&['file','link'].includes(r.kind)&&[0o644,0o755,0o777].includes(r.mode)&&/^[a-f0-9]{64}$/.test(r.sha256)),'Complete bounded frozen source inventory required');
 return {controller:manifest.controller,toolSha256:digest(manifestBytes),sourcePaths:paths};
}
async function main(){
 assert(process.argv.length===3&&process.platform==='linux'&&realpathSync(process.cwd())===ROOT&&realpathSync(process.execPath)===realpathSync('/opt/node22/bin/node'),'Exact staging-only invocation required');
 guardServerCli(selected.source);
 assert(process.env.AIHR_STAGING_NODE_GUARDED==='1'&&process.env.AIHR_STAGING_CANDIDATE===selected.source
  &&process.env.AIHR_STAGING_BATCH===selected.batch&&process.env.AIHR_STAGING_EPOCH===String(selected.epoch),'Same retained staging lease required');
 const tool=verifyTool(),approvalPath=resolve(process.argv[2]);assert(realpathSync(approvalPath)===approvalPath&&(lstatSync(approvalPath).mode&0o777)===0o600,'Private canonical approval required');
 const approval=JSON.parse(bytes(approvalPath));validateCleanupExecutionApproval(approval,tool);assert(approval.toolSha256===tool.toolSha256,'Wrong reviewed tool approval');
 const directory=join(realpathSync(homedir()),'.aihr-ci-builds',selected.installId),grantBytes=bytes(join(directory,'authorization.json'),32768),authorityBytes=bytes(join(directory,'cleanup-authorized.json'));
 const {authority}=historicalCleanupSelection(grantBytes,authorityBytes);
 const lock=join(directory,'post-arrival-finalizer.lock'),releaseLock=acquireCleanupLock(lock,{pid:process.pid,source:selected.source,installId:selected.installId});
 try{
  const journal=join(directory,'post-arrival-finalizer-'+randomUUID());mkdirSync(journal,{mode:0o700});
  const recordNames=['authorization.json','store.json','verified.json','activated.json','cleanup-authorized.json','audit/system-testing.json','audit/successful-build.json','audit/build-provenance.json','audit/bytes/build-bundle-files.json'];
  const fences=async()=>{
   assert(verifyTool().toolSha256===tool.toolSha256,'Reviewed execution tool changed');
   execFileSync('python3',[COORDINATOR,'assert-env'],{stdio:['ignore','ignore','pipe'],timeout:10000});
   const activeDirectory=identity(join(ROOT,'.next')),retainedDirectory=identity(join(directory,'next')),packetDirectory=identity(join(directory,'packet'));
   assert(installJson(activeDirectory)===installJson(authority.activeDirectory)&&installJson(retainedDirectory)===installJson(authority.retainedDirectory)&&installJson(packetDirectory)===installJson(authority.packetDirectory),'Original active and selected owned inodes required');
   const show=p=>execFileSync('systemctl',['show','aihr','--property='+p,'--value'],{encoding:'utf8',timeout:10000}).trim();
   assert(execFileSync('systemctl',['is-active','aihr'],{encoding:'utf8',timeout:10000}).trim()==='active','Service not active');
   const pid=show('MainPID');assert((await fetch('http://127.0.0.1:'+ (process.env.PORT??'3000')+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)})).status===200&&show('MainPID')===pid,'Stable healthy service required');
   const sourceMetadata=tool.sourcePaths.map(row=>{
    const path=join(ROOT,row.path),st=lstatSync(path);assert(st.uid===process.getuid()&&st.size<=64*1024**2,'Frozen source member changed');
    assert((row.kind==='link'?st.isSymbolicLink():st.isFile()&&!st.isSymbolicLink())&&(st.mode&0o777)===row.mode,'Frozen source member type or mode differs');
    assert(digest(row.kind==='link'?readlinkSync(path):readFileSync(path))===row.sha256,'Frozen source executable or input bytes changed');
    return [row.path,metadata(path)];
   });
   return {source:selected.source,batch:selected.batch,epoch:selected.epoch,pid,nextBuildId:bytes(join(ROOT,'.next/BUILD_ID'),513).toString().trim(),activeDirectory,retainedDirectory,packetDirectory,
    bootIdSha256:digest(readFileSync('/proc/sys/kernel/random/boot_id')),environmentSha256:fingerprintStagingEnvironment(ROOT),ledgerSha256:digest(installJson(stableCleanupLedger(collectMigrationLedger(ROOT)))),
    sourceStatSha256:digest(installJson(sourceMetadata)),compiledStatSha256:compiledMetadata(),
    originalRecordsSha256:digest(installJson(recordNames.map(p=>[p,digest(bytes(join(directory,p),16*1024**2))])))};
  };
  const io={ready:async preparation=>{process.stdout.write(installJson({kind:'PRIVATE_CLEANUP_READY',preparation})+'\n');},commit:()=>readCleanupCommit(process.stdin)};
  const audit=async()=>{
   assert(installJson(identity(join(ROOT,'.next')))===installJson(authority.activeDirectory),'Active directory changed before audit');
   const runtime=await auditHistoricalCleanupRuntime();
   assert(installJson(identity(join(ROOT,'.next')))===installJson(authority.activeDirectory),'Active directory changed during audit');return runtime;
  };
  const result=await completeOwnedCleanup({grantBytes,authorityBytes,approval,...tool,io,audit,fences,
   persist:async(name,value)=>publish(join(journal,name+'.json'),value),consume:async preparation=>consumeCleanupChallenge(directory,preparation),
   removeOwned:async()=>JSON.parse(execFileSync('python3',[join(ROOT,'.github/ci/cleanup-install.py'),directory],{encoding:'utf8',timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}))});
  process.stdout.write(installJson({kind:'PRIVATE_CLEANUP_RESULT',result})+'\n');
 }finally{releaseLock();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Cleanup finalizer refused; retain private journal and lease.');process.exitCode=1;});
