/** Closed, diagnostic-only facts from the existing fictional comparison owner. */
import {driverErrorFact} from './driver-shutdown.mjs';

export const workerDriverFailureFile='worker-driver-failure.json';
export const workerDriverFailureBytes=3584;
const kind='WORKER_COMPARISON_DRIVER_FAILURE_V1';
const stages=new Set(['driver-initialization','pilot-http','browser-launch','browser-baseline',
 'sign-in-and-navigation','navigation-seal','ai-baseline','workflow-baseline','preflight-checks','steady-plan','preflight-lock-gate',
 'loaded-setup','loaded-workload','loaded-acceptance','driver-settlement','unavailable']);
const workloads=new Set(['org-explorer','personnel-switcher','payroll-readiness','movement','payroll-register','saved-reports',
 'attendance-rejection','mixed-workflows','payroll-close-pair','letter-draft','personnel-profile','performance-rewards-drafts',
 'assistant-compatibility','audit-verification','ai-baseline']);
const lockReasons=new Set([null,'window-unknown','samples-unknown','sample-order','sample-failed','sample-unknown',
 'coverage-gap','cadence-unobserved','blocking-observed','application-unobserved','window-unsettled']);
const roles=new Set(['employee','manager','companyHR','groupHR']);
const trafficPhases=new Set(['navigation','home-read','mixed-workflow','claims-create','claims-edit','claims-delete']);
const modules=new Set(['home','claims','personnel','payroll','leave','attendance','roster','analytics','rewards','assistant',
 'reports','lifecycle','performance','other']);
const specificHttpStatuses=new Set([200,302,303,307,308,400,401,403,404,409,429,500,502,503,504]);
const outcomes=new Set([...specificHttpStatuses].map(status=>'http-'+status).concat([
 'http-4xx','http-5xx','http-other','timeout','transport','assertion','lock-timeout','deadlock','statement-timeout','workflow-route-changed','unknown',
]));
const advisoryFamilies=new Set(['access-configuration','ai-control','audit-chain','employment','payroll-history',
 'pay-component-catalog','leave-dependency-configuration','leave-dependency-employment','advisory-unclassified']);
const nativeFamilies=new Set([...advisoryFamilies,'transaction','relation','tuple','unknown']);
const homePhases=new Set(['baseline','loaded']);
// Closed Home card inventory rendered by the personal and HR Home surfaces.
export const homeFailureCards=Object.freeze(['calendar','celebrations','notices','summary','tasks','team','timeOff','today',
 'attendanceOverview','companies','headcount','headcountByCompany','latestPayroll','latestPayrollRun','noticeBoard','pendingLeave',
 'recentActivity','recentlyJoined','upcomingEvents']);
const homeCardSet=new Set([...homeFailureCards,'outside-card']);
const homeMarkers=new Set(['alert','today-unavailable','read-unavailable']);
const homeMessageKey=/^(?:unrecognized|[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){1,5})$/;
const homeSection=/^(?:other|today-[a-z0-9-]{1,48})$/;
const homeCardsPerGroup=3;
const cohortLimit=10;
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

function trafficModule(route){
 if(route==='/')return 'home';
 const [,first,second]=typeof route==='string'?route.split(/[/?]/,3):[];
 const module=first==='admin'?second:first==='me'&&second==='payslip'?'payroll':first;
 return modules.has(module)?module:'other';
}

function trafficOutcome(error){
 const fact=driverErrorFact(error);
 if(fact.kind==='AssertionError'&&typeof error.message==='string'&&error.message.startsWith('Unexpected HTTP status for ')){
  const status=error.actual;
  if(specificHttpStatuses.has(status))return 'http-'+status;
  if(Number.isInteger(status)&&status>=500&&status<=599)return 'http-5xx';
  if(Number.isInteger(status)&&status>=400&&status<=499)return 'http-4xx';
  return 'http-other';
 }
 if(error?.code==='40P01')return 'deadlock';
 if(error?.code==='WORKFLOW_ROUTE_CHANGED')return 'workflow-route-changed';
 if(fact.code==='55P03')return 'lock-timeout';
 if(fact.code==='57014')return 'statement-timeout';
 if(fact.kind==='TimeoutError'||fact.code==='ETIMEDOUT')return 'timeout';
 if(['ECONNRESET','EPIPE','ERR_STREAM_PREMATURE_CLOSE','08006'].includes(fact.code))return 'transport';
 return fact.kind==='AssertionError'?'assertion':'unknown';
}

