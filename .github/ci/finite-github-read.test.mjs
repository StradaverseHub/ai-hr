import test from 'node:test';
import assert from 'node:assert/strict';
import {finiteGithubJson,finiteGithubPages} from './finite-github-read.mjs';
const http=(status,body='{}')=>'HTTP/2.0 '+status+' Status\r\ncontent-type: application/json\r\n\r\n'+body;
const pageNumber=path=>Number(new URL('https://api.invalid/'+path).searchParams.get('page'));
const fail=status=>Object.assign(Error('transport'),{stdout:http(status),stderr:'gh: Server Error (HTTP '+status+')\n'});
test('finite metadata GET retries only known transient status, records failures and preserves request identity',()=>{
 const requests=[],events=[],waits=[];let count=0;
 const result=finiteGithubJson('actions/runs/1',{execute:(bin,args,options)=>{requests.push({bin,args,timeout:options.timeout});if(++count<3)throw fail(count===1?502:503);return http(200,'{"id":1}');},sleep:n=>waits.push(n),audit:e=>events.push(e)});
 assert.deepEqual(result,{id:1});assert.equal(requests.length,3);assert(requests.every(r=>JSON.stringify(r)===JSON.stringify(requests[0])));assert.deepEqual(requests[0].args.slice(0,3),['api','--method','GET']);assert.deepEqual(waits,[250,1000]);assert.deepEqual(events.map(e=>e.status),[502,503]);assert(events.every(e=>e.retry&&e.releaseAuthorized===false&&!JSON.stringify(e).includes('Server Error')));
});
test('finite metadata retry cap and permanent errors fail closed without body or credential publication',()=>{
 for(const status of [401,403,404,429,500,502,503,504]){
  let count=0;const events=[];assert.throws(()=>finiteGithubJson('actions/runs/1',{execute:()=>{count++;throw fail(status);},sleep:()=>{},audit:e=>events.push(e)}),/refused/);
  assert.equal(count,[502,503,504].includes(status)?3:1);assert.equal(events.at(-1).retry,false);
 }
 let messages=0;assert.throws(()=>finiteGithubJson('actions/runs/1',{execute:()=>{messages++;throw Object.assign(fail(403),{stdout:http(403,'{"message":"HTTP 502"}'),stderr:'gh: HTTP 502 mentioned (HTTP 403)'});},sleep:()=>assert.fail('permanent error retried'),audit:()=>{}}));assert.equal(messages,1);
 let unknown=0;assert.throws(()=>finiteGithubJson('actions/runs/1',{execute:()=>{unknown++;throw {stdout:'{"status":502}',stderr:'HTTP 502 in untrusted text'};},audit:()=>{},sleep:()=>assert.fail('unknown transport retried')}));assert.equal(unknown,1);
 let count=0;assert.throws(()=>finiteGithubJson('actions/runs/1',{execute:()=>{count++;return http(200,'invalid-json');},audit:()=>{},sleep:()=>{}}),/without retry/);assert.equal(count,1);
 for(const path of ['../foreign','actions/runs/1\nsecret','actions/runs/../2','actions/runs/%2e%2e/2','https://foreign.invalid','actions/artifacts/1/zip','actions/runs/1/logs','actions/runs/1/arbitrary','actions/runs/1/jobs?foo=bar','actions/runs/1/jobs?filter=latest','actions/runs/1/jobs?page=1&page=2','actions/runs/1/jobs?per_page=101','actions/workflows/alpha.yml?url=https://foreign.invalid'])assert.throws(()=>finiteGithubJson(path,{execute:()=>assert.fail('unsafe request executed')}),/GET path/);
});
test('25-job pages preserve exact full75 identities and1000bound, refusing omissions, duplicates and drift',()=>{
 const rows=Array.from({length:75},(_,i)=>({id:i+1})),queries=[];
 const read=path=>{queries.push(path);const page=Number(new URL('https://api.invalid/'+path).searchParams.get('page'));return {total_count:75,jobs:rows.slice((page-1)*25,page*25)};};
 assert.deepEqual(finiteGithubPages('actions/runs/1/jobs?filter=all','jobs',{read}),rows);assert.equal(queries.length,3);assert(queries.every(p=>p.includes('per_page=25')));
 for(const mutate of [d=>d.total_count=1001,d=>d.total_count=76,d=>d.jobs=d.jobs.slice(1),d=>d.jobs[0]={id:0}])assert.throws(()=>finiteGithubPages('actions/runs/1/jobs','jobs',{read:p=>{const d=read(p);mutate(d);return d;}}));
 assert.throws(()=>finiteGithubPages('actions/runs/1/jobs','jobs',{read:p=>{const d=read(p);if(pageNumber(p)===2)d.jobs[0]={id:1};return d;}}),/Duplicate/);
 assert.throws(()=>finiteGithubPages('actions/runs/1/jobs','jobs',{read:p=>{const d=read(p);if(pageNumber(p)===2)d.total_count++;return d;}}),/changed/);
 const artifacts=Array.from({length:101},(_,i)=>({id:i+1}));assert.deepEqual(finiteGithubPages('actions/runs/1/artifacts','artifacts',{read:p=>({total_count:101,artifacts:pageNumber(p)===1?artifacts.slice(0,100):artifacts.slice(100)})}),artifacts);
});
