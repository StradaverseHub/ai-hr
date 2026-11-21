/** Actual read-only native Unicode proof. No lookup installation/adoption. */
import assert from 'node:assert/strict';
import {afterAll,beforeEach,expect,it} from 'vitest';
import type {TransactionSql} from 'postgres';
import {asciiObservation,asciiProofQuery,asciiProofQuerySql,asciiProofSha,asciiProofVersion,compareScalarCorpus,nodeScalarCorpus,readAsciiCaseContract,sigmaContextVectors} from './fixtures/employee-choice-ascii-observation';
import {asciiNativeProofOwner} from './fixtures/employee-choice-ascii-proof-native';
const owner=asciiNativeProofOwner();beforeEach(()=>owner.beforeCase());afterAll(()=>owner.drain());
type ScalarResult={count:number;first:number;last:number;bytes:Buffer};
type Vector={id:number;text:string;q:string};
type VectorResult={id:number;valid:boolean;observation:string;matched:boolean|null;withoutDot:boolean|null;withoutKelvin:boolean|null};
type WireShape={kind:string|null;count:number|null;ids:number[]|null};
const vectorQuery=asciiProofQuerySql('vectors');
const wireQuery=`with source as(select $1::text::jsonb as value)
 select jsonb_typeof(value)as kind,case when jsonb_typeof(value)='array'then jsonb_array_length(value)end as count,
 case when jsonb_typeof(value)='array'then(select jsonb_agg(item->'id'order by ordinal)from jsonb_array_elements(value)with ordinality as entry(item,ordinal))end as ids from source`;
