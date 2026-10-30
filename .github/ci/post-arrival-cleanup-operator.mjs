/** Reviewed cleanup-only parent. No source transfer, installation, activation, restart or lease finish. */
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {verifyTool} from './post-arrival-cleanup-server.mjs';
import {CLEANUP_SELECTION as selected,digest,validateCleanupExecutionApproval,validateCleanupCommit} from './post-arrival-cleanup-policy.mjs';
import {readCleanupCommit,publishCleanupRecord} from './post-arrival-cleanup-io.mjs';
import {createSourceSnapshot,verifySnapshot} from './post-arrival-source-snapshot.mjs';
import {cleanHead} from './release-ci.mjs';
import {installJson} from './ci-install-grant.mjs';
import {stagingTransport} from './staging-transport.mjs';
import {PACKET_MODE_ARGS,assertRsyncPacketCapability} from './rsync-packet-capability.mjs';
import {readLease,guardCommand,guardedRsync,leasePhase,redactLeaseError} from '../../scripts/staging/lease.mjs';
const TOOL=resolve(fileURLToPath(new URL('../../',import.meta.url))),quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
export function waitCleanupMessage(stream,{timeout=600000}={}){
 return new Promise((accept,reject)=>{
  let settled=false;
  const clean=()=>{clearTimeout(timer);stream.off('readable',ready);stream.off('end',end);stream.off('error',end);};
  const end=()=>{if(settled)return;settled=true;clean();reject(Error('Cleanup channel ended without a result; retain lease'));};
  const ready=()=>{if(settled)return;settled=true;clean();readCleanupCommit(stream).then(accept,reject);};
  const timer=setTimeout(()=>{if(settled)return;settled=true;clean();reject(Error('Cleanup channel observation timeout; reconcile remote state before any retry'));},timeout);
  stream.once('readable',ready);stream.once('end',end);stream.once('error',end);
 });
}
export async function driveCleanup({channel,checksum,frozen,save,approval,tool,phase,now=()=>Date.now()}){
 const ready=await waitCleanupMessage(channel.stdout);assert(ready.kind==='PRIVATE_CLEANUP_READY','Expected private preparation');
 save('preparation',ready.preparation);frozen();validateCleanupExecutionApproval(approval,{...tool,now:now()});
 const output=await checksum(),checkedAt=new Date(now()).toISOString();save('fresh-source-checksum',{source:selected.source,output,checkedAt});assert(output==='','Full canonical source checksum must be empty');frozen();
 const preparation=ready.preparation,request={format:1,kind:'COMMIT_SINGLE_POST_ARRIVAL_OWNED_CLEANUP',selection:selected,nonce:preparation.nonce,
  preparationSha256:digest(installJson(preparation)),approvalSha256:digest(installJson(approval)),toolSha256:tool.toolSha256,checksumCheckedAt:checkedAt,checksumOutputSha256:digest(output)};
 validateCleanupCommit(request,preparation,{fences:preparation.fences,approvalSha256:request.approvalSha256,toolSha256:tool.toolSha256,now:now()});
 save('commit',request);channel.stdin.end(installJson(request)+'\n');
 const message=await waitCleanupMessage(channel.stdout);assert(message.kind==='PRIVATE_CLEANUP_RESULT','No successful cleanup result received');
 const result=message.result;assert(result.kind==='POST_EXPIRY_OWNED_CLEANUP_COMPLETE_NOT_HAND_BACK'&&result.source===selected.source&&result.installId===selected.installId&&result.buildRecordId===selected.buildRecordId
  &&result.nextBuildId===selected.nextBuildId&&result.authorizationSha256===selected.authorizationSha256&&result.authoritySha256===selected.authoritySha256&&result.approvalSha256===request.approvalSha256
  &&result.toolSha256===tool.toolSha256&&result.ownedResourceCleanupVerified===true&&result.releaseHandbackVerified===false&&result.releaseAuthorized===false,'Finalizer result identity differs');
 save('server-result',result);await channel.success();frozen();
 const finalOutput=await checksum(),finalCheckedAt=new Date(now()).toISOString();save('final-source-checksum',{source:selected.source,output:finalOutput,checkedAt:finalCheckedAt});assert(finalOutput==='','Post-cleanup full canonical checksum differs');frozen();
 save('phase-arrived',await phase());
 const complete={...result,fullSourceChecksumVerified:true,releaseHandbackVerified:false,completedAt:new Date(now()).toISOString()};save('complete',complete);return complete;
}
async function main(){
 assert(process.argv.length===5,'Usage: operator CLEAN_F2CA_CHECKOUT PRIVATE_APPROVAL NEW_PRIVATE_EVIDENCE_DIRECTORY');
 const candidate=realpathSync(resolve(process.argv[2])),approvalPath=realpathSync(resolve(process.argv[3])),out=resolve(process.argv[4]),tool=verifyTool(TOOL);
 assert((lstatSync(approvalPath).mode&0o777)===0o600,'Private0600 execution approval required');const approval=JSON.parse(readFileSync(approvalPath));validateCleanupExecutionApproval(approval,tool);assert(approval.toolSha256===tool.toolSha256,'Reviewed package differs from approval');
 mkdirSync(out,{mode:0o700});const save=(name,value)=>publishCleanupRecord(join(out,name+'.json'),value),frozen=()=>assert(cleanHead(candidate)===selected.source,'Exact clean installed source required');frozen();
 const lease=readLease(selected.source);assert(lease.epoch===selected.epoch&&lease.batch===selected.batch,'Original retained lease required');
 const transport=stagingTransport(candidate,process.env),ssh=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:65536,...options});
 const imported=await import(pathToFileURL(join(candidate,'scripts/improve/release.ts')).href),official={...(imported.default??{}),...imported};
 assertRsyncPacketCapability();
 const parent=mkdtempSync(join(tmpdir(),'cleanup-f2ca-snapshot-')),snapshot=join(parent,'source');createSourceSnapshot(candidate,snapshot,tool.sourcePaths);frozen();
 const files=join(parent,'known-files.txt');writeFileSync(files,tool.sourcePaths.map(r=>r.path).join('\n')+'\n',{mode:0o600});
 // Read-only remote sender. All transferred names were public tracked canonical members, independently hash-pinned.
 const canonical=transport.rsyncArgs(official,snapshot),shell=canonical[canonical.indexOf('-e')+1];
 execFileSync('rsync',guardedRsync(lease,['-a','--checksum','--existing','--files-from='+files,'-e',shell,'--','aihr-staging:/opt/ai-hr/',snapshot+'/']),{timeout:120000,maxBuffer:65536});
 save('snapshot',verifySnapshot(snapshot,tool.sourcePaths));frozen();
 const checksum=()=>{frozen();verifySnapshot(snapshot,tool.sourcePaths);const output=execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...guardedRsync(lease,transport.rsyncArgs(official,snapshot))],{encoding:'utf8',timeout:120000,maxBuffer:16*1024**2});verifySnapshot(snapshot,tool.sourcePaths);frozen();return output;};
 const home=ssh("python3 -c 'from pathlib import Path; print(Path.home().resolve())'").trim();assert(/^\/[A-Za-z0-9_/-]+$/.test(home)&&!home.split('/').some(p=>p==='.'||p==='..')&&!home.startsWith('/opt/ai-hr'),'Canonical separate staging operator home required');
 const parentRemote=home+'/.aihr-ci-cleanup-tools',remote=parentRemote+'/'+tool.toolSha256,remoteApproval=parentRemote+'/approval-'+tool.toolSha256+'.json';
 const setup="import os,stat; p="+JSON.stringify(parentRemote)+"; os.makedirs(p,mode=0o700,exist_ok=True); s=os.lstat(p); assert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700; os.mkdir("+JSON.stringify(remote)+",0o700); f=os.open("+JSON.stringify(remoteApproval)+",os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.close(f)";
 ssh(guardCommand(lease,'python3 -c '+quote(setup)));
 execFileSync('rsync',guardedRsync(lease,[...PACKET_MODE_ARGS,'-e',shell,'--',TOOL+'/', 'aihr-staging:'+remote+'/']),{timeout:120000,maxBuffer:65536});
 execFileSync('rsync',guardedRsync(lease,[...PACKET_MODE_ARGS,'-e',shell,'--',approvalPath,'aihr-staging:'+remoteApproval]),{timeout:30000,maxBuffer:65536});frozen();
 const command='cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx '+quote(remote+'/.github/ci/post-arrival-cleanup-server.mjs')+' '+quote(remoteApproval);
 const child=spawn('ssh',transport.sshArgs(guardCommand(lease,command)),{stdio:['pipe','pipe','pipe']}),stderr=[];let errorBytes=0;
 child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes<=65536)stderr.push(chunk);});
 const success=new Promise((accept,reject)=>{child.once('error',reject);child.once('close',code=>{writeFileSync(join(out,'server.stderr.log'),Buffer.concat(stderr),{mode:0o600});code===0?accept():reject(Error('Cleanup SSH ended without successful completion; reconcile remote state and retain lease'));});});success.catch(()=>{});
 let result;try{result=await driveCleanup({channel:{stdout:child.stdout,stdin:child.stdin,success:()=>success},checksum,frozen,save,approval,tool,
  phase:()=>leasePhase(lease,ssh,'arrived',selected.nextBuildId)});}catch(error){child.stdin.end();save('incomplete-retain-lease',{kind:'CLEANUP_NOT_COMPLETED_OR_ACKNOWLEDGED',reconcileRemoteBeforeRetry:true,releaseHandbackVerified:false});throw error;}
 console.log(JSON.stringify({kind:result.kind,source:result.source,nextBuildId:result.nextBuildId,ownedResourceCleanupVerified:true,fullSourceChecksumVerified:true,releaseHandbackVerified:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(redactLeaseError(error));process.exitCode=1;});
