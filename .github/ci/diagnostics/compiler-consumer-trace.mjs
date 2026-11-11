/** Bounded artifact interpretation only. No compiler, application, transport or release witness. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,lstatSync,realpathSync,readFileSync,writeFileSync,existsSync,readdirSync,constants} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {BOUNDARY_SOURCE,BOUNDARY_LIMITS,TRACED_CONSUMERS} from './compiler-boundary-policy.mjs';
export const TRACE_PARSE_LIMITS=Object.freeze({lineBytes:2*1024**2,records:5000000,files:20000,stack:1024,hotSpans:64,instantTypes:32,analysisMs:120000});
const same=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs'].every(key=>a[key]===b[key]);
export async function scanNativeArray(path,visit,deadline=Date.now()+TRACE_PARSE_LIMITS.analysisMs){
 const before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=BOUNDARY_LIMITS.fileBytes,'Unsafe native trace member');
 const sha=createHash('sha256'),decoder=new StringDecoder('utf8');let pending='',records=0,invalidLines=0,partialTail=false,closed=false,bytes=0,opened=false;
 const line=(raw,terminated)=>{
  let text=raw.trim();if(!text)return;
  assert(!closed,'Records after native array closure');
  if(!opened){assert(text.startsWith('['),'Native array opening required');opened=true;text=text.slice(1).trim();}
  if(text.startsWith(','))text=text.slice(1).trim();
  if(text.endsWith(']')){closed=true;text=text.slice(0,-1).trim();}
  if(text.endsWith(','))text=text.slice(0,-1).trim();if(!text)return;
  let value;try{value=JSON.parse(text);}catch{if(terminated)invalidLines++;else partialTail=true;return;}
  assert(value&&typeof value==='object'&&!Array.isArray(value),'Native object record required');assert(++records<=TRACE_PARSE_LIMITS.records,'Native trace record bound');visit(value);
 };
 const stream=createReadStream(path,{flags:constants.O_RDONLY|constants.O_NOFOLLOW,highWaterMark:64*1024});
 for await(const chunk of stream){assert(Date.now()<=deadline,'Artifact analysis deadline');bytes+=chunk.length;assert(bytes<=BOUNDARY_LIMITS.fileBytes);sha.update(chunk);pending+=decoder.write(chunk);
  let at;while((at=pending.indexOf('\n'))>=0){const next=pending.slice(0,at);assert(Buffer.byteLength(next)<=TRACE_PARSE_LIMITS.lineBytes,'Native trace line bound');line(next,true);pending=pending.slice(at+1);}
  assert(Buffer.byteLength(pending)<=TRACE_PARSE_LIMITS.lineBytes,'Native trace line bound');
 }
 pending+=decoder.end();if(pending.trim())line(pending,false);
 assert(bytes===before.size&&same(before,lstatSync(path)),'Native trace changed during analysis');
 return{sha256:sha.digest('hex'),bytes,records,closed,invalidLines,partialTail,completeArray:opened&&closed&&!invalidLines&&!partialTail};
}
export function sourceOwnerMapper(inventory,declarations){
 const prefix=dirname(inventory.options.configFilePath)+'/',files=new Map(inventory.files.flatMap(row=>[[row.id,row],[row.real,row]])),virtuals=new Map(declarations.map(row=>[row.virtual,row.source]));
 return path=>{
  if(typeof path!=='string')return{kind:'unavailable',originalSourceId:null};
  assert(path.length<=4096,'Native source path bound');
  const id=path.startsWith(prefix)?path.slice(prefix.length):path;
  if(virtuals.has(id))return{kind:'owned-declaration',originalSourceId:virtuals.get(id),nativePath:id,lineScope:'native declaration line; original-owner mapping is file-level only'};
  const row=files.get(id);if(row)return{kind:row.external?'original-external':'original-source',originalSourceId:row.id,nativePath:id};
  if(id==='__aihr_boundary_contract__.ts'||/^__aihr_context_[a-f0-9]{24}\.d\.ts$/.test(id))return{kind:'diagnostic-context',originalSourceId:null,nativePath:id};
  return{kind:'unregistered',originalSourceId:null,nativePath:id};
 };
}
export function traceAccumulator(mapOwner){
 const stacks=new Map(),files=new Map(),hot=[],instant=[];let events=0,incomplete=0,unregistered=0;
 const keep=(list,row,limit)=>{if(list.length===limit&&(row.durationMs??0)<=(list.at(-1).durationMs??0))return;list.push(row);list.sort((a,b)=>(b.durationMs??0)-(a.durationMs??0));if(list.length>limit)list.length=limit;};
 return{
  visit(event){
   events++;const key=event.pid+':'+event.tid,stack=stacks.get(key)??[];stacks.set(key,stack);
   if(event.name==='checkSourceFile'&&event.ph==='B'){
    assert(typeof event.args?.path==='string'&&Number.isFinite(event.ts));const owner=mapOwner(event.args.path);if(owner.kind==='unregistered')unregistered++;
    assert(stack.length<TRACE_PARSE_LIMITS.stack);stack.push({path:event.args.path,owner,ts:event.ts});
   }else if(event.name==='checkSourceFile'&&event.ph==='E'){
    const current=stack.pop();if(!current||event.args?.path!==current.path||!Number.isFinite(event.ts)||event.ts<current.ts){incomplete++;return;}
    const id=current.owner.nativePath??current.path,row=files.get(id)??{...current.owner,completedSpans:0,inclusiveMs:0};row.completedSpans++;row.inclusiveMs+=(event.ts-current.ts)/1000;files.set(id,row);assert(files.size<=TRACE_PARSE_LIMITS.files);
   }else if(event.ph==='X'&&Number.isFinite(event.dur)&&event.dur>=0){
    const typeIds=Object.entries(event.args??{}).filter(([name,value])=>/^(?:sourceId|targetId|typeId)$/.test(name)&&Number.isSafeInteger(value)&&value>0).map(([,value])=>value);
    keep(hot,{name:event.name,durationMs:event.dur/1000,owner:stack.at(-1)?.owner??null,typeIds,args:Object.fromEntries(Object.entries(event.args??{}).filter(([name,value])=>['sourceId','targetId','typeId','pos','end','kind'].includes(name)&&typeof value==='number'))},TRACE_PARSE_LIMITS.hotSpans);
   }else if(typeof event.name==='string'&&event.name.startsWith('instantiateType_')){
    if(instant.length<TRACE_PARSE_LIMITS.instantTypes)instant.push({name:event.name,owner:stack.at(-1)?.owner??null,args:Object.fromEntries(Object.entries(event.args??{}).filter(([name,value])=>['typeId','instantiationDepth','instantiationCount'].includes(name)&&typeof value==='number'))});
   }
  },
  result(){return{events,completedFileCount:files.size,completedFiles:[...files.values()].sort((a,b)=>b.inclusiveMs-a.inclusiveMs).slice(0,200),fileDetailsTruncated:files.size>200,hotSpans:hot,instantiationSignals:instant,incompleteSpans:incomplete+[...stacks.values()].reduce((n,stack)=>n+stack.length,0),unregisteredPaths:unregistered,
   caveat:'Completed source/type spans are inclusive and may overlap. Sampled relation events are not every type instantiation; the last open frame is not causality.'};},
 };
}
export async function analyzeConsumerTrace(out,index,inventory,declarations,deadline){
 assert(TRACED_CONSUMERS.includes(index));const folder=join(out,'trace-consumer-'+index),path=join(folder,'trace.json'),typesPath=join(folder,'types.json');
 if(!existsSync(path))return{index,traceAvailable:false,traceComplete:false,typesAvailable:existsSync(typesPath),completeSuite:false,reason:'Native trace not produced; no event or type witness invented'};
 assert(lstatSync(folder).isDirectory()&&!lstatSync(folder).isSymbolicLink()&&realpathSync(folder)===folder);
 const mapOwner=sourceOwnerMapper(inventory,declarations),accumulator=traceAccumulator(mapOwner),capture=await scanNativeArray(path,event=>accumulator.visit(event),deadline),summary=accumulator.result();
 const needed=new Set(summary.hotSpans.flatMap(row=>row.typeIds));for(const row of summary.instantiationSignals)if(Number.isSafeInteger(row.args?.typeId))needed.add(row.args.typeId);
 const resolved=[],seenTypes=new Set();let typeCapture=null;
 if(existsSync(typesPath))typeCapture=await scanNativeArray(typesPath,row=>{if(needed.has(row.id)){
  assert(!seenTypes.has(row.id),'Duplicate native hot type ID');seenTypes.add(row.id);
  const location=row.firstDeclaration,owner=mapOwner(location?.path);
  resolved.push({id:row.id,symbolName:typeof row.symbolName==='string'?row.symbolName.slice(0,512):null,flags:Array.isArray(row.flags)?row.flags.filter(flag=>typeof flag==='string').slice(0,32).map(flag=>flag.slice(0,64)):[],display:typeof row.display==='string'?row.display.slice(0,512):null,displayTruncated:typeof row.display==='string'&&row.display.length>512,
   firstDeclaration:location?{path:owner.nativePath??null,line:Number.isSafeInteger(location.start?.line)?location.start.line:null,character:Number.isSafeInteger(location.start?.character)?location.start.character:null}:null,owner,
   references:Object.fromEntries(Object.entries(row).filter(([name,value])=>['instantiatedType','conditionalCheckType','conditionalExtendsType','keyofType','indexedAccessObjectType','indexedAccessIndexType'].includes(name)&&typeof value==='number'))});
 }},deadline);
 const unresolvedHotTypeIds=[...needed].filter(id=>!resolved.some(row=>row.id===id));
 return{index,traceAvailable:true,typesAvailable:typeCapture!==null,traceComplete:capture.completeArray&&summary.completedFileCount>0&&summary.incompleteSpans===0&&summary.unregisteredPaths===0&&typeCapture?.completeArray===true&&unresolvedHotTypeIds.length===0,rawCapture:capture,typeCapture,...summary,types:resolved,unresolvedHotTypeIds,completeSuite:false,
  typeScope:'Only native IDs referenced by bounded hot spans/signals are resolved. Missing type dump/locations remain unavailable; no inferred instantiation graph.'};
}
export async function analyzeTraceDirectory(out){
 const startedAt=Date.now(),deadline=startedAt+TRACE_PARSE_LIMITS.analysisMs;
 const info=lstatSync(out);assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&realpathSync(out)===out);
 const read=(name,maximum)=>{assert(Date.now()<=deadline,'Artifact analysis deadline');const path=join(out,name),s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&s.size<=maximum);return JSON.parse(readFileSync(path,'utf8'));};
 const report=read('report.json',1024**2);assert(report.source===BOUNDARY_SOURCE&&report.kind==='DEVELOPMENT_SELECTED_CONSUMER_TRACE_NOT_RELEASE'&&report.completeSuite===false&&report.releaseAuthorized===false);
 const result={kind:'BOUNDED_NATIVE_CONSUMER_TRACE_INTERPRETATION_NOT_RELEASE',source:report.source,controller:report.controller,runId:report.runId,attempt:report.attempt,completeSuite:false,ordinaryCompilerQualified:false,releaseAuthorized:false,consumers:[],limits:TRACE_PARSE_LIMITS,
  caveat:'Artifact interpretation only. GitHub provenance and original native outcomes require independent verification. Instrumentation can alter timing and memory.'};
 try{
  const inventory=read('inventory.json',64*1024**2),declarations=read('declarations-map.json',16*1024**2);
  assert(inventory.identity.source===BOUNDARY_SOURCE);
  for(const index of TRACED_CONSUMERS)result.consumers.push(await analyzeConsumerTrace(out,index,inventory,declarations,deadline));
 }catch(error){result.analysisError=String(error);}
 const bytes=JSON.stringify(result,null,2)+'\n';assert(Buffer.byteLength(bytes)<=16*1024**2,'Bounded trace interpretation output');
 let total=0,entries=0;const walk=(path,depth=0)=>{assert(depth<=64&&Date.now()<=deadline,'Artifact analysis traversal bound');for(const name of readdirSync(path)){assert(++entries<=50000&&Date.now()<=deadline,'Artifact analysis entry/deadline bound');const next=join(path,name),stat=lstatSync(next);assert(!stat.isSymbolicLink());if(stat.isDirectory())walk(next,depth+1);else{assert(stat.isFile()&&stat.size<=BOUNDARY_LIMITS.fileBytes);total+=stat.size;}}};walk(out);assert(total+Buffer.byteLength(bytes)<=BOUNDARY_LIMITS.totalBytes,'Original aggregate artifact bound');
 writeFileSync(join(out,'trace-analysis.json'),bytes,{flag:'wx',mode:0o600});return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.equal(process.argv.length,3);const out=resolve(process.argv[2]);assert.equal(out,join(realpathSync(process.env.RUNNER_TEMP),'diagnostic-compiler-boundary'));
 analyzeTraceDirectory(out).then(result=>{console.log(JSON.stringify({kind:result.kind,consumers:result.consumers.length,analysisError:result.analysisError??null,releaseAuthorized:false}));if(result.analysisError)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
}
