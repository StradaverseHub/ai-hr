/** Observed steady-window latency by actual role and route; no cross-route pooling. */
export function routeLatency({samples,pageInteractions,routePools,homeTemplates,steadyStart,steadyUntil}) {
 if(!Number.isFinite(steadyStart)||!Number.isFinite(steadyUntil)||steadyUntil<=steadyStart)throw new RangeError('Invalid steady window');
 const inside=row=>row.startedMs>=steadyStart&&row.startedMs<steadyUntil;
 const buckets=new Map();
 const keyFor=(kind,role,route,action)=>JSON.stringify([kind,role,route,action]);
 const add=(kind,role,route,action)=>{
  const key=keyFor(kind,role,route,action);
  if(!buckets.has(key))buckets.set(key,{kind,role,route,...(action?{action}:{}),values:[]});
  return buckets.get(key);
 };
 for(const [role,routes] of Object.entries(routePools))for(const route of routes){add('read',role,route);add('navigation',role,route);}
 for(const {role,requests} of homeTemplates)for(const {path} of requests)add('read',role,path);
 for(const row of samples){
  const bucket=row.method==='POST'
   ?add('write',row.role,row.route,row.action)
   :row.method==='GET'?buckets.get(keyFor('read',row.role,row.route)):undefined;
  if(bucket&&inside(row))bucket.values.push(row.durationMs);
 }
 for(const row of pageInteractions)if(inside(row)){
  buckets.get(keyFor('navigation',row.role,row.route))?.values.push(row.durationMs);
 }
 const rows=[...buckets.values()].map(({values,...bucket})=>{
  values.sort((a,b)=>a-b);
  if(values.some(value=>!Number.isFinite(value)||value<0))throw new RangeError('Invalid route duration');
  const percentile=fraction=>values[Math.ceil(values.length*fraction)-1]??null;
  const p95Ms=percentile(.95),targetMs=bucket.kind==='write'?500:1000;
  return {...bucket,samples:values.length,p50Ms:percentile(.5),p95Ms,p99Ms:percentile(.99),maxMs:values.at(-1)??null,targetMs,
   targetMet:values.length>0&&p95Ms<targetMs,sparseSample:values.length<20};
 });
 return {rows,targetMet:rows.length>0&&rows.every(row=>row.targetMet),
  missing:rows.filter(row=>row.samples===0),slow:rows.filter(row=>row.samples>0&&!row.targetMet),
  sparse:rows.filter(row=>row.samples>0&&row.sparseSample),sampleCaveat:'Observed nearest-rank percentiles; fewer than20 samples are explicitly sparse and do not establish a precise population percentile.'};
}
