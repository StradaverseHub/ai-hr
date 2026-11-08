/** Actual Node stdio producer; fixed test-only component modes, no CI authority. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
async function main(){
const modes=new Set(['shape','normal','eof','byte','late','foreign','invalid','parent-death']);
assert.equal(process.argv.length,2);assert(modes.has(process.env.IPC_TEST_MODE));
const mode=process.env.IPC_TEST_MODE;
let stopped=false,child;
const stop=()=>{stopped=true;if(child?.stdin)child.stdin.end();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
child=spawn('/usr/bin/python3',['-I','-B',fileURLToPath(new URL('input-probe.py',import.meta.url)),mode],{
 cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',LANG:'C',IPC_TEST_NODE:process.execPath},
 stdio:[mode==='foreign'||mode==='invalid'?0:'pipe',mode==='parent-death'?1:'pipe','pipe']});
let error,callbackError,closed=false,buffer='',stderrBuffer='',lateEnded=false;
const rejectCallback=()=>{callbackError=Error('Fixed input callback refused');if(child.stdin)child.stdin.end();};
child.stdin?.on('error',rejectCallback);
const done=new Promise(resolve=>{child.once('error',value=>{error=value;});child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
child.stderr.on('data',data=>{
 try{
  stderrBuffer+=data.toString('utf8');assert(stderrBuffer.length<=1024);
  if(mode==='parent-death'){
   if(stderrBuffer==='READY\n')process.exit(0);
   assert('READY\n'.startsWith(stderrBuffer));
  }else rejectCallback();
 }catch{rejectCallback();}
});
child.stdout?.on('data',data=>{
 try{
  buffer+=data.toString('utf8');assert(buffer.length<=8192);
  while(buffer.includes('\n')){
   const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1);
   if(line==='WORKER'){
    assert.equal(mode,'late');if(!lateEnded){lateEnded=true;child.stdin.end();}
   }else{
    const packet=JSON.parse(line);assert.notEqual(mode,'parent-death');
    process.stdout.write(JSON.stringify(packet)+'\n');
   }
  }
 }catch{rejectCallback();}
});
if(mode==='eof')child.stdin.end();
if(mode==='byte')child.stdin.write(Buffer.from([1]));
const timer=setTimeout(()=>{if(child.stdin)child.stdin.end();},3000);
try{const result=await done;assert.equal(error,undefined);assert.equal(callbackError,undefined);assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(buffer,'');assert.equal(stopped,false);if(mode==='late')assert.equal(lateEnded,true);}
finally{clearTimeout(timer);if(!closed&&child.stdin)child.stdin.end();process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
main().catch(()=>{process.stderr.write('Fixed Node input producer refused\n');process.exitCode=1;});
