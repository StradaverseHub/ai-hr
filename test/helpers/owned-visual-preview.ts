/** A loopback-only disposable preview. Signals require the exact detached leader's kernel start time. */
import {spawn,type ChildProcess} from 'node:child_process';
import {createWriteStream,readFileSync,type WriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {finished} from 'node:stream/promises';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

export class OwnedVisualPreview{
 private child:ChildProcess|undefined;
 private closed=false;
 private failed=false;
 private startTicks:string|undefined;
 private readonly log:WriteStream;
 private logFailed=false;
 constructor(readonly origin:string,logPath:string,private signal:AbortSignal,private readonly evidenceDir:string){
  const url=new URL(origin);
  if(process.platform!=='linux'||!['localhost','127.0.0.1'].includes(url.hostname)||url.protocol!=='http:')throw Error('Visual preview requires a Linux loopback fixture');
  this.log=createWriteStream(logPath);this.log.once('error',()=>{this.logFailed=true;});
 }
 private identity(child:ChildProcess){
  const pid=child.pid;if(!pid||child!==this.child||this.closed||this.failed||child.exitCode!==null||child.signalCode!==null)return;
  let stat:string;try{stat=readFileSync(`/proc/${pid}/stat`,'utf8');}catch{return;}
  const end=stat.lastIndexOf(') '),fields=stat.slice(end+2).trim().split(/\s+/);
  if(end<0||!stat.startsWith(`${pid} (`)||fields[1]!==String(process.pid)||fields[2]!==String(pid)||fields[3]!==String(pid)||!/^\d+$/.test(fields[19]??''))return;
  return fields[19];
 }
 private group(pid:number,signal:0|'SIGTERM'|'SIGKILL'){
  try{process.kill(-pid,signal);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}
 }
 async start(){
  this.signal.throwIfAborted();
  if(this.child&&!this.closed)throw Error('Previous visual preview is still running');
  this.closed=false;this.failed=false;this.startTicks=undefined;
  const url=new URL(this.origin);
  this.child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname',url.hostname,'--port',url.port],{
   detached:true,cwd:process.cwd(),env:{...process.env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',AUTH_PROVIDER:'workos',ALLOW_DEMO_SESSION:'true',DEV_USER_ID:'',DATABASE_URL:process.env.TEST_DATABASE_URL!,MIGRATION_DATABASE_URL:process.env.TEST_MIGRATION_DATABASE_URL!,NEXT_WEBPACK_PARALLELISM:'1',NODE_OPTIONS:`--max-old-space-size=12288 --require ${resolve('test/helpers/heap-peak-preload.cjs')}`,AIHR_HEAP_PEAK_DIR:resolve(this.evidenceDir,'operational-preview-heap')},stdio:['ignore','pipe','pipe']});
  const child=this.child;
  child.once('spawn',()=>{this.startTicks=this.identity(child);});child.once('close',()=>{this.closed=true;});child.once('error',()=>{this.failed=true;});
  child.stdout?.pipe(this.log,{end:false});child.stderr?.pipe(this.log,{end:false});
  const deadline=performance.now()+120000;
  while(performance.now()<deadline){
   this.signal.throwIfAborted();if(this.failed||this.closed)throw Error('Visual preview stopped before readiness');
   try{const response=await fetch(this.origin+'/login',{signal:AbortSignal.timeout(2000)});if(response.ok)return;}catch{}
   await delay(500);
  }
  throw Error('Visual preview readiness deadline exceeded');
 }
 async stop(){
  const child=this.child;if(!child)return;
  const pid=child.pid;if(!pid&&!this.failed)throw Error('Visual preview process identity unavailable');
  const deadline=performance.now()+20000;
  const signalOwned=(signal:'SIGTERM'|'SIGKILL')=>{if(!pid||!this.startTicks||this.identity(child)!==this.startTicks)return false;return this.group(pid,signal);};
  let present=pid?this.group(pid,0):false;
  const term=present&&signalOwned('SIGTERM'),termEnd=performance.now()+5000;
  let escalated=false;
  while(present||!this.closed){
   if(performance.now()>=deadline)throw Error('Visual preview owned cleanup deadline exceeded');
   await delay(100);present=pid?this.group(pid,0):false;
   if(present&&term&&!escalated&&performance.now()>=termEnd){escalated=true;signalOwned('SIGKILL');}
  }
 }
 async close(){
  await this.stop();const drained=finished(this.log,{cleanup:true});this.log.end();await drained;
  if(this.logFailed)throw Error('Visual preview log write failed');
 }
}
