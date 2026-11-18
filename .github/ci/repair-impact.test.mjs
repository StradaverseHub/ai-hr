import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCommittedBlobs,committedBlobBatches,readCommittedBlobBatches} from './repair-impact.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40);
const blob = (id, value) => Buffer.concat([Buffer.from(`${id} blob ${Buffer.byteLength(value)}\n`), Buffer.from(value), Buffer.from('\n')]);
test('Git blob parser binds exact requested identities and UTF-8 byte lengths', () => {
  assert.deepEqual([...decodeCommittedBlobs([a, b], Buffer.concat([blob(a, 'alpha'), blob(b, '中文\nend')]))], [[a, 'alpha'], [b, '中文\nend']]);
});
test('Missing, reordered, duplicated, non-blob, truncated and appended input refuse', () => {
  for (const [ids, bytes] of [
    [[a, b], blob(a, 'alpha')], [[a, b], Buffer.concat([blob(b, 'beta'), blob(a, 'alpha')])],
    [[a, a], Buffer.concat([blob(a, 'alpha'), blob(a, 'alpha')])],
    [[a], Buffer.from(`${a} commit 0\n\n`)], [[a], blob(a, 'alpha').subarray(0, -2)],
    [[a], Buffer.concat([blob(a, 'alpha'), Buffer.from('unexpected')])],
  ]) assert.throws(() => decodeCommittedBlobs(ids, bytes));
});

test('Complete immutable source transport batches preserve order, aliases, UTF-8 and empty blobs', () => {
  const c='c'.repeat(40), values=new Map([[a,'alpha'],[b,'中文\nend'],[c,'']]);
  const entries=[...values].map(([id,value])=>({id,size:Buffer.byteLength(value)}));entries.push({...entries[0]});
  const calls=[];
  const run=(bin,args,options)=>{assert.equal(bin,'git');assert.deepEqual(args,['cat-file','--batch']);calls.push(options);return Buffer.concat(options.input.trim().split('\n').map(id=>blob(id,values.get(id))));};
  const whole=readCommittedBlobBatches('/immutable',entries,{run,now:()=>0});calls.length=0;
  const split=readCommittedBlobBatches('/immutable',entries,{run,now:()=>0,limit:65});
  assert.deepEqual([...split],[...whole]);assert.equal(calls.length,3);assert.ok(calls.every(c=>c.maxBuffer===65&&c.timeout===60000));
  assert.deepEqual(committedBlobBatches(entries,65).flat().map(e=>e.id),[a,b,c]);
});
test('Exact framing bounds refuse oversize singletons and conflicting declared identities',()=>{
  assert.equal(committedBlobBatches([{id:a,size:5}],54).length,1);
  assert.throws(()=>committedBlobBatches([{id:a,size:5}],53),/single blob/);
  for(const entries of [[{id:a,size:-1}],[{id:'wrong',size:1}],[{id:a,size:1},{id:a,size:2}],[]])assert.throws(()=>committedBlobBatches(entries,65));
  assert.throws(()=>committedBlobBatches([{id:a,size:1}],128*1024**2+1));
  assert.throws(()=>decodeCommittedBlobs([a],blob(a,'alpha'),new Map([[a,4]])),/declared blob size/);
});
test('All batches share one original 60-second deadline; failure never returns a partial plan',()=>{
  const entries=[{id:a,size:5},{id:b,size:4}],clocks=[0,0,40000,40000,40000,59000,59000],calls=[];
  const result=readCommittedBlobBatches('/immutable',entries,{limit:54,now:()=>clocks.shift(),run:(_b,_a,o)=>{calls.push(o);return blob(o.input.trim(),calls.length===1?'alpha':'beta');}});
  assert.equal(result.size,2);assert.deepEqual(calls.map(o=>o.timeout),[60000,20000]);
  let clock=0,count=0;
  assert.throws(()=>readCommittedBlobBatches('/immutable',entries,{limit:54,now:()=>clock,run:(_b,_a,o)=>{count++;clock=60001;return blob(o.input.trim(),'alpha');}}),/deadline/);assert.equal(count,1);
  for(const bytes of [blob(b,'beta'),blob(a,'alpha').subarray(0,-1),Buffer.concat([blob(a,'alpha'),Buffer.from('suffix')])])
    assert.throws(()=>readCommittedBlobBatches('/immutable',[entries[0]],{now:()=>0,run:()=>bytes}));
});

test('Final batch decoding cannot return a partial source map after the shared deadline',()=>{
 const clocks=[0,0,100,60001];
 assert.throws(()=>readCommittedBlobBatches('/immutable',[{id:a,size:5}],{now:()=>clocks.shift(),run:()=>blob(a,'alpha')}),/deadline exceeded after decode/);
});
