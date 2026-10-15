import { spawn,execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { evidenceFileMaxBytes } from './evidence-file-model';
export const evidenceTextStatus=z.enum(['ok','no_text','unsupported','too_big','unreadable','unread','retry']);
export type EvidenceText={status:z.infer<typeof evidenceTextStatus>;text:string;method:'local'|'vision'|null};
const outputSchema=z.object({status:evidenceTextStatus,text:z.string().max(13000)}).strict();
export const evidenceTextMax=6000,evidenceCaseMax=16000;
const failure=(status:EvidenceText['status']):EvidenceText=>({status,text:'',method:'local'});
export const evidenceExtension=(name:string)=>name.includes('.')?name.split('.').pop()!.toLowerCase():'';
/** Only a parser process sees untrusted documents: 12s wall, 10s CPU, bounded V8 heap and a 768MiB RSS watchdog. */
export async function extractEvidenceText(fileName:string,bytes:Uint8Array):Promise<EvidenceText>{
 const ext=evidenceExtension(fileName);
 if(!['pdf','docx','xlsx','csv','txt'].includes(ext))return failure('unsupported');
 if(!bytes.length)return failure('no_text');if(bytes.length>evidenceFileMaxBytes)return failure('too_big');
 return new Promise(resolve=>{
  const child=spawn('/bin/sh',['-c','ulimit -t 10; exec "$@"','performance-evidence',process.execPath,'--max-old-space-size=512','--max-semi-space-size=16',join(process.cwd(),'packs/performance/onehr/evidence-extractor.cjs'),ext],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV,LANG:'en_US.UTF-8',TZ:'UTC'}});
  let settled=false,output='',killed=false,checking=false;
  const finish=(value:EvidenceText)=>{if(settled)return;settled=true;clearTimeout(wall);clearInterval(memory);resolve(value);};
  const kill=()=>{killed=true;child.kill('SIGKILL');};
  const wall=setTimeout(kill,12000);
  const memory=setInterval(async()=>{
   if(checking||settled||!child.pid)return;checking=true;
   try{
    let kb:number;
    if(process.platform==='linux'){const status=await readFile(`/proc/${child.pid}/status`,'utf8');kb=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0);}
    else if(process.platform==='darwin')kb=await new Promise<number>((done,reject)=>execFile('/bin/ps',['-o','rss=','-p',String(child.pid)],{timeout:500},(error,stdout)=>error?reject(error):done(Number(stdout.trim()))));
    else {kill();return;}
    if(kb>768*1024)kill();
   }catch{if(child.exitCode===null&&child.signalCode===null)kill();}finally{checking=false;}
  },100);
  child.stdout.setEncoding('utf8');child.stdout.on('data',(data:string)=>{output+=data;if(Buffer.byteLength(output)>32000)kill();});
  child.stderr.resume();child.on('error',()=>finish(failure('unreadable')));
  child.on('close',(code,signal)=>{
   if(killed||signal||code!==0){finish(failure('too_big'));return;}
   try{const result=outputSchema.parse(JSON.parse(output));finish({status:result.status,text:result.status==='ok'?Array.from(result.text).slice(0,evidenceTextMax+80).join(''):'',method:'local'});}catch{finish(failure('unreadable'));}
  });
  child.stdin.on('error',()=>{});child.stdin.end(bytes);
 });
}
