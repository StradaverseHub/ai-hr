/** Proof-only Unicode observations. No application route, SQL function or grant. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
export const asciiProofLimits=Object.freeze({maximumBytes:16*1024*1024,scalarCount:1112063,maximumCodePoint:0x10ffff,sentinel:'\ue000'});
export const asciiProofInputs=Object.freeze({
 unicode:{file:'test/fixtures/unicode-17.0.0/UnicodeData.txt',bytes:2198209,sha256:'2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c'},
 special:{file:'test/fixtures/unicode-17.0.0/SpecialCasing.txt',bytes:17049,sha256:'efc25faf19de21b92c1194c111c932e03d2a5eaf18194e33f1156e96de4c9588'},
});
export const asciiProofSha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export function asciiProofSourceBytes(file:string,maximum=16*1024*1024){
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd);assert(before.isFile()&&before.size>0&&before.size<=maximum,'Bounded regular proof source required');
  const buffer=Buffer.alloc(before.size+1);let count=0;
  while(count<buffer.length){const next=readSync(fd,buffer,count,buffer.length-count,count);if(!next)break;count+=next;}
  assert.equal(count,before.size,'Proof source changed length');const after=fstatSync(fd);for(const key of ['dev','ino','size','mtimeMs','ctimeMs']as const)assert.equal(after[key],before[key]);return buffer.subarray(0,count);
 }finally{closeSync(fd);}
}
export const asciiProofNativeExpression="translate(replace(original,U&'\\0130',U&'i\\0307'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ'||U&'\\212A','abcdefghijklmnopqrstuvwxyzk')";
export function asciiProofQuerySql(file:'scalar'|'vectors'){
 const template=asciiProofSourceBytes(`test/fixtures/employee-choice-ascii-${file==='scalar'?'scalar-corpus':'vectors'}.sql`).toString('utf8'),token='/* EXACT_ASCII_OBSERVATION_TRANSFORM */';
 assert.equal(template.split(token).length,2,'Exactly one fixed transform site required');return template.replace(token,asciiProofNativeExpression);
}
const hex=(text:string)=>{assert.match(text,/^[0-9A-F]{4,6}$/);const value=parseInt(text,16);assert(value<=0x10ffff);return value;};
const sequence=(text:string)=>text===''?[]:text.split(' ').map(hex);
const conditionalRows=[
 '03A3;03C2;Final_Sigma','0307;0307;lt After_Soft_Dotted','0049;0069 0307;lt More_Above','004A;006A 0307;lt More_Above',
 '012E;012F 0307;lt More_Above','00CC;0069 0307 0300;lt','00CD;0069 0307 0301;lt','0128;0069 0307 0303;lt',
 '0130;0069;tr','0130;0069;az','0307;;tr After_I','0307;;az After_I','0049;0131;tr Not_Before_Dot','0049;0131;az Not_Before_Dot','0069;0069;tr','0069;0069;az',
].sort();
/** Parse complete primary tables. Unknown conditions/fields and range ambiguity
 * refuse; this is not a heuristic list of two familiar characters. */
