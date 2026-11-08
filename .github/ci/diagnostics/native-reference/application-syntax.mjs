/** Original ordinary nodes use public forEachChild. JSDoc attachment discovery
 * is PINNED TS5.9.3 PARSER OWN-DATA METADATA, not a public getter/cache contract. */
import assert from 'node:assert/strict';
function attachments(ts,node,check){
 const descriptor=Object.getOwnPropertyDescriptor(node,'jsDoc');
 if(!descriptor)return[];assert('value'in descriptor,'Original jsDoc must be DATA');
 if(descriptor.value===undefined)return[];
 const array=descriptor.value;assert(Array.isArray(array),'Original jsDoc must be an array');
 const length=Object.getOwnPropertyDescriptor(array,'length');assert(length&&'value'in length&&Number.isSafeInteger(length.value)&&length.value>=0,'Original attachment DATA length');
 const documents=[];
 for(let index=0;index<length.value;index++){
  check();const entry=Object.getOwnPropertyDescriptor(array,String(index));
  assert(entry&&'value'in entry&&entry.value!==null&&typeof entry.value==='object'&&ts.isJSDoc(entry.value),'Original attachment DATA document');documents.push(entry.value);
 }
 return documents;
}
export function walkNativeApplicationSyntax(ts,file,observe,check=()=>{}){
 const seen=new WeakSet();
 function visit(node){
  check();if(seen.has(node))return;seen.add(node);observe(node);
  for(const document of attachments(ts,node,check))visit(document);
  ts.forEachChild(node,visit);
 }
 visit(file);
}
/** Complete PRIVATE before-image, built independently of the observation walk.
 * No source text/AST serialization or receipt may stand in for these references.
 * Full descriptors are retained for every attachment host/array/document/tag/
 * literal/child array; ordinary AST membership is retained per actual file. */
export function captureNativeApplicationAttachments(ts,files,check=()=>{}){
 const images=new Map(),states=new Map(),hostEdges=new Map();
 function image(object){
  check();if(images.has(object))return;
  images.set(object,{keys:Reflect.ownKeys(object),descriptors:Object.getOwnPropertyDescriptors(object)});
 }
 function attachmentClosure(node){
  image(node);
  for(const key of Reflect.ownKeys(node)){
   check();const descriptor=Object.getOwnPropertyDescriptor(node,key);
   if(descriptor&&'value'in descriptor&&Array.isArray(descriptor.value))image(descriptor.value);
  }
 }
 // Deliberately independent census: no production attachments()/walker output.
 function dataDocuments(node){
  const descriptor=Object.getOwnPropertyDescriptor(node,'jsDoc');
  if(!descriptor)return null;assert('value'in descriptor,'Integrity jsDoc accessor refused');
  if(descriptor.value===undefined)return null;
  const array=descriptor.value;assert(Array.isArray(array),'Integrity attachment array');
  const length=Object.getOwnPropertyDescriptor(array,'length');assert(length&&'value'in length&&Number.isSafeInteger(length.value)&&length.value>=0,'Integrity attachment length');
  const documents=[];
  for(let index=0;index<length.value;index++){
   check();const descriptor=Object.getOwnPropertyDescriptor(array,String(index));
   assert(descriptor&&'value'in descriptor&&descriptor.value!==null&&typeof descriptor.value==='object'&&ts.isJSDoc(descriptor.value),'Integrity attachment entry');documents.push(descriptor.value);
  }
  return{array,documents};
 }
 for(const file of files){
  check();assert(!states.has(file),'Duplicate original Program file');
  const members=new WeakSet(),documentClosure=new WeakSet(),state={members,order:new WeakMap(),count:0,observed:new WeakSet(),observedCount:0};states.set(file,state);
  function visit(node,inDocument=false){
   check();const fresh=!members.has(node),documentFresh=inDocument&&!documentClosure.has(node);
   if(!fresh&&!documentFresh)return;
   if(fresh){members.add(node);state.order.set(node,state.count);state.count++;}
   if(documentFresh){documentClosure.add(node);attachmentClosure(node);}
   const data=dataDocuments(node);
   if(data){
    attachmentClosure(node);image(data.array);const prior=hostEdges.get(node);
    if(prior){assert.strictEqual(prior.array,data.array);assert.equal(prior.documents.length,data.documents.length);for(let index=0;index<data.documents.length;index++)assert.strictEqual(prior.documents[index],data.documents[index]);}
    else hostEdges.set(node,data);
    for(const document of data.documents)visit(document,true);
   }
   ts.forEachChild(node,child=>{visit(child,inDocument);});
  }
  visit(file);
 }
 let verified=false;
 return Object.freeze({
  observe(file,node){
   check();assert(!verified,'Integrity observation after settlement');const state=states.get(file);
   assert(state&&state.members.has(node),'Observation is not an original Program member');assert(!state.observed.has(node),'Duplicate original Program observation');assert.equal(state.order.get(node),state.observedCount,'Original Program observation order changed');state.observed.add(node);state.observedCount++;
  },
  verify(){
   check();assert(!verified,'Integrity verification repeated');
   for(const[object,before]of images){
    check();const keys=Reflect.ownKeys(object);assert.equal(keys.length,before.keys.length,'Original own key count changed');
    for(let index=0;index<keys.length;index++)assert.strictEqual(keys[index],before.keys[index],'Original own key order changed');
    for(const key of before.keys){
     check();const prior=before.descriptors[key],actual=Object.getOwnPropertyDescriptor(object,key);assert(actual,'Original own descriptor removed');assert.equal(Object.hasOwn(actual,'value'),Object.hasOwn(prior,'value'),'Original descriptor kind changed');
     for(const field of ['value','writable','get','set','enumerable','configurable'])assert(Object.is(actual[field],prior[field]),'Original own descriptor changed');
    }
   }
   const afterHosts=new Set();
   for(const[file,state]of states){
    check();assert.equal(state.observedCount,state.count,'Incomplete original Program observation');const seen=new WeakSet();let count=0;
    function after(node){
     check();if(seen.has(node))return;seen.add(node);assert(state.members.has(node),'New Program member after observation');assert.equal(state.order.get(node),count,'Original Program member order changed');count++;
     const data=dataDocuments(node);
     if(data){const prior=hostEdges.get(node);assert(prior,'New original attachment host');assert.strictEqual(data.array,prior.array);assert.equal(data.documents.length,prior.documents.length);for(let index=0;index<data.documents.length;index++)assert.strictEqual(data.documents[index],prior.documents[index],'Original attachment order/member changed');afterHosts.add(node);for(const document of data.documents)after(document);}
     ts.forEachChild(node,after);
    }
    after(file);assert.equal(count,state.count,'Original Program member disappeared');
   }
   assert.equal(afterHosts.size,hostEdges.size,'Original attachment host disappeared');verified=true;
  },
 });
}
