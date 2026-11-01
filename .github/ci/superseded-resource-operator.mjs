/** ROOT operator only. No install/restart/DB mutation; source proof and separate resource authority. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {SELECTION,ORIGIN,hash,validateLease,validateReauthentication,issueCertificate,validateCertificate} from './superseded-resource-policy.mjs';
import {TOOL_FILES,toolHash,privateBytes} from './superseded-resource-bridge.mjs';
export function save(path,value){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
export async function reauthenticate(c){
 const imported=await import(pathToFileURL(join(c.frozenCurrent,'.github/ci/release-ci.mjs')).href);assert(imported.cleanHead(c.frozenCurrent)===SELECTION.current.source,'Exact clean CURRENT source required');
 const bytes=privateBytes(c.originalVerificationPath),original=JSON.parse(bytes);assert(original.sha===SELECTION.current.source&&original.controller===ORIGIN.controller&&original.runId===ORIGIN.runId&&original.fingerprint===ORIGIN.fingerprint,'Actual current original full CI proof required');
 // The original producing record stays immutable. A separate projection names the clean checkout
 // of exactly the SAME source when the former producing worktree has since advanced to other work.
 await imported.revalidateCi({...original,candidatePath:c.frozenCurrent});
 const api=p=>JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/'+p],{encoding:'utf8',timeout:60000,maxBuffer:16*1024**2}));
 const metadata={run:api('actions/runs/'+ORIGIN.runId),artifact:api('actions/artifacts/'+ORIGIN.artifactId),main:api('git/ref/heads/main'),alpha:api('git/ref/heads/alpha')};
 assert(metadata.run.status==='completed'&&metadata.run.conclusion==='success'&&metadata.run.run_attempt===1&&metadata.run.head_sha===SELECTION.current.source&&metadata.artifact.id===ORIGIN.artifactId&&metadata.artifact.digest===ORIGIN.artifactDigest&&!metadata.artifact.expired,'Current authenticated witness/packet differs');
 const value={...ORIGIN,source:SELECTION.current.source,main:metadata.main.object?.sha,alpha:metadata.alpha.object?.sha,metadataSha256:hash(metadata),originalVerificationSha256:hash(bytes),verifiedAt:new Date().toISOString()};validateReauthentication(value,{fresh:true});return {value,metadata,originalProducingRecordUnchanged:true,verificationCheckout:c.frozenCurrent};
}
export async function operate(mode,configPath){
 assert(['inspect','reauthenticate','issue','cleanup'].includes(mode));const c=JSON.parse(privateBytes(configPath));
 const source=c.frozenCurrent,load=name=>import(pathToFileURL(join(source,name)).href),{cleanHead}=await load('.github/ci/release-ci.mjs');
 const frozen=()=>assert(cleanHead(source)===SELECTION.current.source&&cleanHead(resolve(dirname(fileURLToPath(import.meta.url)),'../..'))===c.controller,'Current source or reviewed tool moved');frozen();
 assert(/^[a-f0-9]{40}$/.test(c.controller));assert(realpathSync(dirname(c.out))===dirname(c.out),'Canonical private output parent required');mkdirSync(c.out,{mode:0o700});
 if(mode==='reauthenticate'){const value=await reauthenticate(c);save(join(c.out,'reauthentication.json'),value);frozen();return value.value;}
 const {readLease,guardCommand,guardedRsync,leasePrefix}=await load('scripts/staging/lease.mjs'),lease=readLease(SELECTION.current.source);validateLease({batch:lease.batch,epoch:lease.epoch});
 const {stagingTransport}=await load('.github/ci/staging-transport.mjs'),transport=stagingTransport(source,process.env);
 const ssh=command=>execFileSync('ssh',transport.sshArgs(guardCommand(lease,command)),{encoding:'utf8',timeout:600000,maxBuffer:32*1024**2});
 const imported=await load('scripts/improve/release.ts'),official={...(imported.default??{}),...imported};
 const checksum=()=>execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...guardedRsync(lease,transport.rsyncArgs(official,source))],{encoding:'utf8',timeout:120000,maxBuffer:16*1024**2});
 const observation=privateBytes(c.observationPath);assert(hash(observation)===c.observationSha256,'Independent ROOT current/old-resource observation changed');
 if(mode==='issue'){
  const inspected=JSON.parse(privateBytes(c.inspectionPath)),reauth=JSON.parse(privateBytes(c.reauthenticationPath));assert(hash(reauth.metadata)===reauth.value.metadataSha256&&inspected.observationSha256===c.observationSha256,'Independent raw evidence changed');
  assert(inspected.lease.batch===lease.batch&&inspected.lease.epoch===lease.epoch,'Fresh inspection belongs to another lease');
  const output=checksum(),checkedAt=new Date().toISOString();save(join(c.out,'source-proof.json'),{output,checkedAt,source:SELECTION.current.source});assert(output==='','Actual canonical CURRENT source checksum is dirty');frozen();
  const certificate=issueCertificate({inspection:inspected,reauthentication:reauth.value,controller:c.controller,toolSha256:toolHash(),ownerEvidenceSha256:hash(privateBytes(c.ownerEvidencePath)),sourceProof:{checkedAt,outputSha256:hash(output)},certificateId:randomBytes(32).toString('hex')});save(join(c.out,'certificate.json'),certificate);return certificate;
 }
 for(const path of [c.remoteToolDirectory,c.remoteObservation,...(mode==='cleanup'?[c.remoteCertificate]:[])])assert(typeof path==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(path)&&!path.split('/').some(p=>p==='.'||p==='..'),'Canonical private remote path required');
 const paths=[...TOOL_FILES.map(name=>join(c.remoteToolDirectory,name)),c.remoteObservation],expected=[...TOOL_FILES.map(name=>hash(readFileSync(new URL(name,import.meta.url)))),c.observationSha256];
 if(mode==='cleanup'){paths.push(c.remoteCertificate);expected.push(hash(privateBytes(c.certificatePath)));}
 const hashes=ssh('sha256sum -- '+paths.map(quote).join(' ')).trim().split('\n').map(line=>line.split(/\s+/)[0]);assert(JSON.stringify(hashes)===JSON.stringify(expected),'Actual transferred tool/observation/certificate bytes differ');
 if(mode==='inspect'){
  const value=JSON.parse(ssh('cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx '+quote(join(c.remoteToolDirectory,'superseded-resource-bridge.mjs'))+' '+['inspect',c.controller,c.remoteObservation].map(quote).join(' ')));assert(value.controller===c.controller&&value.toolSha256===toolHash()&&value.observationSha256===c.observationSha256,'Actual full read-only inspection differs');save(join(c.out,'inspection.json'),value);frozen();return value;
 }
 const certificate=JSON.parse(privateBytes(c.certificatePath));validateCertificate(certificate,{controller:c.controller,toolSha256:toolHash(),deleting:true});assert(certificate.ownerEvidenceSha256===hash(privateBytes(c.ownerEvidencePath))&&certificate.lease.batch===lease.batch&&certificate.lease.epoch===lease.epoch,'Scoped owner authority/current lease changed');
 // No outer SH lock: the exact remote Python CLI takes actual Coordinator EX nonblocking.
 const command='cd /opt/ai-hr && '+leasePrefix(lease)+' python3 '+quote(join(c.remoteToolDirectory,'superseded-resource-cleanup.py'))+' '+['cleanup',c.controller,c.remoteObservation,c.remoteCertificate].map(quote).join(' ');
 const result=JSON.parse(execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:900000,maxBuffer:32*1024**2}));save(join(c.out,'remote-purpose-result.json'),result);
 assert(result.kind==='SUPERSEDED_RESOURCES_REMOVED_CURRENT_RUNTIME_VERIFIED'&&result.certificateSha256===hash(certificate)&&result.originalLockReadyAndAuditsPreserved===true&&result.originalOperatorExit===null&&result.originalOperatorPass===false&&result.releaseAuthorized===false&&JSON.stringify(result.verifiedAbsent)===JSON.stringify(['next','packet']),'Actual purpose-only terminal result required');
 const output=checksum();save(join(c.out,'final-source-checksum.json'),{source:SELECTION.current.source,output,checkedAt:new Date().toISOString()});assert(output==='','Final actual CURRENT source checksum differs');validateCertificate(certificate,{controller:c.controller,toolSha256:toolHash()});frozen();
 const completed={...result,currentSourceChecksumEmpty:true,oldNormalSessionUnchanged:true,leaseHandbackStillRootOwned:true};save(join(c.out,'completed-superseded-resources.json'),completed);return completed;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const[mode,configPath]=process.argv.slice(2);operate(mode,configPath).then(value=>process.stdout.write(JSON.stringify(value)+'\n',()=>process.exit(0))).catch(()=>process.stderr.write('Superseded-resource operator refused; preserve originals, partial records and lease.\n',()=>process.exit(1)));
}
