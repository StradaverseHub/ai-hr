/** Pure closed observation/inverse controls, never native transport acceptance. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateNativeInputObservations as check,nativeInputFailureObservation as failure} from './input-controls.mjs';
const shape={kind:'shape',socket:true,fifo:false,anonymousUnixStream:true,nativePeerIsLiveParent:true,stableDescriptor:true};
const settled=mode=>({kind:'settled',mode,completed:mode==='normal',workStarted:['normal','late'].includes(mode),reaped:true,quiescent:true,escaped:false,handlerRestored:true});
test('all closed successful and refusal observations retain their exact meaning',()=>{
 assert.equal(check('shape',[shape]),true);
 for(const mode of ['normal','eof','byte','late'])assert.equal(check(mode,[settled(mode)]),true);
 assert.equal(check('foreign',[{kind:'refused',reason:'socket-peer',workStarted:false}]),true);
 for(const reason of ['descriptor-kind','socket-domain','socket-type','socket-listener','socket-address','socket-connected'])assert.equal(check('invalid:'+reason,[{kind:'refused',reason,workStarted:false}]),true);
 assert.equal(check('parent-death',[{kind:'parent-ready'},{kind:'parent-refused',workStarted:false,childrenAbsent:true}]),true);
});
test('unknown mode and reflected private reasons cannot become a valid observation',()=>{
 for(const mode of ['unknown','invalid:socket-peer','invalid:PRIVATE_NEVER_PUBLISH',null,42])assert.throws(()=>check(mode,[shape]));
 assert.throws(()=>check('foreign',[{kind:'refused',reason:'PRIVATE_NEVER_PUBLISH',workStarted:false}]));
 assert.equal(failure('shape',JSON.stringify({kind:'refused',reason:'parent-entry',workStarted:false})+'\n').reason,'parent-entry');
 for(const text of ['PRIVATE_NEVER_PUBLISH',JSON.stringify({kind:'refused',reason:'PRIVATE_NEVER_PUBLISH',workStarted:false}),JSON.stringify({kind:'refused',reason:'parent-entry',workStarted:false,private:'PRIVATE_NEVER_PUBLISH'}),'{',Buffer.from('PRIVATE_NEVER_PUBLISH')]){const value=failure('shape',text);assert.equal(value.reason,'unavailable');assert(!JSON.stringify(value).includes('PRIVATE_NEVER_PUBLISH'));}
 assert.throws(()=>failure('PRIVATE_NEVER_PUBLISH',''));
});
test('extra private fields and actor identifiers refuse rather than being projected away',()=>{
 for(const row of [{...shape,secret:'PRIVATE_NEVER_PUBLISH'},{...shape,pid:123},{...shape,path:'/private/FICTIONAL'},{...shape,authenticated:true}])assert.throws(()=>check('shape',[row]));
});
test('typed booleans, workload intent and actual settlement cannot be weakened',()=>{
 for(const changes of [{reaped:false},{quiescent:false},{escaped:true},{handlerRestored:false},{completed:true},{workStarted:true},{reaped:1}])assert.throws(()=>check('eof',[{...settled('eof'),...changes}]));
 assert.throws(()=>check('shape',[{...shape,fifo:true}]));assert.throws(()=>check('shape',[{...shape,nativePeerIsLiveParent:'true'}]));
});
test('truncated duplicated reordered and substituted parent-death observations refuse',()=>{
 const rows=[{kind:'parent-ready'},{kind:'parent-refused',workStarted:false,childrenAbsent:true}];
 for(const bad of [[],rows.slice(0,1),rows.slice(1),[...rows,rows[1]],[rows[1],rows[0]],[rows[0],{...rows[1],childrenAbsent:false}]])assert.throws(()=>check('parent-death',bad));
});
test('whole predecessor bytes and all unchanged trust owners are independently sealed',()=>{
 const root=new URL('../../../../',import.meta.url),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 const inverse=JSON.parse(readFileSync(new URL('input-inverse.json',import.meta.url),'utf8'));
 assert.equal(inverse.base,'fe8c3aad28991cb9477a0040f500fc59982d6a4b');
 for(const[path,row]of Object.entries(inverse.files)){
  let text=readFileSync(new URL(path,root),'utf8');assert.equal(sha(text),row.currentSha256);
  let lines=text.match(/[^\n]*\n|[^\n]+$/g)??[],frontier=lines.length;
  for(const edit of row.changes){assert(0<=edit.start&&edit.start<=edit.end&&edit.end<=frontier);assert.equal(lines.slice(edit.start,edit.end).join(''),edit.after);lines.splice(edit.start,edit.end-edit.start,...(edit.before.match(/[^\n]*\n|[^\n]+$/g)??[]));frontier=edit.start;}
  assert.equal(sha(lines.join('')),row.originalSha256);
 }
 for(const[path,hash]of Object.entries(inverse.unchangedSha256))assert.equal(sha(readFileSync(new URL(path,root))),hash,path);
});
