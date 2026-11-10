import {performance} from 'node:perf_hooks';
import {parentPort,workerData} from 'node:worker_threads';
import postgres from 'postgres';
import {measuredDevelopmentLockApplication,measuredDevelopmentLockUrl,observeMeasuredLockConnection,startMeasuredPreflightProbes} from './measured-lock-observer.mjs';

const {url,accessLocks,auditLocks,categorized,token,stopped}=workerData;
if(url!==measuredDevelopmentLockUrl)throw Error('Measured preflight lock observer database refused');
const connect=()=>postgres(url,{max:1,connect_timeout:2,onnotice:()=>{},
 connection:{application_name:measuredDevelopmentLockApplication,default_transaction_read_only:'on',statement_timeout:'400ms'}});
const sql=connect(),rescueSql=connect();
const close=Promise.withResolvers();
let state='starting',sampler;

parentPort.on('message',command=>{
 if(command==='stop'){close.resolve();return;}
 if(command!=='start'||state!=='ready'){close.reject(Error('Measured lock observer command refused'));return;}
 state='running';
 sampler=startMeasuredPreflightProbes({sql,rescueSql,accessLocks,auditLocks,categorized,token,stopped,
  onProbe:probe=>parentPort.postMessage({kind:'probe',...probe}),onFailure:close.reject});
 parentPort.postMessage({kind:'started'});
});

try{
 try{
  const [primary,rescue]=await Promise.all([observeMeasuredLockConnection(sql),observeMeasuredLockConnection(rescueSql)]);
  if(primary===rescue)throw Error('Measured lock observer connections are not independent');
  state='ready';
  parentPort.postMessage({kind:'ready',timeOrigin:performance.timeOrigin});
  await close.promise;
 }finally{
  try{await sampler?.stop();}finally{
   const outcomes=await Promise.allSettled([sql.end({timeout:2}),rescueSql.end({timeout:2})]);
   if(outcomes.some(outcome=>outcome.status==='rejected'))throw Error('Measured lock observer connections did not settle');
  }
 }
 parentPort.postMessage({kind:'closed',samples:sampler?.samples()??0});
}finally{parentPort.close();}