async function nativeVectors(tx:TransactionSql,vectors:readonly Vector[]){
 const ids=vectors.map(vector=>vector.id);expect(ids.length).toBeGreaterThan(0);expect(new Set(ids).size).toBe(ids.length);expect(ids).toEqual([...ids].sort((a,b)=>a-b));
 const serialized=JSON.stringify(vectors),[wire]=await tx.unsafe<WireShape[]>(wireQuery,[serialized]);expect(wire).toEqual({kind:'array',count:vectors.length,ids});
 const rows=await tx.unsafe<VectorResult[]>(vectorQuery,[serialized]);expect(rows).toHaveLength(vectors.length);expect(rows.map(row=>row.id)).toEqual(ids);return{rows,wire};
}
it('compares every valid scalar native record with pinned tables and the actual bound Node binary',context=>owner.run(context,'scalars',async(tx,report,control)=>{
 const expected=nodeScalarCorpus(readAsciiCaseContract(),control.active);control.active();const query=asciiProofQuerySql('scalar');
 const [native]=await tx.unsafe<ScalarResult[]>(query);control.active();assert(native);assert(Buffer.isBuffer(native.bytes));
 report.actualNative={count:native.count,first:native.first,last:native.last,bytes:native.bytes.length,querySha256:asciiProofSha(query)};
 report.members=[control.publishCorpus('native-scalars.bin',native.bytes),control.publishCorpus('node-scalars.bin',expected.bytes)];
 expect(native.count).toBe(1112063);expect(native.first).toBe(1);expect(native.last).toBe(0x10ffff);report.completeComparison=compareScalarCorpus(native.bytes,expected.bytes);control.active();
}));
it('retains all context barriers with actual Final Sigma whole-string and deliberately defective native controls',context=>owner.run(context,'contexts',async(tx,report,control)=>{
 const source=sigmaContextVectors();const vectors:Vector[]=source.map((value,id)=>({id,text:value.text,q:'a'}));
 vectors.push({id:vectors.length,text:'İA',q:'ia'},{id:vectors.length+1,text:'KA',q:'ka'},{id:vectors.length+2,text:'ßſﬀ',q:'ss'},{id:vectors.length+3,text:'😀A\u0307B',q:'ab'});
 const {rows,wire}=await nativeVectors(tx,vectors);control.active();expect(rows).toHaveLength(vectors.length);
 for(let index=0;index<source.length;index++)expect(source[index].text.toLowerCase().includes('ς')).toBe(source[index].final);
 for(let index=0;index<vectors.length;index++){const vector=vectors[index],row=rows[index];expect(row.id).toBe(vector.id);expect(row.valid).toBe(true);expect(row.observation).toBe(asciiObservation(vector.text.toLowerCase()));expect(row.matched).toBe(vector.text.toLowerCase().includes(vector.q));}
 const dot=rows.find(row=>row.id===source.length)!,kelvin=rows.find(row=>row.id===source.length+1)!;
 expect(dot).toMatchObject({matched:false,withoutDot:true});expect(kelvin).toMatchObject({matched:true,withoutKelvin:false});
 report.contexts={reviewedConditionalRows:readAsciiCaseContract().conditionalRows,finalSigmaVectors:source.length,allVectors:vectors.length,wire,wireQuerySha256:asciiProofSha(wireQuery),exactRows:Array.from(rows),querySha256:asciiProofSha(vectorQuery)};
}));
it('matches literal ASCII query semantics and refuses unsupported modes before forbidden query parameters',context=>owner.run(context,'queries',async(tx,report,control)=>{
 const rawQueries=['%','_','\\',' A B ','\u007f','\u0001','K','i','ka','ia','ss','s','ff'];
 const haystacks=['A%_\\B',' a b ','\u0001A\u007f','İA','KA','ßſﬀ','éASCII😀','𐐀A','AΣB','i\u0307a'];
 const vectors:Vector[]=rawQueries.flatMap(raw=>haystacks.map(text=>({id:0,text,q:asciiProofQuery(raw,process.versions).q}))).map((value,id)=>({...value,id}));
 const {rows,wire}=await nativeVectors(tx,vectors);control.active();expect(rows).toHaveLength(vectors.length);
 for(let index=0;index<vectors.length;index++){const vector=vectors[index],row=rows[index];expect(row.id).toBe(index);expect(row.valid).toBe(true);expect(row.matched).toBe(vector.text.toLowerCase().includes(vector.q));expect(row.observation).toBe(asciiObservation(vector.text.toLowerCase()));}
 // This is a proof-only interface model, not application route adoption. The
 // old application/SQL are unchanged. Non-native modes never call this query.
 let nativeCalls=0;const routes:Array<ReturnType<typeof asciiProofQuery>>=[],routeWires:WireShape[]=[];
 const route=async(raw:string,versions:Readonly<Record<string,string|undefined>>)=>{
  const prepared=asciiProofQuery(raw,versions);routes.push(prepared);
  if(prepared.mode==='native-ascii-proof'){nativeCalls++;const result=await nativeVectors(tx,[{id:0,text:'İA',q:prepared.q}]);routeWires.push(result.wire);const [actual]=result.rows;assert(actual);return actual.matched;}
  return prepared.mode==='impossible'?false:'İA'.toLowerCase().includes(prepared.q);
 };
 for(const raw of ['İ','i\u0307','😀','\ud800','x\0y',' \t\n']){const before=nativeCalls;expect(await route(raw,process.versions)).toBe('İA'.toLowerCase().includes(raw.trim().toLowerCase()));expect(nativeCalls).toBe(before);}
 for(const key of Object.keys(asciiProofVersion)){const before=nativeCalls;expect(await route('i',{...process.versions,[key]:'unsupported'})).toBe(true);expect(nativeCalls).toBe(before);}
 expect(await route('i',process.versions)).toBe(true);expect(nativeCalls).toBe(1);
 const {rows:refused,wire:refusalWire}=await nativeVectors(tx,[{id:0,text:'sample',q:''},{id:1,text:'sample',q:'é'},{id:2,text:'sample',q:'ASCII'}]);
 expect(refused.map(row=>({id:row.id,valid:row.valid,matched:row.matched}))).toEqual([{id:0,valid:false,matched:null},{id:1,valid:false,matched:null},{id:2,valid:false,matched:null}]);control.active();
 report.queries={literalVectors:vectors.length,wire,wireQuerySha256:asciiProofSha(wireQuery),actualRows:Array.from(rows),routeModelOnly:true,routes,routeWires,nativeCalls,directRefusals:Array.from(refused),refusalWire,querySha256:asciiProofSha(vectorQuery)};
}));
