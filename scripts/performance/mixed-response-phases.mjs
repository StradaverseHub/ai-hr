const roles=new Set(['employee','manager','companyHR','groupHR']);
const methods=new Set(['GET','POST']);

function p95(values){
 const ordered=values.toSorted((a,b)=>a-b);
 return Math.round(ordered[Math.ceil(ordered.length*.95)-1]);
}

/** Keep only aggregate timings and exact allowlisted routes from the driver's private HTTP samples. */
export function summarizeMixedResponsePhases(samples,{steadyStartPerformanceMs:start,steadyUntilPerformanceMs:until}={},knownRoutes){
 if(!Array.isArray(samples)||!Number.isFinite(start)||!Number.isFinite(until)||until<=start)return [];
 const buckets=new Map();
 for(const row of samples){
  const {role,route,method,startedMs,status,ttfbMs,durationMs}=row??{};
  if(!roles.has(role)||!methods.has(method)||!knownRoutes.has(route))continue;
  if(!Number.isFinite(startedMs)||startedMs<start||startedMs>=until)continue;
  if(!Number.isSafeInteger(status)||status<200||status>=400)continue;
  if(!Number.isFinite(ttfbMs)||!Number.isFinite(durationMs)||ttfbMs<0||durationMs<ttfbMs)continue;
  const key=JSON.stringify([role,route,method]);
  const bucket=buckets.get(key)??{role,route,method,headers:[],afterHeaders:[],complete:[]};
  bucket.headers.push(ttfbMs);
  bucket.afterHeaders.push(durationMs-ttfbMs);
  bucket.complete.push(durationMs);
  buckets.set(key,bucket);
 }
 return [...buckets.values()].map(({role,route,method,headers,afterHeaders,complete})=>({
  role,route,method,samples:headers.length,headersP95Ms:p95(headers),
  afterHeadersP95Ms:p95(afterHeaders),completionP95Ms:p95(complete),
 })).sort((a,b)=>a.role.localeCompare(b.role)||a.route.localeCompare(b.route)||a.method.localeCompare(b.method));
}

/** Completed HTTP error responses are distinct from transport failures and may include expected denials. */
export function summarizeMixedErrorStatuses(samples,{startPerformanceMs:start}={},knownRoutes){
 if(!Array.isArray(samples)||!Number.isFinite(start))return null;
 const buckets=new Map();
 let total=0;
 for(const row of samples){
  const {role,route,method,status,startedMs}=row??{};
  if(!Number.isFinite(startedMs)||startedMs<start||!roles.has(role)||!methods.has(method))continue;
  if(!Number.isSafeInteger(status)||status<400||status>599)continue;
  const routeTemplate=knownRoutes.has(route)?route:null;
  const key=JSON.stringify([role,routeTemplate,method,status]);
  const bucket=buckets.get(key)??{role,route:routeTemplate,method,status,count:0};
  bucket.count++;
  total++;
  buckets.set(key,bucket);
 }
 const groups=[...buckets.values()].sort((a,b)=>b.count-a.count||a.status-b.status);
 return {total,rows:groups.slice(0,40),omittedGroups:Math.max(0,groups.length-40)};
}