export function deriveAsciiCaseContract(unicode:string,special:string){
 const lower=new Map<number,readonly number[]>();let previous=-1,range:{name:string;fields:string[]}|undefined;
 for(const line of unicode.trimEnd().split('\n')){
  const fields=line.split(';');assert.equal(fields.length,15,'Unknown UnicodeData schema');const cp=hex(fields[0]);assert(cp>previous,'UnicodeData order/duplicate');previous=cp;
  if(range){assert.equal(fields[1],range.name.replace(', First>',', Last>'),'Unclosed UnicodeData range');assert.deepEqual(fields.slice(2),range.fields.slice(2));range=undefined;}
  else if(fields[1].endsWith(', First>')){assert.equal(fields[13],'','Range cannot hide lowercase mappings');range={name:fields[1],fields};}
  else assert(!fields[1].endsWith(', Last>'),'Unopened UnicodeData range');
  if(fields[13])lower.set(cp,[hex(fields[13])]);
 }
 assert(!range,'Unclosed final UnicodeData range');assert(special.startsWith('# SpecialCasing-17.0.0.txt\n'));
 const unconditional=new Set<number>(),conditional:string[]=[];
 for(const line of special.split('\n')){
  const content=line.split('#',1)[0].trim();if(!content)continue;
  const fields=content.split(';').map(value=>value.trim());if(fields.at(-1)==='')fields.pop();assert(fields.length===4||fields.length===5,'Unknown SpecialCasing schema');
  const cp=hex(fields[0]),mapping=sequence(fields[1]);sequence(fields[2]);sequence(fields[3]);
  if(fields[4])conditional.push(`${fields[0]};${fields[1]};${fields[4]}`);
  else{assert(!unconditional.has(cp),'Duplicate unconditional case mapping');unconditional.add(cp);assert(mapping.length,'Empty default lowercase mapping');lower.set(cp,mapping);}
 }
 assert.deepEqual(conditional.sort(),conditionalRows,'Unreviewed conditional casing rule');
 const asciiChanges:Array<{cp:number;lower:readonly number[]}>=[],exceptions:Array<{cp:number;lower:readonly number[]}>=[];
 for(const [cp,mapping]of lower){assert(mapping.length,'Empty default mapping');if(cp<128)asciiChanges.push({cp,lower:mapping});else if(mapping.some(value=>value<128))exceptions.push({cp,lower:mapping});}
 asciiChanges.sort((a,b)=>a.cp-b.cp);exceptions.sort((a,b)=>a.cp-b.cp);
 assert.deepEqual(asciiChanges,Array.from({length:26},(_,index)=>({cp:65+index,lower:[97+index]})));
 assert.deepEqual(exceptions,[{cp:0x130,lower:[0x69,0x307]},{cp:0x212a,lower:[0x6b]}]);
 return{lower,exceptions,conditionalRows:conditional,localeInsensitiveConditional:'Final_Sigma',emptyDefaultMappings:0};
}
export function readAsciiCaseContract(){
 const values=Object.values(asciiProofInputs).map(input=>{const bytes=asciiProofSourceBytes(input.file,input.bytes);assert.equal(bytes.length,input.bytes);assert.equal(asciiProofSha(bytes),input.sha256);return bytes.toString('utf8');});
 return deriveAsciiCaseContract(values[0],values[1]);
}
/** Independent procedural observer: retain ASCII code units exactly; compress
 * each maximal non-ASCII run into one non-ASCII barrier. No native regex copy. */
export function asciiObservation(value:string){
 let result='',barrier=false;
 for(const scalar of value){const cp=scalar.codePointAt(0);if(cp!==undefined&&cp<128){result+=scalar;barrier=false;}else if(!barrier){result+=asciiProofLimits.sentinel;barrier=true;}}
 return result;
}
export function databaseScalar(cp:number){return Number.isInteger(cp)&&cp>=1&&cp<=asciiProofLimits.maximumCodePoint&&(cp<0xd800||cp>0xdfff);}
export function nodeScalarCorpus(contract:ReturnType<typeof readAsciiCaseContract>,checkpoint:()=>void=()=>{}){
 const bytes=Buffer.alloc(asciiProofLimits.maximumBytes);let offset=0,count=0;
 for(let cp=1;cp<=asciiProofLimits.maximumCodePoint;cp++){
  if((cp&4095)===0)checkpoint();
  if(!databaseScalar(cp))continue;
  const scalar=String.fromCodePoint(cp),actual=asciiObservation(scalar.toLowerCase()),mapping=contract.lower.get(cp),expected=asciiObservation(mapping?String.fromCodePoint(...mapping):scalar);
  if(actual!==expected)throw Error(`Runtime/table ASCII observation differs at U+${cp.toString(16)}`);
  const length=Buffer.byteLength(actual);assert(length<=4);assert(offset+8+length<=bytes.length,'Scalar corpus byte bound');
  bytes.writeUInt32BE(cp,offset);bytes.writeUInt32BE(length,offset+4);offset+=8;offset+=bytes.write(actual,offset,'utf8');count++;
 }
 assert.equal(count,asciiProofLimits.scalarCount);return{bytes:bytes.subarray(0,offset),count,sha256:asciiProofSha(bytes.subarray(0,offset))};
}
/** Validate every record before exact native/Node comparison; never qualify a
 * matching digest with missing, repeated, reordered or malformed records. */
