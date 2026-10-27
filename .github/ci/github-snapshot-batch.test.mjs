import test from 'node:test';import assert from 'node:assert/strict';import {collectRunSnapshots} from './github-snapshot-batch.mjs';
const read=async path=>path.includes('/jobs?')?{jobs:[{id:1}]}:path.includes('/artifacts?')?{artifacts:[]}:{id:Number(path.split('/').at(-1))};
test('bounded parallel transport retains every exact requested identity and complete inventories',async()=>{const r=await collectRunSnapshots([7,3,19],read);assert.deepEqual([...r.keys()].sort((a,b)=>a-b),[3,7,19]);assert.equal(r.get(7).jobs.length,1);});
for(const ids of [[],[1,1],[0],['1'],Array.from({length:65},(_,i)=>i+1)])test('refuses invalid or excessive run IDs '+JSON.stringify(ids).slice(0,35),async()=>assert.rejects(collectRunSnapshots(ids,read)));
test('refuses a foreign run response',async()=>assert.rejects(collectRunSnapshots([1],async p=>p.endsWith('/1')?{id:2}:read(p))));
test('never truncates a full first page',async()=>{const calls=[];const r=await collectRunSnapshots([1],async p=>{calls.push(p);if(p.includes('/jobs?'))return {jobs:p.endsWith('page=1')?Array(100).fill({id:2}):[{id:3}]};return read(p);});assert.equal(r.get(1).jobs.length,101);assert(calls.some(p=>p.includes('/jobs?')&&p.endsWith('page=2')));});
test('refuses missing pages and unbounded pagination',async()=>{await assert.rejects(collectRunSnapshots([1],async p=>p.includes('/jobs?')?{}:read(p)));await assert.rejects(collectRunSnapshots([1],async p=>p.includes('/jobs?')?{jobs:Array(100).fill({id:1})}:read(p)));});
test('rejects worker count beyond the bounded resource budget',async()=>assert.rejects(collectRunSnapshots([1],read,5)));
test('smaller actual metadata pages retain every job across all complete pages',async()=>{
 const calls=[];const result=await collectRunSnapshots([1],async path=>{
  calls.push(path);if(!path.includes('/jobs?'))return read(path);
  assert(path.includes('per_page=30'));const page=Number(path.split('page=').at(-1));
  return {jobs:Array.from({length:page<3?30:1},(_,i)=>({id:(page-1)*30+i+1}))};
 },4,30);
 assert.equal(result.get(1).jobs.length,61);assert.equal(new Set(result.get(1).jobs.map(j=>j.id)).size,61);
 assert.equal(calls.filter(p=>p.includes('/jobs?')).length,3);
});
for(const size of [0,9,101,30.5])test('refuses invalid metadata page size '+size,async()=>assert.rejects(collectRunSnapshots([1],read,4,size)));
test('never truncates an oversized response to a smaller request',async()=>assert.rejects(collectRunSnapshots([1],async p=>p.includes('/jobs?')?{jobs:Array(31).fill({id:1})}:read(p),4,30)));
