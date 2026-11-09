/** Test-only kernel-bound direct-child signal capability; never a numeric-PID kill fallback. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,readSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';

export const PIDFD_BOUND='BOUND\n',PIDFD_SIGNALLED='SIGNALLED\n';
const COMPLETE_PROTOCOL=PIDFD_BOUND+PIDFD_SIGNALLED;
const MAX_PROTOCOL_BYTES=Buffer.byteLength(COMPLETE_PROTOCOL,'ascii');
export function pidfdOutput(previous:string,chunk:Buffer,killSent:boolean){
 assert(Buffer.byteLength(previous,'latin1')+chunk.length<=MAX_PROTOCOL_BYTES,'Owned child pidfd output bound');
 const value=previous+chunk.toString('latin1');
 assert(COMPLETE_PROTOCOL.startsWith(value)&&(!value.includes('SIGNALLED')||killSent),'Owned child pidfd protocol differs');
 return value;
}

export function directChildIdentity(pid:number){
 assert(Number.isSafeInteger(pid)&&pid>1);
 const descriptor=openSync('/proc/'+pid+'/stat','r');let raw:string;
 try{const buffer=Buffer.alloc(4097),length=readSync(descriptor,buffer,0,buffer.length,0);assert(length>0&&length<=4096);raw=buffer.subarray(0,length).toString('ascii');}
 finally{closeSync(descriptor);}
 assert(raw.startsWith(pid+' ('));
 const offset=raw.lastIndexOf(') ');assert(offset>0);
 const values=raw.slice(offset+2).trim().split(/\s+/);assert(values.length>=20);
 for(const index of [1,2,3,19])assert(/^[0-9]+$/.test(values[index]));
 assert.equal(Number(values[1]),process.pid);assert.equal(Number(values[2]),pid);assert.equal(Number(values[3]),pid);
 return{pid,parent:process.pid,start:values[19]};
}
export function holdChildPidfd(pid:number){
 const identity=directChildIdentity(pid);
 const helper=spawn('/usr/bin/python3',['-I','-B',resolve('test/helpers/attendance-bridge-pidfd.py'),String(pid),String(identity.parent),identity.start],
  {env:{PATH:'/usr/bin:/bin',LANG:'C',NODE_ENV:'test'},stdio:['pipe','pipe','pipe']});
 let output='',bound=false,killSent=false,closed=false,protocolBroken=false,resolveBound!:()=>void,rejectBound!:(error:Error)=>void;
 const ready=new Promise<void>((yes,no)=>{resolveBound=yes;rejectBound=no;});void ready.catch(()=>undefined);
 const exited=new Promise<void>((yes,no)=>{
  helper.once('error',()=>{rejectBound(Error('Owned child pidfd helper refused'));});
  helper.stdout.on('data',(chunk:Buffer)=>{
   try{output=pidfdOutput(output,chunk,killSent);}
   catch{protocolBroken=true;rejectBound(Error('Owned child pidfd protocol differs'));helper.stdin.end();return;}
   if(output.startsWith(PIDFD_BOUND)&&!bound){bound=true;resolveBound();}
  });
  helper.stderr.on('data',()=>{protocolBroken=true;rejectBound(Error('Owned child pidfd helper refused'));});
  helper.stdin.on('error',()=>{protocolBroken=true;rejectBound(Error('Owned child pidfd pipe refused'));});
  helper.once('close',(code,signal)=>{closed=true;const valid=code===0&&signal===null&&bound&&!protocolBroken&&output===(killSent?COMPLETE_PROTOCOL:PIDFD_BOUND);
   if(valid)yes();else{const error=Error('Owned child pidfd closure refused');rejectBound(error);no(error);}});
 });void exited.catch(()=>undefined);
 const timer=setTimeout(()=>{rejectBound(Error('Owned child pidfd startup deadline'));helper.stdin.end();},2000);
 void ready.then(()=>clearTimeout(timer),()=>clearTimeout(timer));
 return{ready,kill:()=>{
  if(killSent)return; // One request only; close() still requires its actual acknowledgement/exit.
  assert(bound&&!closed,'Owned child pidfd is not bound');
  killSent=true;helper.stdin.end('KILL\n');
 },close:async()=>{if(!killSent&&!closed)helper.stdin.end();await exited;}};
}
