import test from 'node:test';
import assert from 'node:assert/strict';
import {orderTestSpecifications} from '../../scripts/test-duration-order.mjs';
const root='/fixture',spec=(file,name='node',group=0,isolate=true)=>({moduleId:root+'/'+file,project:{name,config:{sequence:{groupOrder:group},isolate}}});
test('recorded long file moves first without dropping unknown files or replacing specifications',()=>{
 const ordinary=spec('test/a-unknown.test.ts'),long=spec('test/r395-write-path-equivalence.test.ts'),other=spec('test/z-unknown.test.ts');
 const input=[ordinary,long,other],out=orderTestSpecifications(input,{root});
 assert.equal(out[0],long);assert.equal(out.length,input.length);assert.deepEqual(new Set(out),new Set(input));assert.deepEqual(input,[ordinary,long,other]);
});
test('project/group/isolation and prior failures retain priority over advisory duration',()=>{
 const long=spec('test/r395-write-path-equivalence.test.ts'),failed=spec('test/a-failed.test.ts');
 assert.equal(orderTestSpecifications([long,failed],{root,getFileTestResults:key=>key.endsWith('a-failed.test.ts')?{failed:true,duration:1}:undefined})[0],failed);
 for(const first of [spec('test/a.test.ts','node',-1),spec('test/a.test.ts','earlier'),spec('test/a.test.ts','node',0,true)]){
  const second=first.project.config.isolate&&first.project.name==='node'&&first.project.config.sequence.groupOrder===0?spec('test/r395-write-path-equivalence.test.ts','node',0,false):long;
  assert.equal(orderTestSpecifications([second,first],{root})[0],first);
 }
});
test('unknown paths, multiple project specifications and deterministic ties remain complete',()=>{
 const a=spec('test/a-new.test.ts'),b=spec('test/b-new.test.ts'),dom=spec('test/a-new.test.ts','dom');
 assert.deepEqual(orderTestSpecifications([b,a],{root}),[a,b]);
 const all=[a,dom,b,a];assert.equal(orderTestSpecifications(all,{root}).length,4);
 const outside=spec('../other/new.test.ts');assert.equal(orderTestSpecifications([outside],{root})[0],outside);
});
