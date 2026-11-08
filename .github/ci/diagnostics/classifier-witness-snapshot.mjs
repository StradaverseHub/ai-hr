/** Full filesystem observations only. The actual native owner must separately authenticate root/index/source. */
import {constants,openSync,closeSync,lstatSync,statSync,fstatSync,readSync,realpathSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {parseTracked,canonicalJson} from '../../../scripts/gate-db-witness-protocol.ts';
import {CLASSIFIER_WITNESS_BYTES} from './classifier-witness-profile.mjs';
const limit=CLASSIFIER_WITNESS_BYTES.largeMember;
// Existing complete Git-blob read envelope. Over-limit source refuses the witness; it never becomes null.
const blobLimit=8*1024**2;
const keys=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
const match=(a,b)=>keys.every(key=>a[key]===b[key]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const blob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const fail=()=>{throw Error('Classifier source custody unavailable');};
const need=value=>{if(!value)fail();};
const wireBytes=value=>Buffer.byteLength(canonicalJson(value));
const copies=value=>JSON.parse(JSON.stringify(value));
/** No admission brand: caller data/root paths cannot establish native or GitHub authority. */
export function createClassifierSourceView({source,tracked,signal}){
 signal?.throwIfAborted();need(typeof source==='string'&&resolve(source)===source&&realpathSync(source)===source);
 const rootBefore=lstatSync(source,{bigint:true});need(rootBefore.isDirectory()&&!rootBefore.isSymbolicLink());
 need(tracked instanceof Uint8Array&&tracked.length<=CLASSIFIER_WITNESS_BYTES.inventory);
 const index=new Map(parseTracked(tracked).map(row=>[row.path,Object.freeze({...row})]));
 const observed=new Map(),calls={a:[],b:[],c:[]},minimumCallBytes=Object.fromEntries(['a','b','c'].map(engine=>[engine,wireBytes({version:1,engine,rows:[]})]));
 const order=['c','b','a'];let next=0,active=null,poisoned=false,poison,sealed=null,minimumIndexBytes=wireBytes({version:1,rows:[]});
 const check=()=>{if(poisoned)throw poison;signal?.throwIfAborted();need(realpathSync(source)===source);const now=lstatSync(source,{bigint:true});need(now.isDirectory()&&now.dev===rootBefore.dev&&now.ino===rootBefore.ino&&now.uid===rootBefore.uid);};
 const guard=work=>{try{check();return work();}catch(error){if(!poisoned){poisoned=true;poison=error;}throw error;}};
 function location(logical){
  need(typeof logical==='string'&&!logical.startsWith('/'));
  const target=resolve(source,logical),path=relative(source,target).split(sep).join('/');need(path!=='..'&&!path.startsWith('../')&&!path.startsWith('/'));
  // Preserve the native syscall spelling: normalising a missing/../ segment could invent a positive.
  const absolute=logical===''?'':source+sep+logical;return{absolute,target,path};
 }
 function nativeObservation(logical){
  check();const{absolute,target,path}=location(logical);let native;
  try{native=statSync(absolute,{bigint:true});}
  catch(error){
   const code=error&&Object.getOwnPropertyDescriptor(error,'code');
   const known=code&&Object.hasOwn(code,'value')&&(['ENOENT','ENOTDIR','ENAMETOOLONG','EINVAL'].includes(code.value)||logical.includes('\0')&&code.value==='ERR_INVALID_ARG_VALUE');
   if(known){check();return{text:null,negative:{kind:'native-stat-error',code:code.value}};}
   throw Error('Classifier source custody unavailable',{cause:error});
  }
  if(!native.isFile()){check();return{text:null,negative:{kind:'nonfile',identity:native}};}
  // Authenticate the source path/index BEFORE opening/retaining a positive byte.
  const registered=index.get(path);need(!logical.includes('\0')&&registered&&realpathSync(absolute)===target);
  const named=lstatSync(absolute,{bigint:true});need(named.isFile()&&!named.isSymbolicLink()&&named.nlink===1n&&match(named,native)&&named.size<=BigInt(blobLimit));
  need((named.mode&0o100n)!==0n?registered.mode==='100755':registered.mode==='100644');
  let descriptor,failed=false,primary;
  try{
   descriptor=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   need(match(named,fstatSync(descriptor,{bigint:true})));check();
   const raw=Buffer.alloc(Number(named.size));let offset=0;
   while(offset<raw.length){check();const count=readSync(descriptor,raw,offset,raw.length-offset,null);need(count>0);offset+=count;check();}
   check();need(readSync(descriptor,Buffer.alloc(1),0,1,null)===0);check();
   need(match(named,fstatSync(descriptor,{bigint:true}))&&match(named,lstatSync(absolute,{bigint:true}))&&realpathSync(absolute)===target);
   need(blob(raw)===registered.blob);
   const text=raw.toString('utf8');return{text,positive:{identity:named,path,mode:registered.mode,blob:registered.blob,rawSha256:sha(raw),rawBytes:raw.length,textSha256:sha(Buffer.from(text,'utf8')),textCodeUnits:text.length}};
  }catch(error){failed=true;primary=error;throw error;}
  finally{if(descriptor!==undefined)try{closeSync(descriptor);}catch(error){if(failed)throw new AggregateError([primary,error],'Classifier source primary and descriptor closure failed');throw error;}}
 }
 function sameObservation(before,after){
  need(before.text===after.text);
  if(before.text===null){need(before.negative.kind===after.negative.kind&&before.negative.code===after.negative.code);if(before.negative.kind==='nonfile')need(match(before.negative.identity,after.negative.identity));}
  else {need(match(before.positive.identity,after.positive.identity));for(const key of ['path','mode','blob','rawSha256','rawBytes','textSha256','textCodeUnits'])need(before.positive[key]===after.positive[key]);}
 }
 const stable=()=>guard(()=>{for(const[logical,observation]of observed){check();sameObservation(observation,nativeObservation(logical));}check();});
 function begin(engine){return guard(()=>{
  need(!sealed&&active===null&&engine===order[next]);active=engine;
  return logical=>guard(()=>{
   need(active===engine&&!sealed);
   const id=calls[engine].length;
   // A lower bound only: if even sourceId0 cannot fit, the true complete record cannot fit.
   minimumCallBytes[engine]+=Buffer.byteLength(JSON.stringify({id,sourceId:0}))+(id===0?0:1);need(minimumCallBytes[engine]<=limit);
   let value=observed.get(logical);
   if(!observed.has(logical)){
    value={...nativeObservation(logical),firstSeen:observed.size,firstEngine:engine};
    const v=value.positive,row={id:0,path:logical,firstSeen:value.firstSeen,firstEngine:engine,value:value.text===null?null:{blob:v.blob,rawSha256:v.rawSha256,rawBytes:v.rawBytes,textSha256:v.textSha256,textCodeUnits:v.textCodeUnits,mode:v.mode}};
    minimumIndexBytes+=Buffer.byteLength(canonicalJson(row))-1+(observed.size===0?0:1);need(minimumIndexBytes<=limit);observed.set(logical,value);
   }
   calls[engine].push(logical);check();return value.text;
  });
 });}
 function end(engine){return guard(()=>{need(!sealed&&active===engine);active=null;next++;});}
 function seal(){return guard(()=>{
  need(!sealed&&active===null&&next===3);stable();
  const paths=[...observed.keys()].sort(),ids=new Map(paths.map((path,id)=>[path,id]));
  const rows=paths.map((path,id)=>{const o=observed.get(path),v=o.positive;return{id,path,firstSeen:o.firstSeen,firstEngine:o.firstEngine,value:o.text===null?null:{blob:v.blob,rawSha256:v.rawSha256,rawBytes:v.rawBytes,textSha256:v.textSha256,textCodeUnits:v.textCodeUnits,mode:v.mode}};});
  const snapshot={version:1,rows};need(wireBytes(snapshot)<=limit);
  const orderedCalls=Object.fromEntries(['a','b','c'].map(engine=>{const value={version:1,engine,rows:calls[engine].map((path,id)=>({id,sourceId:ids.get(path)}))};need(wireBytes(value)<=limit);return[engine,value];}));
  const entries=Object.freeze(paths.map(path=>Object.freeze({path,text:observed.get(path).text})));
  sealed={snapshot,orderedCalls,entries};check();
  return Object.freeze({
   entries,
   index:()=>copies(snapshot),calls:engine=>{need(Object.hasOwn(orderedCalls,engine));return copies(orderedCalls[engine]);},
   read:logical=>guard(()=>{need(observed.has(logical));return observed.get(logical).text;}),
   assertStable:stable,
  });
 });}
 return Object.freeze({begin,end,seal,assertStable:stable});
}
