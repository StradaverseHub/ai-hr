/** Advisory timing data only. Caller authenticates origins; this module never selects or accepts test coverage. */
import assert from'node:assert/strict';
import{validateDurationHints}from'./db-scheduling.mjs';
const filePattern=/^test\/[A-Za-z0-9_./-]+(?:\.test\.ts|\.dom\.test\.tsx)$/;
const validFile=f=>filePattern.test(f)&&!f.split('/').some(p=>!p||p==='.'||p==='..');
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function refreshDurationHints({prior,target,sourceBlobs,observations,origins}){
 validateDurationHints(prior);assert(sha(target),'Exact advisory target required');
 assert(sourceBlobs&&typeof sourceBlobs==='object'&&!Array.isArray(sourceBlobs)&&observations&&typeof observations==='object'&&!Array.isArray(observations),'Explicit source and observed intervals required');
 const files=Object.keys(sourceBlobs).sort(compare);assert(files.length>0&&files.length<=100000&&files.every(f=>validFile(f)&&sha(sourceBlobs[f])),'Bounded complete supplied source inventory required');
 assert(Array.isArray(origins)&&origins.length>0&&origins.length<=100,'Bounded timing origin inventory required');const ids=new Set();
 for(const origin of origins){assert(Number.isSafeInteger(origin.runId)&&origin.runId>0&&!ids.has(origin.runId)&&sha(origin.candidate)&&sha(origin.controller)&&['success','failure'].includes(origin.conclusion),'Distinct explicit timing origins required');ids.add(origin.runId);}
 for(const[file,rows]of Object.entries(observations)){assert(validFile(file)&&Array.isArray(rows)&&rows.length>0&&rows.length<=origins.length,'Invalid observed file interval inventory');const seen=new Set();for(const row of rows){assert(ids.has(row.runId)&&!seen.has(row.runId)&&sha(row.blob)&&Number.isSafeInteger(row.durationMs)&&row.durationMs>0&&row.durationMs<=3600000,'Invalid or unbound file interval');seen.add(row.runId);}}
 const durations={...prior.durationsMs},adopted={},fallback=[];
 for(const file of files){const matching=(observations[file]??[]).filter(row=>row.blob===sourceBlobs[file]);if(matching.length){durations[file]=Math.max(...matching.map(row=>row.durationMs));adopted[file]=sourceBlobs[file];}else{durations[file]=Math.max(prior.durationsMs[file]??prior.unknownDurationMs,prior.unknownDurationMs);fallback.push(file);}}
 const profile={...prior,origins:[...(prior.origins??[]),...origins],blobBoundRefresh:{kind:'ADVISORY_TIMING_NOT_COVERAGE_OR_PASS',target,selection:'maximum authenticated observed interval whose file blob matches target; round up to at least 1 ms',files:files.length,adoptedInputBlobs:adopted,changedOrUnobserved:fallback,releaseAuthorized:false},durationsMs:Object.fromEntries(Object.entries(durations).sort(([a],[b])=>compare(a,b)))};
 validateDurationHints(profile);return{profile,assessment:{kind:'TIMING_HINT_REFRESH_NOT_EXECUTION_OR_COVERAGE',target,files:files.length,adopted:Object.keys(adopted).length,fallback,releaseAuthorized:false,goalAchieved:false}};
}
