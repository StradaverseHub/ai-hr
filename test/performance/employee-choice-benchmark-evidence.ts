/** Owned progress/partial-capture files only. These are NOT authenticated PASS receipts. */
import {createHash} from 'node:crypto';
import {writeFileSync,readFileSync,renameSync,lstatSync,realpathSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
type Binding={source:string;controller:string;run:string;attempt:string};
type Cut={phase:string;pid:number;container:string;containerId:string;startedAt:string};
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export function employeeChoiceBenchmarkEvidence(directory:string,binding:Binding){
 const folder=lstatSync(directory);if(!folder.isDirectory()||folder.isSymbolicLink()||folder.uid!==process.getuid!()||realpathSync(directory)!==directory)throw Error('Owned evidence directory required');
 if(!/^[a-f0-9]{40}$/.test(binding.source)||!/^[a-f0-9]{40}$/.test(binding.controller)||!/^\d{1,16}$/.test(binding.run)||binding.attempt!=='1')throw Error('Exact hosted diagnostic source binding required');
 const progress=join(directory,'benchmark-progress.jsonl'),metadata=join(directory,'native-plan-latest.json');
 writeFileSync(progress,'',{flag:'wx',mode:0o600});let lines=0,bytes=0,cut=0,current:(Cut&{sha256:string;bytes:number;cut:number;file:string})|undefined;
 const append=(event:Record<string,unknown>)=>{
  const line=JSON.stringify({...event,...binding,developmentOnly:true,releaseAuthorized:false})+'\n';
  if(++lines>2048||(bytes+=Buffer.byteLength(line))>2*1024*1024)throw Error('Bounded benchmark progress exceeded');writeFileSync(progress,line,{flag:'a',mode:0o600});
 };
 const owned=(path:string)=>{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid!())throw Error('Owned evidence file identity required');};
 const currentBytes=()=>{
  if(!current)throw Error('No actual complete raw cut retained');const path=join(directory,current.file);owned(path);owned(metadata);
  const raw=readFileSync(path),meta=JSON.parse(readFileSync(metadata,'utf8'));
  if(sha(raw)!==current.sha256||meta.sha256!==current.sha256||meta.file!==current.file||meta.source!==binding.source||meta.run!==binding.run)throw Error('Previous retained raw cut identity drifted');return raw;
 };
 const capture=(raw:string,identity:Cut)=>{
  if(!Number.isSafeInteger(identity.pid)||identity.pid<=0||identity.phase.length>160||!/^[a-f0-9]{64}$/.test(identity.containerId)||!/^aihr-ci-[a-zA-Z0-9-]+$/.test(identity.container)||!Number.isFinite(Date.parse(identity.startedAt)))throw Error('Bounded actual capture identity required');
  const size=Buffer.byteLength(raw);if(size>64*1024*1024)throw Error('Native plan cut exceeds64MiB');
  if(current)currentBytes();else if(existsSync(metadata))throw Error('Foreign raw evidence cut exists');
  const next={...identity,sha256:sha(raw),bytes:size,cut:++cut,file:'native-plan-cut-'+cut+'.log'},rawPath=join(directory,next.file),metaTemp=join(directory,'native-plan-meta.pending'),previous=current;
  const detail={kind:'ACTUAL_RETAINED_PROGRESS_CUT_NOT_RELEASE',...binding,...next,fullMatrixVerified:false,releaseAuthorized:false,supersedesPriorProgressPayload:current!==undefined,priorPayloadRetained:false};
  let committed=false,rawCreated=false,metadataCreated=false;
  try{
   writeFileSync(rawPath,raw,{flag:'wx',mode:0o600});rawCreated=true;
   writeFileSync(metaTemp,JSON.stringify(detail,null,2)+'\n',{flag:'wx',mode:0o600});metadataCreated=true;
   // One atomic pointer publication commits bytes AND metadata. Until it succeeds,
   // the complete previous cut remains intact. At most two growing raw cuts exist.
   renameSync(metaTemp,metadata);current=next;committed=true;
  }finally{
   if(metadataCreated&&existsSync(metaTemp)){owned(metaTemp);unlinkSync(metaTemp);}
   if(rawCreated&&!committed&&existsSync(rawPath)){owned(rawPath);if(sha(readFileSync(rawPath))!==next.sha256)throw Error('Unpublished raw cut drifted');unlinkSync(rawPath);}
  }
  if(previous){currentBytes();const old=join(directory,previous.file);owned(old);if(sha(readFileSync(old))!==previous.sha256)throw Error('Superseded progress cut drifted');unlinkSync(old);}
  append({kind:'native-cut-retained',...next,supersededProgressPayloadsAreNotRetained:true});return next;
 };
 const retainFinal=()=>{
  const raw=currentBytes();if(!current)throw Error('No actual complete raw cut retained');
  const final=join(directory,'native-auto-explain.log');writeFileSync(final,raw,{flag:'wx',mode:0o600});
  append({kind:'final-raw-retained',...current,fullMatrixVerified:false});return{...current,file:'native-auto-explain.log'};
 };
 return{append,capture,retainFinal,latest:()=>current?{...current}:null};
}
