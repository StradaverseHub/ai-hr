import {performance} from 'node:perf_hooks';
import {parentPort,workerData} from 'node:worker_threads';
import postgres from 'postgres';
import {measuredDevelopmentLockApplication,measuredDevelopmentLockUrl,observeMeasuredLockConnection,startMeasuredPreflightProbes} from './measured-lock-observer.mjs';

const {url,accessLocks,auditLocks,categorized,token,stopped}=workerData;
if(url!==measuredDevelopmentLockUrl)throw Error('Measured preflight lock observer database refused');
const sql=postgres(url,{max:1,connect_timeout:2,onnotice:()=>{},
 connection:{application_name:measuredDevelopmentLockApplication,default_transaction_read_only:'on',statement_timeout:'400ms'}});
const close=Promise.withResolvers();
let state='starting',sampler;

parentPort.on('message',command=>{
 if(command==='stop'){close.resolve();return;}
 if(command!=='start'||state!=='ready'){close.reject(Error('Measured lock observer command refused'));return;}
 state='running';
 sampler=startMeasuredPreflightProbes({sql,accessLocks,auditLocks,categorized,token,stopped,
  onProbe:probe=>parentPort.postMessage({kind:'probe',...probe}),onFailure:close.reject});
 parentPort.postMessage({kind:'started'});
});

try{
 try{
  await observeMeasuredLockConnection(sql);
  state='ready';
  parentPort.postMessage({kind:'ready',timeOrigin:performance.timeOrigin});
  await close.promise;
 }finally{
  try{await sampler?.stop();}finally{await sql.end({timeout:2});}
 }
 parentPort.postMessage({kind:'closed',samples:sampler?.samples()??0});
}finally{parentPort.close();}
