/** Fixed public font prerequisite on a disposable runner; never a test/release PASS. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ubuntuMirrorSource} from './ubuntu-browser-mirror.mjs';
import {mkdirSync,realpathSync,writeFileSync,openSync,fstatSync,readFileSync,readSync,closeSync,constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ubuntuSource='/etc/apt/sources.list.d/ubuntu.sources',ubuntuMirrors='/etc/apt/apt-mirrors.txt';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function decodeUbuntuSourceBytes(raw){
 assert(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=65536,'Bounded Ubuntu source bytes required');
 const text=raw.toString('utf8');
 assert(Buffer.from(text,'utf8').equals(raw),'Exact valid UTF8 Ubuntu source bytes required');
 return text; // Buffer decoding preserves a valid BOM; no normalization or replacement is permitted.
}
const readUbuntuFile=(file,limit)=>{
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const st=fstatSync(fd);assert(st.isFile()&&st.uid===0&&st.size>0&&st.size<=limit,'Bounded regular root-owned Ubuntu file required');
  const buffer=Buffer.alloc(limit+1),count=readSync(fd,buffer,0,buffer.length,0);
  assert(count===st.size&&count>0&&count<=limit,'Ubuntu file changed or exceeded bounded read');return decodeUbuntuSourceBytes(buffer.subarray(0,count));
 }finally{closeSync(fd);}
};
// Read-only diagnostic allowlist; it does not grant the URI validator any new mutable source.
const endpointDiagnostic=value=>{
 try{
  const url=new URL(value),host=url.hostname;
  const official=['azure.archive.ubuntu.com','archive.ubuntu.com','security.ubuntu.com'].includes(host)
   ||/^[a-z0-9-]+\.ec2\.archive\.ubuntu\.com$/.test(host);
  if(!official||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||url.search||url.hash
   ||!['/ubuntu','/ubuntu/'].includes(url.pathname))throw Error('Redacted endpoint');
  return {url:url.href};
 }catch{return {redacted:true,sha256:sha(value)};}
};
export function ubuntuFontTransportDiagnostic(source,mirrors){
 const sourceUris=source.split('\n').filter(line=>/^URIs:/.test(line)).map(line=>line.slice(5).trim());
 const diagnostic={sourceUriCount:sourceUris.length,sourceUris:sourceUris.slice(0,16).map(value=>
  value==='mirror+file:/etc/apt/apt-mirrors.txt'?{reference:'fixed-runner-mirror-list'}:endpointDiagnostic(value))};
 if(mirrors!==undefined){
  const rows=mirrors.split('\n').map(line=>line.trim()).filter(Boolean);
  diagnostic.mirrorList={sha256:sha(mirrors),rowCount:rows.length,truncated:rows.length>16,rows:rows.slice(0,16).map(line=>{
   const fields=line.split(/\s+/),priority=/^priority:([1-9]\d{0,2})$/.exec(fields[1]??'');
   if(fields.length!==2||!priority||Number(priority[1])>100)return {redacted:true,sha256:sha(line)};
   return {...endpointDiagnostic(fields[0]),priority:Number(priority[1])};
  })};
 }
 return diagnostic;
}
const writeUbuntuSource=text=>{
 const started=Date.now(),r=spawnSync('sudo',['-n','tee',ubuntuSource],{input:text,encoding:'utf8',
  stdio:['pipe','ignore','pipe'],timeout:10000,killSignal:'SIGKILL',maxBuffer:16384});
 return {status:r.status,errorCode:r.error?.code??null,signal:r.signal??null,elapsedMs:Date.now()-started,
  stderr:r.stderr??''}; // tee stdout/input contain source bytes: never retain either.
};
/** The existing URI validator owns every allowed archive/key/suite/component decision. */
export function configureFixedNotoTransport({read=readUbuntuFile,write=writeUbuntuSource,onStep=()=>{}}={}){
 const proof={kind:'FIXED_NOTO_EXISTING_UBUNTU_TRANSPORT_NOT_TEST_PASS',phase:'read-source',write:null,releaseAuthorized:false};
 try{
  const before=read(ubuntuSource,65536);proof.beforeSha256=sha(before);
  const mirrors=before.includes('mirror+file:/etc/apt/apt-mirrors.txt')?read(ubuntuMirrors,4096):undefined;
  proof.diagnostic=ubuntuFontTransportDiagnostic(before,mirrors);
  proof.phase='validate-source';
  const selected=ubuntuMirrorSource(before,'primary-https',mirrors);Object.assign(proof,selected.proof,{kind:'FIXED_NOTO_EXISTING_UBUNTU_TRANSPORT_NOT_TEST_PASS'});
  assert.equal(read(ubuntuSource,65536),before,'Ubuntu source changed before fixed transport write');
  proof.phase='write-source';
  const result=write(selected.text);assert(result&&typeof result==='object','Ubuntu source write result required');
  // No raw sources, mirror-list text, command input or tee stdout enters the evidence.
  proof.write={file:'sudo',args:['-n','tee',ubuntuSource],status:result.status,errorCode:result.errorCode??null,
   signal:result.signal??null,elapsedMs:result.elapsedMs??0,stderr:String(result.stderr??'').slice(-8192)};
  onStep(proof);
  assert(proof.write.status===0&&!proof.write.errorCode&&!proof.write.signal,'Fixed Ubuntu transport write failed');
  proof.phase='verify-after';
  const after=read(ubuntuSource,65536);assert.equal(after,selected.text,'Applied Ubuntu source bytes differ');
  assert.equal(sha(after),proof.afterSha256,'Applied Ubuntu source hash differs');
  return {...proof,phase:'verified',afterBytesVerified:true};
 }catch{
  // Pure validator assertion messages may include rejected source text: keep them private to memory.
  const failure=new Error('Fixed Ubuntu transport validation/write refused');failure.fontTransportProof=proof;throw failure;
 }
}

