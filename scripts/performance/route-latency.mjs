/** Observed steady-window latency by actual role and route; no cross-route pooling. */
const minimumSteadySamples=20;
const recordId=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const mixedActionRouteTemplates=Object.freeze(['/payroll/[batchId]','/attendance/my-records/[date]','/attendance/application-history/[id]']);

export function mixedActionRoute(route,action) {
 const [root,module,view,record,extra]=route.split('/');
 if(root!==''||extra!==undefined)return route;
 if(action==='payrollProcess'&&module==='payroll'&&record===undefined&&recordId.test(view))return '/payroll/[batchId]';
 if(module!=='attendance')return route;
 if((action==='attendanceCreate'||action==='attendanceForm')&&view==='my-records'&&/^\d{4}-\d{2}-\d{2}$/.test(record))return '/attendance/my-records/[date]';
 if(action==='attendanceApprove'&&view==='application-history'&&recordId.test(record))return '/attendance/application-history/[id]';
 return route;
}

/** @typedef {{role: string, route: string, action: string}} PlannedAction */
/** @typedef {{role: string, route: string, action?: string, method: string, startedMs: number, timed: boolean}} TransportFailure */
export function routeLatency({
 samples,pageInteractions,routePools,homeTemplates,
 requestErrors=/** @type {TransportFailure[]} */ ([]),
 plannedReads=/** @type {PlannedAction[]} */ ([]),
 plannedWrites=/** @type {PlannedAction[]} */ ([]),
 steadyStart,steadyUntil,
}) {
 if(!Number.isFinite(steadyStart)||!Number.isFinite(steadyUntil)||steadyUntil<=steadyStart)throw new RangeError('Invalid steady window');
 const inside=row=>row.startedMs>=steadyStart&&row.startedMs<steadyUntil;
 const buckets=new Map();
 const keyFor=(kind,role,route,action)=>JSON.stringify([kind,role,route,action]);
 const add=(kind,role,route,action)=>{
  const key=keyFor(kind,role,route,action);
  if(!buckets.has(key))buckets.set(key,{kind,role,route,...(action?{action}:{}),values:[],transportFailures:0});
  return buckets.get(key);
 };
 for(const [role,routes] of Object.entries(routePools))for(const route of routes){add('read',role,route);add('navigation',role,route);}
 for(const {role,requests} of homeTemplates)for(const {path} of requests)add('read',role,path);
 for(const {role,route,action} of plannedReads)add('read',role,mixedActionRoute(route,action),action);
 for(const {role,route,action} of plannedWrites)add('write',role,mixedActionRoute(route,action),action);
 const httpBucket=row=>row.method==='POST'
   ?add('write',row.role,mixedActionRoute(row.route,row.action),row.action)
   :row.method==='GET'?(buckets.get(keyFor('read',row.role,mixedActionRoute(row.route,row.action),row.action))
    ??buckets.get(keyFor('read',row.role,row.route))):undefined;
 for(const row of samples){
  const bucket=httpBucket(row);
  if(bucket&&inside(row))bucket.values.push(row.durationMs);
 }
 for(const row of requestErrors)if(row.timed===true&&inside(row)){
  const bucket=httpBucket(row);
  if(bucket)bucket.transportFailures++;
 }
 for(const row of pageInteractions)if(inside(row)){
  buckets.get(keyFor('navigation',row.role,row.route))?.values.push(row.durationMs);
 }
 const rows=[...buckets.values()].map(({values,transportFailures,...bucket})=>{
  values.sort((a,b)=>a-b);
  if(values.some(value=>!Number.isFinite(value)||value<0))throw new RangeError('Invalid route duration');
  const percentile=fraction=>values[Math.ceil(values.length*fraction)-1]??null;
  const p95Ms=percentile(.95),targetMs=bucket.kind==='write'?500:1000;
  const sparseSample=values.length<minimumSteadySamples;
  const attempts=values.length+transportFailures;
  const completedWithinTarget=values.filter(value=>value<targetMs).length;
  const requiredCompletions=Math.ceil(attempts*.95);
  return {...bucket,samples:values.length,p50Ms:percentile(.5),p95Ms,p99Ms:percentile(.99),maxMs:values.at(-1)??null,targetMs,
   ...(bucket.kind!=='navigation'&&{attempts,transportFailures,completedWithinTarget}),
   targetMet:!sparseSample&&completedWithinTarget>=requiredCompletions,sparseSample};
 });
 return {rows,minimumSteadySamples,targetMet:rows.length>0&&rows.every(row=>row.targetMet),
  missing:rows.filter(row=>row.samples===0),slow:rows.filter(row=>row.samples>0&&row.p95Ms>=row.targetMs),
  sparse:rows.filter(row=>row.samples>0&&row.sparseSample),
  sampleCaveat:'Percentiles use completed timed responses. The target requires at least 20 completions and at least 95% of timed attempts to complete below the limit.'};
}