export function validateScalarCorpus(bytes:Buffer){
 assert(bytes.length<=asciiProofLimits.maximumBytes);let offset=0,count=0,expected=1;
 const barrier=(at:number)=>bytes[at]===0xee&&bytes[at+1]===0x80&&bytes[at+2]===0x80;
 while(offset<bytes.length){
  while(!databaseScalar(expected)&&expected<=asciiProofLimits.maximumCodePoint)expected++;
  if(offset+8>bytes.length)throw Error('Partial scalar frame');const cp=bytes.readUInt32BE(offset),length=bytes.readUInt32BE(offset+4);offset+=8;
  if(cp!==expected)throw Error('Missing/repeated/reordered scalar');if(length<1||length>4||offset+length>bytes.length)throw Error('Invalid scalar observation frame');
  // Exhaustively derived scalar codomain: ASCII1..127, one U+E000 barrier,
  // or i+barrier. Inspect raw bytes without allocating one Buffer per scalar.
  if(!(length===1&&bytes[offset]>=1&&bytes[offset]<128||length===3&&barrier(offset)||length===4&&bytes[offset]===0x69&&barrier(offset+1)))throw Error('Noncanonical observation UTF8');
  offset+=length;count++;expected++;
 }
 assert.equal(expected,0x110000);assert.equal(count,asciiProofLimits.scalarCount);return{count,byteLength:bytes.length,sha256:asciiProofSha(bytes)};
}
export function compareScalarCorpus(actual:Buffer,expected:Buffer){
 const native=validateScalarCorpus(actual),node=validateScalarCorpus(expected);
 if(!actual.equals(expected)){let first=0;while(first<Math.min(actual.length,expected.length)&&actual[first]===expected[first])first++;throw Error(`Complete scalar corpus differs at byte ${first}`);}
 assert.deepEqual(native,node);return native;
}
export type AsciiProofVersions=Readonly<Record<string,string|undefined>>;
export const asciiProofVersion=Object.freeze({node:'22.23.3',icu:'78.3',unicode:'17.0',v8:'12.4.254.21-node.57'});
/** Proof experiment eligibility only. This is NOT application admission. The
 * actual binary/complete versions are sealed in its authenticated evidence. */
export function asciiProofRuntime(versions:AsciiProofVersions){return Object.entries(asciiProofVersion).every(([key,value])=>versions[key]===value);}
export function asciiProofQuery(raw:string,versions:AsciiProofVersions){
 const q=raw.trim().toLowerCase();return{raw,q,mode:q.includes('\0')?'impossible':!q?'none':asciiProofRuntime(versions)&&/^[\x00-\x7f]*$/.test(q)?'native-ascii-proof':'javascript-fallback'};
}
export function sigmaContextVectors(){
 const prefixes=[{value:'',cased:false},{value:'A',cased:true},{value:'Α',cased:true},{value:'𐐀',cased:true},{value:'\u0345',cased:false},{value:'A\u0345',cased:true},{value:'A'+'\u0301'.repeat(100),cased:true},{value:'1',cased:false},{value:'😀',cased:false}];
 const suffixes=[{value:'',cased:false},{value:'A',cased:true},{value:'Α',cased:true},{value:'𐐀',cased:true},{value:'\u0345',cased:false},{value:'\u0345A',cased:true},{value:'\u0301'.repeat(100)+'A',cased:true},{value:'1',cased:false},{value:'😀',cased:false}];
 return prefixes.flatMap(prefix=>suffixes.map(suffix=>({text:prefix.value+'Σ'+suffix.value,final:prefix.cased&&!suffix.cased})));
}
