/** Diagnostic phase observations ONLY. These records confer no authentication. */
import assert from 'node:assert/strict';
import {constants,openSync,writeSync,closeSync,lstatSync,fstatSync,readSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
export const PROGRESS_STAGES=Object.freeze({
 adapter:Object.freeze(['environment','paths','dependencies','launch','kernel-settlement']),
 worker:Object.freeze(['entry','source','environment','artifacts','plan-member','plan-import','plan-reconstruction','verifier-import','comparator-import','baseline-unit','baseline-members','oid-shift-unit','oid-shift-members','commission','canonical-comparison','result','clean-source','publication'])
});
const statuses=['entered','complete','refused'];
export const CHILD_OUTCOMES=Object.freeze(['not-observed','spawn-error','expired','oversize','signal','exit-zero','exit-nonzero']);
function record(role,stage,status){
 assert(Object.hasOwn(PROGRESS_STAGES,role)&&PROGRESS_STAGES[role].includes(stage)&&statuses.includes(status));
 return{kind:'ORIGINAL_REPLAY_PHASE_OBSERVATION',role,stage,status};
}
/** Best effort: IO refusal cannot replace the primary comparison outcome. */
export function comparisonProgress(role,root){
 assert(Object.hasOwn(PROGRESS_STAGES,role));let fd,current,failed=false,closed=false;
 try{const info=lstatSync(root);assert(realpathSync(root)===root&&info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.mode&0o777)===0o700);fd=openSync(join(root,role+'-progress.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch{failed=true;}
 function emit(stage,status){if(failed||closed)return;try{const bytes=Buffer.from(JSON.stringify(record(role,stage,status))+'\n');assert.equal(writeSync(fd,bytes),bytes.length);}catch{failed=true;}}
 return{
  next(stage){assert(PROGRESS_STAGES[role].includes(stage));if(current)emit(current,'complete');current=stage;emit(stage,'entered');},
  finish(status){assert(['complete','refused'].includes(status));if(closed)return;if(current)emit(current,status);closed=true;if(fd!==undefined)try{closeSync(fd);}catch{failed=true;}}
 };
}
export function decodeProgress(role,bytes){
 assert(Object.hasOwn(PROGRESS_STAGES,role)&&Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=16384);
 const text=bytes.toString('utf8');assert(Buffer.from(text).equals(bytes)&&text.endsWith('\n'));
 const rows=text.slice(0,-1).split('\n').map(line=>{const row=JSON.parse(line);assert.equal(JSON.stringify(row),line);return row;});assert(rows.length<=2*PROGRESS_STAGES[role].length);
 let index=0,active=false,last;
 for(const row of rows){
  assert.deepEqual(Object.keys(row).sort(),['kind','role','stage','status']);assert.deepEqual(row,record(role,row.stage,row.status));
  assert.equal(row.stage,PROGRESS_STAGES[role][index]);
  if(!active){assert.equal(row.status,'entered');active=true;}
  else{assert(['complete','refused'].includes(row.status));active=false;index++;if(row.status==='refused')assert.equal(row,rows.at(-1));}
  last=row;
 }
 return{stage:last.stage,status:last.status};
}
/** All identity checks precede descriptor reads. Invalid diagnostics are unavailable. */
export function readProgress(role,root){
 let fd;
 try{
  assert(Object.hasOwn(PROGRESS_STAGES,role));const directory=lstatSync(root);assert(realpathSync(root)===root&&directory.isDirectory()&&!directory.isSymbolicLink()&&directory.uid===process.getuid()&&(directory.mode&0o777)===0o700);
  const path=join(root,role+'-progress.jsonl'),before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.uid===process.getuid()&&(before.mode&0o777)===0o600&&before.nlink===1&&before.size>0&&before.size<=16384);
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const fields=['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'],opened=fstatSync(fd);for(const key of fields)assert.equal(opened[key],before[key]);
  const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);assert(n>0);offset+=n;}assert.equal(readSync(fd,Buffer.alloc(1),0,1,offset),0);
  const after=fstatSync(fd),current=lstatSync(path),directoryAfter=lstatSync(root);for(const key of fields)assert(before[key]===after[key]&&before[key]===current[key]);assert.equal(directoryAfter.dev,directory.dev);assert.equal(directoryAfter.ino,directory.ino);assert.equal(directoryAfter.mode,directory.mode);assert.equal(directoryAfter.uid,directory.uid);
  return decodeProgress(role,bytes);
 }catch{return{stage:'unavailable',status:'unavailable'};}finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
}
export function validateComparisonDiagnostic(value){
 assert(value&&Object.keys(value).sort().join('|')==='adapter|childOutcome|kind|worker');assert.equal(value.kind,'UNAUTHENTICATED_COMPARISON_PHASE_OBSERVATIONS');assert(CHILD_OUTCOMES.includes(value.childOutcome));
 for(const role of ['adapter','worker']){const row=value[role];assert(row&&Object.keys(row).sort().join('|')==='stage|status');assert(row.stage==='unavailable'?row.status==='unavailable':PROGRESS_STAGES[role].includes(row.stage)&&statuses.includes(row.status));}
 return value;
}
export function comparisonDiagnostic(root,childOutcome){return validateComparisonDiagnostic({kind:'UNAUTHENTICATED_COMPARISON_PHASE_OBSERVATIONS',childOutcome,adapter:readProgress('adapter',root),worker:readProgress('worker',root)});}
/** The real CLOSE promise, not EXIT or a timer, owns the diagnostic read frontier. */
export async function closedComparisonDiagnostic(done,root,state){
 const exit=await done;
 assert(typeof state.error==='boolean'&&typeof state.expired==='boolean'&&Number.isSafeInteger(state.bytes)&&state.bytes>=0);
 const outcome=state.error?'spawn-error':state.expired?'expired':state.bytes>65536?'oversize':exit.signal!==null?'signal':exit.code===0?'exit-zero':'exit-nonzero';
 return{exit,diagnostic:comparisonDiagnostic(root,outcome)};
}
