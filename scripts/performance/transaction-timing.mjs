// Preloaded only in the isolated application workers. Never records queries or identities.
import {renameSync,writeFileSync} from 'node:fs';
import {createHistogram,performance} from 'node:perf_hooks';

const path=process.env.PERF_TX_TIMING_PATH;
if(process.env.GITHUB_ACTIONS==='true'&&path){
 const startDelay=createHistogram(),held=createHistogram();
 const windows=[];
 let windowStart=Date.now();
 let pending=0,holding=0,peakPending=0,peakHolding=0,failedBeforeCallback=0;
 const record=(histogram,ms)=>histogram.record(Math.max(1,Math.round(ms*1e6)));
 const describe=histogram=>({
  count:histogram.count,
  p50Ms:histogram.count?histogram.percentile(50)/1e6:null,
  p95Ms:histogram.count?histogram.percentile(95)/1e6:null,
  p99Ms:histogram.count?histogram.percentile(99)/1e6:null,
 });
 globalThis.__aihrPerfBeginTransaction=()=>{
  const requested=performance.now();
  let entered;
  peakPending=Math.max(peakPending,++pending);
  return {
   acquired(){
    entered=performance.now();
    pending--;
    peakHolding=Math.max(peakHolding,++holding);
    record(startDelay,entered-requested);
   },
   finished(){
    if(entered===undefined){
     pending--;
     failedBeforeCallback++;
    }else{
     holding--;
     record(held,performance.now()-entered);
    }
   },
  };
 };
 const save=()=>{
  try{
   const capturedAt=Date.now();
   windows.push({from:windowStart,to:capturedAt,pending,holding,startDelay:describe(startDelay),held:describe(held)});
   if(windows.length>180)windows.shift();
   windowStart=capturedAt;
   startDelay.reset();held.reset();
   writeFileSync(path+'.tmp',JSON.stringify({
    scope:'Application withTenant transactions in bounded five-second windows. Start delay includes pool wait, database BEGIN and callback scheduling. Held includes callback and transaction completion.',
    capturedAt:new Date(capturedAt).toISOString(),peakPending,peakHolding,failedBeforeCallback,windows,
   }));
   renameSync(path+'.tmp',path);
  }catch{/* Evidence collection must never fail a request. */}
 };
 setInterval(save,5000).unref();
 process.once('beforeExit',save);
}
