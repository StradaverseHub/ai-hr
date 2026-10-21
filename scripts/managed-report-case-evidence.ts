/** Durable per-case attribution for the owned acceptance fixture, never a release/PASS receipt. */
import {constants,openSync,closeSync,writeFileSync,fsyncSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,normalize} from 'node:path';
import {createHash} from 'node:crypto';
type Binding={candidate:string;runId:string};
export function createManagedReportCaseRecorder(directory:string,binding:Binding){
 if(!/^[a-f0-9]{40}$/.test(binding.candidate)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.runId))throw new Error('Invalid case evidence binding.');
 if(!isAbsolute(directory)||normalize(directory)!==directory||realpathSync(dirname(directory))!==dirname(directory))throw new Error('Case evidence parent must be an exact real directory.');
 const parent=lstatSync(dirname(directory));
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0||parent.uid!==process.getuid?.())throw new Error('Case evidence parent must be private and owned.');
 // Exclusive fresh directory: a retry cannot silently append new outcomes to an older fixture run.
 mkdirSync(directory,{mode:0o700});
 const names=new Set<string>();let sequence=0,previousSha256:string|null=null;
 return (name:string,details:Record<string,unknown>={})=>{
  if(!/^[A-Za-z][A-Za-z0-9-]{0,119}$/.test(name)||names.has(name)||sequence>=200)throw new Error('Case identity is invalid or already recorded.');
  const value={version:1,kind:'owned-managed-report-acceptance-case',candidate:binding.candidate,runId:binding.runId,sequence:sequence+1,previousSha256,name,status:'VERIFIED',completeJourney:false,details};
  const text=JSON.stringify(value)+'\n';if(Buffer.byteLength(text)>65536)throw new Error('Case evidence exceeds bound.');
  const file=join(directory,String(sequence+1).padStart(3,'0')+'-'+name+'.json');
  const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
  const dir=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{fsyncSync(dir);}finally{closeSync(dir);}
  // Advance only after file bytes and its directory entry have reached the durability boundary.
  names.add(name);sequence++;previousSha256=createHash('sha256').update(text).digest('hex');
  return {name,details:(JSON.parse(text) as {details:Record<string,unknown>}).details};
 };
}
