/** Observed steady-window latency by actual role and route; no cross-route pooling. */
export function routeLatency({samples,pageInteractions,routePools,homeTemplates,steadyStart,steadyUntil}) {
 if(!Number.isFinite(steadyStart)||!Number.isFinite(steadyUntil)||steadyUntil<=steadyStart)throw new RangeError('Invalid steady window');
 const inside=row=>row.startedMs>=steadyStart&&row.startedMs<steadyUntil;
 const reads=samples.filter(row=>inside(row)&&row.method==='GET');
 const writes=samples.filter(row=>inside(row)&&row.method==='POST');
 const navigation=pageInteractions.filter(inside),buckets=new Map();
 const add=(kind,role,route)=>{buckets.set(JSON.stringify([kind,role,route]),{kind,role,route});};
 for(const [role,routes] of Object.entries(routePools))for(const route of routes){add('read',role,route);add('navigation',role,route);}
 for(const {role,requests} of homeTemplates)for(const {path} of requests)add('read',role,path);
 for(const row of writes)add('write',row.role,row.route);
 const rows=[...buckets.values()].map(bucket=>{
  const source=bucket.kind==='navigation'?navigation:bucket.kind==='write'?writes:reads;
  const values=source.filter(row=>row.role===bucket.role&&row.route===bucket.route).map(row=>row.durationMs).sort((a,b)=>a-b);
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
