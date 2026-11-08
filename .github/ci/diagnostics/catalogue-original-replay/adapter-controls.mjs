/** Actual Linux callback controls only. No API, dependency or capture imports. */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export async function verifyAdapterControls(){
 assert.equal(process.platform,'linux');
 const sentinel=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.stdout.write('READY\\n')"],{env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe']});
 let childError,closed=false,timer;
 const done=new Promise(resolve=>{sentinel.once('error',error=>{childError=error;});sentinel.once('close',()=>{closed=true;resolve();});});
 try{
  await new Promise((resolve,reject)=>{
   let text='';sentinel.stdout.on('data',data=>{text+=data.toString('utf8');if(text==='READY\n')resolve();else if(text.length>64)reject(Error('Fixed foreign sentinel refused'));});
   sentinel.stderr.on('data',()=>{});sentinel.once('error',()=>reject(Error('Fixed foreign sentinel unavailable')));
   timer=setTimeout(()=>reject(Error('Fixed foreign sentinel admission expired')),2000);
  });clearTimeout(timer);assert.equal(childError,undefined);assert(Number.isSafeInteger(sentinel.pid)&&sentinel.pid>0);
  const result=spawnSync('/usr/bin/python3',['-I','-B',fileURLToPath(new URL('adapter.test.py',import.meta.url)),'-v'],{env:{PATH:'/usr/bin:/bin',LANG:'C',AIHR_REPLAY_TEST_FOREIGN_PID:String(sentinel.pid)},encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0);assert.equal(result.stdout,'');assert.match(result.stderr,/Ran 6 tests in [0-9.]+s\n\nOK\n$/);
  return 6;
 }finally{clearTimeout(timer);if(!closed)sentinel.kill('SIGTERM');await done;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{assert.equal(process.argv.length,2);await verifyAdapterControls();process.stdout.write('Original replay Linux controls complete:6\n');}
 catch{process.stderr.write('Original replay Linux controls refused\n');process.exitCode=1;}
}
