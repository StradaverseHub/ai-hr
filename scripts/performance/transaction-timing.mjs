// Preloaded only in the isolated application workers. Never records queries or identities.
import {renameSync,writeFileSync} from 'node:fs';
import {createHistogram,monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {observeHomeRequests} from './home-request-timing.mjs';

const path=process.env.PERF_TX_TIMING_PATH;
if(process.env.GITHUB_ACTIONS==='true'&&path){
 const homeRequests=observeHomeRequests();
 const eventLoop=monitorEventLoopDelay({resolution:20});eventLoop.enable();
 const startDelay=createHistogram(),held=createHistogram();
 const approvalWait=createHistogram(),approvalWork=createHistogram();
 const passiveWait=createHistogram(),passiveWork=createHistogram();
 const rawWait=createHistogram(),rawWork=createHistogram();
 const windows=[],observedPoolSizes=new Set();
 let windowStart=Date.now();
 let pending=0,holding=0,peakPending=0,peakHolding=0,failedBeforeCallback=0;
 let approvalPending=0,approvalRunning=0,peakApprovalPending=0;
 let passivePending=0,passiveRunning=0,peakPassivePending=0,passiveFailedBeforeRead=0;
 let rawPending=0,rawRunning=0,peakRawPending=0,rawFailedBeforeWork=0;
 const admissionCounts=()=>({immediate:0,miss:0,recovered:0,blockingFallback:0});
 const admissionWindow=()=>({submission:admissionCounts(),approval:admissionCounts(),clockingImport:admissionCounts()});
 let attendanceExclusiveAdmission=admissionWindow();
 const record=(histogram,ms)=>histogram.record(Math.max(1,Math.round(ms*1e6)));
 const describe=histogram=>({
  count:histogram.count,
  p50Ms:histogram.count?histogram.percentile(50)/1e6:null,
  p95Ms:histogram.count?histogram.percentile(95)/1e6:null,
  p99Ms:histogram.count?histogram.percentile(99)/1e6:null,
 });
 globalThis.__aihrPerfBeginTransaction=poolMax=>{
  if(Number.isInteger(poolMax))observedPoolSizes.add(poolMax);
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
 globalThis.__aihrPerfBeginAttendanceApproval=()=>{
  const requested=performance.now();
  let entered;
  peakApprovalPending=Math.max(peakApprovalPending,++approvalPending);
  return {
   acquired(){
    entered=performance.now();
    approvalPending--;
    approvalRunning++;
    record(approvalWait,entered-requested);
   },
   finished(){
    if(entered===undefined){
     approvalPending--;
     return;
    }
    approvalRunning--;
    record(approvalWork,performance.now()-entered);
   },
  };
 };
 globalThis.__aihrPerfBeginBackgroundRead=()=>{
  const requested=performance.now();let entered;
  peakPassivePending=Math.max(peakPassivePending,++passivePending);
  return {
   acquired(){entered=performance.now();passivePending--;passiveRunning++;record(passiveWait,entered-requested);},
   finished(){if(entered===undefined){passivePending--;passiveFailedBeforeRead++;}else{passiveRunning--;record(passiveWork,performance.now()-entered);}},
  };
 };
 globalThis.__aihrPerfBeginPoolWork=poolMax=>{
  if(Number.isInteger(poolMax))observedPoolSizes.add(poolMax);
  const requested=performance.now();let entered;
  peakRawPending=Math.max(peakRawPending,++rawPending);
  return {
   acquired(){entered=performance.now();rawPending--;rawRunning++;record(rawWait,entered-requested);},
   finished(){if(entered===undefined){rawPending--;rawFailedBeforeWork++;}else{rawRunning--;record(rawWork,performance.now()-entered);}},
  };
 };
 globalThis.__aihrPerfAttendanceExclusiveAdmission=(operation,outcome)=>{
  attendanceExclusiveAdmission[operation][outcome]++;
 };
 const save=()=>{
  try{
   const capturedAt=Date.now();
   windows.push({from:windowStart,to:capturedAt,pending,holding,startDelay:describe(startDelay),held:describe(held),
    eventLoopDelay:{samples:eventLoop.count,p95Ms:eventLoop.count?eventLoop.percentile(95)/1e6:null,maxMs:eventLoop.count?eventLoop.max/1e6:null},
    passiveRead:{pending:passivePending,running:passiveRunning,queueWait:describe(passiveWait),afterAdmission:describe(passiveWork)},
    rawPoolWork:{pending:rawPending,running:rawRunning,queueWait:describe(rawWait),afterAdmission:describe(rawWork)},
    attendanceApproval:{pending:approvalPending,running:approvalRunning,queueWait:describe(approvalWait),afterAdmission:describe(approvalWork)},
    attendanceExclusiveAdmission});
   if(windows.length>180)windows.shift();
   windowStart=capturedAt;
   attendanceExclusiveAdmission=admissionWindow();
   startDelay.reset();held.reset();approvalWait.reset();approvalWork.reset();passiveWait.reset();passiveWork.reset();rawWait.reset();rawWork.reset();eventLoop.reset();
   writeFileSync(path+'.tmp',JSON.stringify({
    scope:'Application withTenant transactions in bounded five-second windows. Start delay includes pool wait, database BEGIN and callback scheduling. Held includes callback and transaction completion.',
    attendanceApprovalScope:'Process-local native approvals only. Queue wait ends before requesting a connection. After admission includes pool, locks, transaction and any fallback. No identities.',
    attendanceExclusiveAdmissionScope:'Owned exclusive Attendance writes only. Miss counts failed tries, including both tries before blocking fallback. No identities.',
    passiveReadScope:'Logical passive read admission before fan-out. Its pending work holds no database connection. No identities.',peakPassivePending,passiveFailedBeforeRead,
    rawPoolWorkScope:'Existing raw owners admitted before opening queries. Queue wait ends at application admission; afterAdmission includes checkout, serial queries and completion. No identities.',peakRawPending,rawFailedBeforeWork,
    homeStartupReadiness:globalThis.__aihrHomeStartupReadiness??null,
    homeRequests:homeRequests(),peakApprovalPending,capturedAt:new Date(capturedAt).toISOString(),observedPoolSizes:[...observedPoolSizes],peakPending,peakHolding,failedBeforeCallback,windows,
   }));
   renameSync(path+'.tmp',path);
  }catch{/* Evidence collection must never fail a request. */}
 };
 setInterval(save,5000).unref();
 process.once('beforeExit',save);
}
