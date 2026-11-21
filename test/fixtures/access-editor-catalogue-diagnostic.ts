/** Metadata diagnostics only. Never an equality waiver, native witness or PASS. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {openSync,closeSync,writeFileSync,fsyncSync,lstatSync,realpathSync,constants} from 'node:fs';
import {join} from 'node:path';
const maximum=16*1024*1024;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(Reflect.get(value,key))]));
 return value;
}
const details=(value:unknown)=>{const raw=JSON.stringify(canonical(value));return{serializable:raw!==undefined,rows:Array.isArray(value)?value.length:null,bytes:raw===undefined?0:Buffer.byteLength(raw),sha256:raw===undefined?null:sha(raw),type:value===null?'null':Array.isArray(value)?'array':typeof value};};
/** Include non-JSON structural differences instead of claiming identical bytes
 * prove deep equality. All native JSON-valued fields remain completely retained. */
function structure(expected:unknown,actual:unknown,path:string,out:unknown[]){
 if(out.length>=32||isDeepStrictEqual(expected,actual))return;
 if(!expected||!actual||typeof expected!=='object'||typeof actual!=='object'){
  out.push({path,expectedType:expected===null?'null':typeof expected,actualType:actual===null?'null':typeof actual,expected,actual});return;
 }
 const before=Reflect.ownKeys(expected),after=Reflect.ownKeys(actual);
 if(Object.getPrototypeOf(expected)!==Object.getPrototypeOf(actual))out.push({path,expectedPrototype:Object.getPrototypeOf(expected)?.constructor?.name??null,actualPrototype:Object.getPrototypeOf(actual)?.constructor?.name??null});
 for(const key of new Set([...before,...after])){
  if(out.length>=32)return;const a=Object.hasOwn(expected,key),b=Object.hasOwn(actual,key),next=path+'.'+String(key);
  if(a!==b)out.push({path:next,expectedOwnKey:a,actualOwnKey:b,expectedType:typeof Reflect.get(expected,key),actualType:typeof Reflect.get(actual,key)});
  else structure(Reflect.get(expected,key),Reflect.get(actual,key),next,out);
 }
}
export function accessEditorCatalogueDiagnostic(expected:Record<string,unknown>,actual:Record<string,unknown>){
 const sections:Record<string,unknown>={},differing:Record<string,unknown>={};
 for(const key of new Set([...Object.keys(expected),...Object.keys(actual)])){
  const equal=isDeepStrictEqual(expected[key],actual[key]);sections[key]={expected:details(expected[key]),actual:details(actual[key]),deepStrictEqual:equal};
  if(!equal){const structuralDifferences:unknown[]=[];structure(expected[key],actual[key],key,structuralDifferences);differing[key]={expected:expected[key],actual:actual[key],structuralDifferences,structuralListBound:32};}
 }
 return{sections,differing};
}
export function writeAccessEditorCatalogueDiagnostic(directory:string,value:Record<string,unknown>){
 const owner=lstatSync(directory);if(!owner.isDirectory()||owner.isSymbolicLink()||owner.uid!==process.getuid!()||realpathSync(directory)!==directory)throw Error('Actual admitted catalogue diagnostic directory required');
 const payload=JSON.stringify(value)+'\n',complete=Buffer.byteLength(payload)<=maximum;
 const retained=complete?payload:JSON.stringify({kind:value.kind,source:value.source,controller:value.controller,run:value.run,attempt:value.attempt,complete:false,reason:'metadata-byte-bound',maximumBytes:maximum,sections:value.sections})+'\n';
 if(Buffer.byteLength(retained)>maximum)throw Error('Bounded catalogue diagnostic summary unavailable');
 const path=join(directory,'access-native-owner-catalogue.json'),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,retained);fsyncSync(fd);}finally{closeSync(fd);}
 if(!complete)throw Error('Complete native catalogue diagnostic exceeds16MiB; retained bounded summary only');
 return{file:'access-native-owner-catalogue.json',sha256:sha(retained),bytes:Buffer.byteLength(retained),complete:true};
}
