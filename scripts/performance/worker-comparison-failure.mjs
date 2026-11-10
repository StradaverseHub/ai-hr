/** Closed, diagnostic-only facts from the existing fictional comparison owner. */
import {driverErrorFact} from './driver-shutdown.mjs';

export const workerDriverFailureFile='worker-driver-failure.json';
const kind='WORKER_COMPARISON_DRIVER_FAILURE_V1';
const stages=new Set(['driver-initialization','pilot-http','browser-launch','browser-baseline',
 'sign-in-and-navigation','navigation-seal','ai-baseline','workflow-baseline','preflight-checks','steady-plan','preflight-lock-gate',
 'loaded-setup','loaded-workload','loaded-acceptance','driver-settlement','unavailable']);
const workloads=new Set(['org-explorer','personnel-switcher','payroll-readiness','movement','payroll-register','saved-reports',
 'attendance-rejection','mixed-workflows','payroll-close-pair','letter-draft','personnel-profile','performance-rewards-drafts',
 'assistant-compatibility','audit-verification','ai-baseline']);
const lockReasons=new Set([null,'window-unknown','samples-unknown','sample-order','sample-failed','sample-unknown',
 'coverage-gap','cadence-unobserved','blocking-observed','application-unobserved','window-unsettled']);
const countKeys=['routeFailures','browserErrors','homeCardFailures','busyResponses','aiBaselineFailures','functionalErrors','transportErrors'];
const fields=(row,keys)=>row!==null&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length
 &&keys.every(key=>Object.hasOwn(row,key));
const integer=(value,maximum)=>Number.isSafeInteger(value)&&value>=0&&value<=maximum;
const knownCount=(value,maximum=1000000)=>value===null||integer(value,maximum);
const count=(rows,test)=>Array.isArray(rows)&&rows.length<=1000000?(test?rows.filter(test).length:rows.length):null;
const errorFact=value=>value?driverErrorFact({name:value.kind,code:value.code}):null;
const validError=value=>value===null||fields(value,['kind','code'])&&errorFact(value).kind===value.kind&&errorFact(value).code===value.code;
const validLock=value=>value===null||fields(value,['reason','coveragePass','observedBlockingSamples','widestGapUs'])
 &&lockReasons.has(value.reason)&&typeof value.coveragePass==='boolean'
 &&knownCount(value.observedBlockingSamples,4097)&&knownCount(value.widestGapUs,910000000);

function lockFacts(value){
 if(!value||!lockReasons.has(value.reason)||typeof value.coveragePass!=='boolean')return null;
 const gaps=[value.openingGapUs,value.interiorGapUs,value.tailGapUs];
 if(!gaps.every(gap=>knownCount(gap,910000000))||!knownCount(value.observedBlockingSamples,4097))return null;
 const observed=gaps.filter(gap=>gap!==null);
 return {reason:value.reason,coveragePass:value.coveragePass,observedBlockingSamples:value.observedBlockingSamples,
  widestGapUs:observed.length?Math.max(...observed):null};
}

export function projectWorkerDriverFailure(stage,workload,report){
 return {kind,stage:stages.has(stage)?stage:'unavailable',workload:workloads.has(workload)?workload:null,
  primary:errorFact(report.driverFailures?.primary),firstSecondary:errorFact(report.driverFailures?.secondary?.[0]),
  counts:{routeFailures:count(report.coverage,row=>row?.status==='failed'),browserErrors:count(report.browserErrors),
   homeCardFailures:count(report.homeCardFailures),busyResponses:count(report.pageBusyResponses),aiBaselineFailures:count(report.aiBaselineFailures),
   functionalErrors:count(report.functionalErrors),transportErrors:count(report.requestErrors)},
  preflightLocks:lockFacts(report.lockSampling?.preflight?.cadence),loadedLocks:lockFacts(report.lockSampling?.loaded?.cadence),
  loadEntered:report.measurementWindow!==undefined,steadyWindowElapsed:typeof report.steady?.load?.windowElapsed==='boolean'
   ?report.steady.load.windowElapsed:null};
}

export function validateWorkerDriverFailure(value){
 return fields(value,['kind','stage','workload','primary','firstSecondary','counts','preflightLocks','loadedLocks','loadEntered','steadyWindowElapsed'])
  &&value.kind===kind&&stages.has(value.stage)&&(value.workload===null||workloads.has(value.workload))
  &&validError(value.primary)&&validError(value.firstSecondary)&&fields(value.counts,countKeys)
  &&countKeys.every(key=>knownCount(value.counts[key]))&&validLock(value.preflightLocks)&&validLock(value.loadedLocks)
  &&typeof value.loadEntered==='boolean'&&(value.steadyWindowElapsed===null
   ||value.loadEntered&&typeof value.steadyWindowElapsed==='boolean')
  ?value:null;
}
