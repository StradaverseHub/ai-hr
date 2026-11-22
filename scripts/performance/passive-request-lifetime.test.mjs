import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {test} from 'node:test';
import {observePassiveRequestLifetime} from './passive-request-lifetime.mjs';

test('counts unfinished responses without treating finished ones or detached reads as aborts',async()=>{
 const observer=observePassiveRequestLifetime();
 observer.begin();
 let completed;
 const finished=new Promise(resolve=>{completed=resolve;});
 const server=http.createServer(async(request,response)=>{
  if(request.url==='/finished'){
   const read=observer.begin();
   read.acquired();
   read.finished();
   response.end();
   return;
  }
  const queued=observer.begin(),running=observer.begin(),refused=observer.begin();
  running.acquired();
  response.write('partial response');
  await once(response,'close');
  queued.acquired();
  queued.finished();
  running.finished();
  refused.finished();
  observer.begin().finished();
  completed();
 });
 try{
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const normal=await fetch(base+'/finished');
  await normal.text();
  await new Promise((resolve,reject)=>{
   const request=http.get(base+'/aborted',response=>{
    response.once('data',()=>{response.destroy();resolve();});
    response.once('error',reject);
   });
   request.once('error',reject);
  });
  await finished;
  assert.deepEqual(observer.drain(),{attached:5,unattached:1,pendingAtAbort:2,runningAtAbort:1,
   requestedAfterAbort:1,enteredAfterAbort:1,exitedBeforeEntryAfterAbort:2,finishedAfterAbort:2});
  assert.equal(observer.drain().attached,0);
 }finally{
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
 }
});
