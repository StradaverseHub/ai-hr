/** Read-only job-time estimate. Never a bill, test receipt or deployment authorization. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
function timestamp(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('Missing or invalid timestamp');
  return Date.parse(value);
}
export function estimateRunCost(run,observedAt) {
  const now=timestamp(observedAt),created=timestamp(run.createdAt??run.created_at);
  if(now<created||!Number.isSafeInteger(run.databaseId??run.id))throw Error('Invalid run identity or observation time');
  if(!Array.isArray(run.jobs)||!run.jobs.length||run.total_jobs!==undefined&&run.total_jobs!==run.jobs.length)throw Error('Missing or paginated job inventory');
  const ids=new Set();let seconds=0,roundedMinutes=0,activeJobs=0,latest=created;
  for(const job of run.jobs) {
    if(!Number.isSafeInteger(job.id)||ids.has(job.id))throw Error('Missing or duplicated job identity');ids.add(job.id);
    if(!['queued','waiting','pending','in_progress','completed'].includes(job.status))throw Error('Unknown job state');
    if(job.status!=='completed')activeJobs++;
    // The API can give skipped/queued jobs started_at values; those did not occupy a runner.
    if(job.conclusion==='skipped'||['queued','waiting','pending'].includes(job.status))continue;
    const start=timestamp(job.started_at),end=job.status==='completed'?timestamp(job.completed_at):now;
    if(start<created||end<start||end>now)throw Error('Inconsistent job timing');
    const duration=(end-start)/1000;seconds+=duration;roundedMinutes+=Math.ceil(duration/60);latest=Math.max(latest,end);
  }
  const complete=run.status==='completed'&&activeJobs===0;
  return {runId:run.databaseId??run.id,name:run.name??null,conclusion:run.conclusion??null,complete,activeJobs,
    observedJobSeconds:seconds,estimatedPerJobRoundedMinutes:roundedMinutes,
    elapsedSeconds:((complete?latest:now)-created)/1000,
    verifiedDeploymentSeconds:null,tenMinuteReleaseAchieved:false};
}
export function costAudit(snapshot) {
  if(!Array.isArray(snapshot?.runs)||!snapshot.runs.length)throw Error('Missing run inventory');
  const runs=snapshot.runs.map(r=>estimateRunCost(r,snapshot.observed_at));
  if(new Set(runs.map(r=>r.runId)).size!==runs.length)throw Error('Duplicate run');
  return {kind:'OBSERVED_JOB_TIME_ESTIMATE_NOT_BILLING_OR_RELEASE_EVIDENCE',observedAt:snapshot.observed_at,
    caveats:['Active runs are partial.','Job rounding estimate is not authoritative billing; OS multipliers, earlier attempts and billing adjustments are not inferred.','Deployment and healthy source/build arrival must be measured separately.','A completed fast or successful workflow does not by itself prove the release goal.'],
    observedJobMinutes:runs.reduce((n,r)=>n+r.observedJobSeconds,0)/60,
    estimatedPerJobRoundedMinutes:runs.reduce((n,r)=>n+r.estimatedPerJobRoundedMinutes,0),runs};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: report-run-cost.mjs <run-job-snapshot.json> <new-report.json>');
  const report=costAudit(JSON.parse(readFileSync(input,'utf8')));writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(`${report.runs.length} runs: ${report.observedJobMinutes.toFixed(2)} observed job-minutes; ${report.estimatedPerJobRoundedMinutes} per-job-rounded estimate. Not billing. No release-goal claim.`);
}