export function createWorkerLoadedDiagnostics(){
 const traffic=new Map(),families=Object.fromEntries([...advisoryFamilies].map(family=>[family,0]));
 let total=0,activityWaitSamples=0,appAdvisorySamples=0,activityWithoutAdvisorySamples=0;
 return {
  traffic(role,phase,route,error){
   if(total>=500||!roles.has(role)||!trafficPhases.has(phase))return;
   const module=trafficModule(route),outcome=trafficOutcome(error),key=[role,phase,module,outcome].join(':');
   if(!traffic.has(key))traffic.set(key,{role,phase,module,outcome,count:0});
   traffic.get(key).count++;total++;
  },
  lock(activityWaiting,queuedAppFamilies){
   if(activityWaiting>0){activityWaitSamples++;if(!queuedAppFamilies.length)activityWithoutAdvisorySamples++;}
   if(!queuedAppFamilies.length)return;
   appAdvisorySamples++;
   for(const family of new Set(queuedAppFamilies.map(value=>advisoryFamilies.has(value)?value:'advisory-unclassified')))families[family]++;
  },
  facts(){
   const groups=[...traffic.values()].sort((left,right)=>right.count-left.count).slice(0,cohortLimit);
   return {traffic:{total,omitted:total-groups.reduce((sum,row)=>sum+row.count,0),groups},
    loadedAdvisory:{activityWaitSamples,appAdvisorySamples,activityWithoutAdvisorySamples,families}};
  },
 };
}

/** Index rendered message text to its catalog key, so a failure names the message, never its text. */
export function homeFailureMessageCatalog(catalogs){
 const keys=new Map();
 const walk=(value,path)=>{
  if(typeof value==='string'){
   const key=path.join('.'),text=value.trim();
   if(text&&homeMessageKey.test(key)&&key.length<=80&&(!keys.has(text)||key.localeCompare(keys.get(text))<0))keys.set(text,key);
  }else if(value&&typeof value==='object'&&!Array.isArray(value)&&path.length<6){
   for(const [name,child] of Object.entries(value))walk(child,[...path,name]);
  }
 };
 for(const catalog of catalogs)walk(catalog,[]);
 return keys;
}

/** Closed facts for each rendered failure: owning card, marker, Today section and catalog message key. */
export function homeCardFailureFacts(nodes,catalog){
 if(!Array.isArray(nodes))return [];
 return nodes.slice(0,64).map(node=>closedHomeFact({card:node?.card,marker:node?.marker,section:node?.section,
  message:typeof node?.text==='string'?catalog?.get(node.text.trim()):undefined}));
}
const closedMessage=value=>typeof value==='string'&&value.length<=80&&homeMessageKey.test(value)?value:'unrecognized';
function closedHomeFact(value){
 const section=typeof value?.section==='string'?value.section:null;
 return {card:homeCardSet.has(value?.card)?value.card:'outside-card',marker:homeMarkers.has(value?.marker)?value.marker:'alert',
  section:section===null?null:homeSection.test(section)?section:'other',message:closedMessage(value?.message)};
}

function homeFailures(rows){
 if(!Array.isArray(rows)||rows.length>4096)return null;
 const groups=new Map();
 for(const row of rows){
  if(!roles.has(row?.role)||!homePhases.has(row.phase))continue;
  const key=row.role+':'+row.phase;
  if(!groups.has(key))groups.set(key,{role:row.role,phase:row.phase,count:0,cards:new Map()});
  const group=groups.get(key);
  group.count++;
  for(const fact of (Array.isArray(row.cards)?row.cards.slice(0,64):[]).map(closedHomeFact)){
   const id=[fact.card,fact.marker,fact.message].join(':');
   const entry=group.cards.get(id)??{card:fact.card,marker:fact.marker,message:fact.message,count:0};
   entry.count++;group.cards.set(id,entry);
  }
 }
 return [...groups.values()].map(group=>({role:group.role,phase:group.phase,count:group.count,
  cards:[...group.cards.values()].sort((left,right)=>right.count-left.count||left.card.localeCompare(right.card)
   ||left.message.localeCompare(right.message)).slice(0,homeCardsPerGroup)}));
}
const trafficGroup=value=>fields(value,['role','phase','module','outcome','count'])
 &&roles.has(value.role)&&trafficPhases.has(value.phase)&&modules.has(value.module)&&outcomes.has(value.outcome)
 &&integer(value.count,500)&&value.count>0;
const validTraffic=value=>value===null||fields(value,['total','omitted','groups'])&&integer(value.total,500)
 &&integer(value.omitted,500)&&Array.isArray(value.groups)&&value.groups.length<=cohortLimit&&value.groups.every(trafficGroup)
 &&new Set(value.groups.map(row=>[row.role,row.phase,row.module,row.outcome].join(':'))).size===value.groups.length
 &&value.total===value.omitted+value.groups.reduce((sum,row)=>sum+row.count,0);
const validAdvisory=value=>value===null||fields(value,['activityWaitSamples','appAdvisorySamples','activityWithoutAdvisorySamples','families'])
 &&integer(value.activityWaitSamples,4097)&&integer(value.appAdvisorySamples,4097)
 &&integer(value.activityWithoutAdvisorySamples,value.activityWaitSamples)
 &&fields(value.families,[...advisoryFamilies])&&Object.values(value.families).every(count=>integer(count,value.appAdvisorySamples));
const validHomeCard=value=>fields(value,['card','marker','message','count'])&&homeCardSet.has(value.card)&&homeMarkers.has(value.marker)
 &&typeof value.message==='string'&&value.message.length<=80&&homeMessageKey.test(value.message)&&integer(value.count,4096)&&value.count>0;