const commandSeconds=120,cleanupSeconds=5,transportMs=128000;
const packages=Object.freeze(['fonts-noto-core','fonts-noto-cjk']);
const aptOptions=Object.freeze(['-o','Acquire::Retries=0','-o','Acquire::http::Timeout=20',
 '-o','Acquire::https::Timeout=20','-o','DPkg::Lock::Timeout=15','-o','APT::Update::Error-Mode=any']);
const command=operation=>['-n','timeout','--signal=TERM',`--kill-after=${cleanupSeconds}s`,`${commandSeconds}s`,
 'env','DEBIAN_FRONTEND=noninteractive','apt-get',...aptOptions,...(operation==='install'
 ?['install','-y','--no-install-recommends',...packages]:['update','-qq'])];
const execute=(file,args,timeout)=>{
 const start=Date.now(),r=spawnSync(file,args,{encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:1024**2});
 return {status:r.status,errorCode:r.error?.code??null,signal:r.signal??null,
  stdout:r.stdout??'',stderr:r.stderr??'',elapsedMs:Date.now()-start};
};
/** Injected command boundary is for pure controls only, never a caller-selected package or duration. */
export function bootstrapFixedNoto({run=execute,onStep=()=>{}}={}){
 const steps=[],start=Date.now();
 const invoke=phase=>{
  const operation=phase==='refresh-indexes'?'update':'install',args=command(operation);
  const r=run('sudo',args,transportMs);
  assert(r&&typeof r==='object','Font prerequisite command result object required');
  const row={phase,file:'sudo',args,status:r.status,errorCode:r.errorCode??null,signal:r.signal??null,
   elapsedMs:r.elapsedMs??0,stdout:String(r.stdout??'').slice(-8192),stderr:String(r.stderr??'').slice(-8192)};
  steps.push(row);onStep(row);
  assert(Number.isInteger(row.status)&&row.status>=0&&row.status<=255,'Completed font prerequisite exit status required');
  // An outer transport/timeout/forced-kill result cannot establish clean package-manager completion.
  // Refuse rather than start another privileged APT process against uncertain state.
  assert(!row.errorCode&&!row.signal&&[0,100].includes(row.status),'Known completed APT success/error required; wrapper or cleanup outcome is uncertain');
  return row.status===0;
 };
 try{
  const initialInstalled=invoke('install-existing-indexes');
  let refreshed=false;
  if(!initialInstalled){
   assert(invoke('refresh-indexes'),'Required font index refresh failed');refreshed=true;
   assert(invoke('install-after-refresh'),'Required font installation retry failed');
  }
  return {kind:'FIXED_NOTO_BOOTSTRAP_NOT_TEST_OR_RELEASE_PASS',packages:[...packages],steps,indexesRefreshed:refreshed,
   commandBudgetSeconds:commandSeconds,maxCommands:3,aggregateCommandBudgetSeconds:360,
   perCommandCleanupSeconds:cleanupSeconds,elapsedMs:Date.now()-start,releaseAuthorized:false};
 }catch(error){error.fontSetupSteps=steps;throw error;}
}
export function assertFixedNotoRunner(e,platform){
 assert(platform==='linux'&&e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'
  &&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&e.GITHUB_REPOSITORY_ID==='1333414856','Disposable repository runner only');
 assert(/^[a-f0-9]{40}$/.test(e.AIHR_CI_HEAD??'')&&/^[a-f0-9]{40}$/.test(e.AIHR_CI_CONTROL_HEAD??''),'Exact font prerequisite source/controller required');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assertFixedNotoRunner(process.env,process.platform);
 assert(process.argv.length===3,'One fixed font evidence output required');
 const temp=realpathSync(process.env.RUNNER_TEMP),output=resolve(process.argv[2]);
 assert([join(temp,'aihr-focused/noto-font-setup.json'),join(temp,'aihr-ci/noto-font-setup.json')].includes(output),'Fixed owned font evidence path required');
 mkdirSync(dirname(output),{recursive:true});assert(realpathSync(dirname(output))===dirname(output),'Font evidence symlink refused');
 const binding={candidate:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD};
 let transport;
 try{
  transport=configureFixedNotoTransport({onStep:proof=>console.log('NOTO_BOOTSTRAP_TRANSPORT '+JSON.stringify(proof))});
  const result=bootstrapFixedNoto({onStep:row=>console.log('NOTO_BOOTSTRAP_PHASE '+JSON.stringify(row))});
  writeFileSync(output,JSON.stringify({...result,...binding,transport},null,2)+'\n',{flag:'wx',mode:0o600});
 }catch(error){
  writeFileSync(output,JSON.stringify({kind:'FAILED_FIXED_NOTO_BOOTSTRAP_NOT_TEST_PASS',...binding,
   error:String(error),steps:error.fontSetupSteps??[],transport:error.fontTransportProof??transport??null,releaseAuthorized:false},null,2)+'\n',{flag:'wx',mode:0o600});throw error;
 }
}
