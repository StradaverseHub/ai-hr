/** Eight real Node→Python component intentions; never application/CI acceptance. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const source=name=>fileURLToPath(new URL(name,import.meta.url));
function native(pid){const raw=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);assert(!['Z','X','x'].includes(fields[0]));return`${pid}:${fields[19]}`;}
export function validateNativeInputObservations(mode,packets){
 const settled=mode=>[{kind:'settled',mode,completed:mode==='normal',workStarted:mode==='normal'||mode==='late',reaped:true,quiescent:true,escaped:false,handlerRestored:true}];
 const expected={shape:[{kind:'shape',socket:true,fifo:false,anonymousUnixStream:true,nativePeerIsLiveParent:true,stableDescriptor:true}],
  normal:settled('normal'),eof:settled('eof'),byte:settled('byte'),late:settled('late'),
  foreign:[{kind:'refused',reason:'socket-peer',workStarted:false}],
  'parent-death':[{kind:'parent-ready'},{kind:'parent-refused',workStarted:false,childrenAbsent:true}]};
 const invalid=new Set(['descriptor-kind','socket-domain','socket-type','socket-listener','socket-address','socket-connected']);
 if(typeof mode==='string'&&mode.startsWith('invalid:')){
  const reason=mode.slice(8);assert(invalid.has(reason));assert.deepEqual(packets,[{kind:'refused',reason,workStarted:false}]);
 }else{assert(Object.hasOwn(expected,mode));assert.deepEqual(packets,expected[mode]);}
 return true;
}
export function nativeInputFailureObservation(mode,text){
 assert(['shape','normal','eof','byte','late','foreign','invalid','parent-death'].includes(mode));
 const allowed=new Set(['descriptor-kind','socket-domain','socket-type','socket-listener','socket-address','socket-connected','socket-peer','native-platform','parent-metadata','parent-live','parent-identity','parent-credentials','parent-executable','parent-cwd','parent-argv','parent-entry','parent-source','descriptor-changed','socket-changed']);
 let reason='unavailable';
 try{
  assert(typeof text==='string'&&text.length<=16384);
  const lines=text.trimEnd().split('\n');assert.equal(lines.length,1);
  const value=JSON.parse(lines[0]);assert.deepEqual(Object.keys(value).sort(),['kind','reason','workStarted']);
  assert.equal(value.kind,'refused');assert.equal(value.workStarted,false);assert(allowed.has(value.reason));reason=value.reason;
 }catch{}
 return{kind:'UNAUTHENTICATED_NATIVE_INPUT_CONTROL_FAILURE',mode,reason};
}
export async function verifyNativeInputControls(){
 assert.equal(process.platform,'linux');
 const jobs=[];let stopping=false,timedOut=false,failedRow;
 // Synchronously register every direct handle and CLOSE before any await.
 function start(argv,mode){
  assert.equal(stopping,false);
  const child=spawn(argv[0],argv.slice(1),{cwd:resolve('.'),env:{PATH:'/usr/bin:/bin',LANG:'C',IPC_TEST_MODE:mode},stdio:['ignore','pipe','pipe']});
  const row={child,mode,closed:false,error:undefined,stdout:'',stderr:'',done:null};jobs.push(row);
  row.done=new Promise(resolve=>{child.once('error',error=>{row.error=error;});child.once('close',(code,signal)=>{row.closed=true;resolve({code,signal});});});
  child.stdout.on('data',data=>{row.stdout+=data.toString('utf8');if(row.stdout.length>16384)stop();});
  child.stderr.on('data',data=>{row.stderr+=data.toString('utf8');if(row.stderr.length>1024)stop();});
  return row;
 }
 function stop(){stopping=true;for(const row of jobs)if(!row.closed)row.child.kill('SIGTERM');}
 const parent=mode=>start([process.execPath,source('input-parent.mjs')],mode);
 const descriptor=kind=>start(['/usr/bin/python3','-I','-B',source('input-descriptor.py'),kind,process.execPath],kind==='foreign'?'foreign':'invalid');
 const sentinel=start([process.execPath,'-e',"process.stdout.write('READY\\n');setInterval(()=>{},1000)"],'shape');
 let sentinelIdentity;
 const timer=setTimeout(()=>{timedOut=true;stop();},10000);
 let primary;
 try{
  await new Promise((resolve,reject)=>{let text='';const accept=data=>{text+=data.toString('utf8');if(text==='READY\n')resolve();else if(text.length>32)reject(Error('Foreign control refused'));};sentinel.child.stdout.on('data',accept);sentinel.child.once('error',()=>reject(Error('Foreign control unavailable')));});
  sentinelIdentity=native(sentinel.child.pid);
  const shape=parent('shape'),normal=parent('normal'),eof=parent('eof'),byte=parent('byte'),late=parent('late'),foreign=descriptor('foreign'),death=parent('parent-death');
  const kinds={regular:'descriptor-kind',fifo:'descriptor-kind',tty:'descriptor-kind',tcp:'socket-domain',datagram:'socket-type',seqpacket:'socket-type',named:'socket-address',abstract:'socket-address',listener:'socket-listener',disconnected:'socket-connected'};
  const bad=Object.entries(kinds).map(([kind,reason])=>({row:descriptor(kind),reason}));
  const controls=[shape,normal,eof,byte,late,foreign,death,...bad.map(({row})=>row)];
  await Promise.all(controls.map(async row=>{try{const result=await row.done;assert.equal(row.error,undefined);assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(row.stderr,'');}catch(error){failedRow??=row;throw error;}}));
  const packets=row=>row.stdout.trimEnd().split('\n').map(line=>JSON.parse(line));
  for(const[mode,row]of [['shape',shape],['normal',normal],['eof',eof],['byte',byte],['late',late],['foreign',foreign],['parent-death',death]])validateNativeInputObservations(mode,packets(row));
  for(const{row,reason}of bad)validateNativeInputObservations('invalid:'+reason,packets(row));
  assert.equal(native(sentinel.child.pid),sentinelIdentity);assert.equal(timedOut,false);
 }catch(error){primary=error;}
 finally{
  clearTimeout(timer);stop();
  // The fixed producers handle TERM by EOF and wait actual Python CLOSE. The
  // deliberate parent-death probe has no worker and keeps stdout until it exits.
  const settled=await Promise.allSettled(jobs.map(row=>row.done));
  const failures=settled.filter(row=>row.status==='rejected').map(row=>row.reason);
  if(failures.length)primary=primary?new AggregateError([primary,...failures],'Native input controls refused'):new AggregateError(failures,'Native input controls refused');
 }
 if(primary){if(failedRow)process.stderr.write(JSON.stringify(nativeInputFailureObservation(failedRow.mode,failedRow.stdout))+'\n');throw primary;}
 return 8;
}
if(process.argv[1]&&resolve(process.argv[1])===source('input-controls.mjs')){
 try{assert.equal(process.argv.length,2);assert.equal(await verifyNativeInputControls(),8);process.stdout.write('Original replay native input controls complete:8\n');}
 catch{process.stderr.write('Original replay native input controls refused\n');process.exitCode=1;}
}