const validHome=value=>value===null||Array.isArray(value)&&value.length<=roles.size*homePhases.size
 &&value.every(row=>fields(row,['role','phase','count','cards'])&&roles.has(row.role)&&homePhases.has(row.phase)&&integer(row.count,4096)&&row.count>0
  &&Array.isArray(row.cards)&&row.cards.length<=homeCardsPerGroup&&row.cards.every(validHomeCard)
  &&new Set(row.cards.map(card=>[card.card,card.marker,card.message].join(':'))).size===row.cards.length);

export function projectWorkerNativeLockFailures(failures){
 if(!Array.isArray(failures)||failures.length>64)return null;
 const families=Object.fromEntries([...nativeFamilies].map(family=>[family,0]));
 let heavyweight=0,deadlocks=0,lockTimeouts=0,longestWaitMs=null;
 for(const row of failures){
  if(row.kind==='observed heavyweight lock wait'){
   heavyweight++;
   if(Number.isFinite(row.waitMs)&&row.waitMs>=0&&row.waitMs<=910000)
    longestWaitMs=Math.max(longestWaitMs??0,Math.ceil(row.waitMs));
  }else if(row.kind==='deadlock detected')deadlocks++;
  else if(row.kind==='canceling statement due to lock timeout')lockTimeouts++;
  else return null;
  const candidates=[row.diagnostic?.waitFamily,...(row.diagnostic?.edges??[]).map(edge=>edge.family)].filter(Boolean);
  for(const family of new Set((candidates.length?candidates:['unknown']).map(value=>nativeFamilies.has(value)?value:'unknown')))
   families[family]++;
 }
 return {kind:'WORKER_COMPARISON_NATIVE_LOCK_FAILURES_V1',phase:'application-runtime',thresholdMs:100,
  retainedEntries:failures.length,atRetentionCap:failures.length===64,heavyweight,deadlocks,lockTimeouts,longestWaitMs,families};
}

/** @param {ReturnType<ReturnType<typeof createWorkerLoadedDiagnostics>['facts']>|null} [loaded] */
export function projectWorkerDriverFailure(stage,workload,report,loaded=null){
 const result=projectDriverFailure(stage,workload,report,loaded);
 // The runner reads at most 4,096 bytes. Card detail yields to the counts before that bound.
 for(const keep of [homeCardsPerGroup-1,0]){
  if(Buffer.byteLength(JSON.stringify(result))<=workerDriverFailureBytes||!result.homeFailures)break;
  result.homeFailures=result.homeFailures.map(row=>({...row,cards:row.cards.slice(0,keep)}));
 }
 return result;
}
function projectDriverFailure(stage,workload,report,loaded){
 return {kind,stage:stages.has(stage)?stage:'unavailable',workload:workloads.has(workload)?workload:null,
  primary:errorFact(report.driverFailures?.primary),firstSecondary:errorFact(report.driverFailures?.secondary?.[0]),
  counts:{routeFailures:count(report.coverage,row=>row?.status==='failed'),browserErrors:count(report.browserErrors),
   homeCardFailures:count(report.homeCardFailures),busyResponses:count(report.pageBusyResponses),aiBaselineFailures:count(report.aiBaselineFailures),
   functionalErrors:count(report.functionalErrors),transportErrors:count(report.requestErrors)},
  preflightLocks:lockFacts(report.lockSampling?.preflight?.cadence),loadedLocks:lockFacts(report.lockSampling?.loaded?.cadence),
  traffic:report.measurementWindow===undefined?null:loaded?.traffic??null,
  loadedAdvisory:report.measurementWindow===undefined?null:loaded?.loadedAdvisory??null,homeFailures:homeFailures(report.homeCardFailures),
  loadEntered:report.measurementWindow!==undefined,steadyWindowElapsed:typeof report.steady?.load?.windowElapsed==='boolean'
   ?report.steady.load.windowElapsed:null};
}

export function validateWorkerDriverFailure(value){
 return fields(value,['kind','stage','workload','primary','firstSecondary','counts','preflightLocks','loadedLocks','traffic','loadedAdvisory','homeFailures','loadEntered','steadyWindowElapsed'])
  &&value.kind===kind&&stages.has(value.stage)&&(value.workload===null||workloads.has(value.workload))
  &&validError(value.primary)&&validError(value.firstSecondary)&&fields(value.counts,countKeys)
  &&countKeys.every(key=>knownCount(value.counts[key]))&&validLock(value.preflightLocks)&&validLock(value.loadedLocks)
  &&validTraffic(value.traffic)&&validAdvisory(value.loadedAdvisory)&&validHome(value.homeFailures)
  &&typeof value.loadEntered==='boolean'&&(value.loadEntered||value.traffic===null&&value.loadedAdvisory===null)&&(value.steadyWindowElapsed===null
   ||value.loadEntered&&typeof value.steadyWindowElapsed==='boolean')
  ?value:null;
}
