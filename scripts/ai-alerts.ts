/**
 * WP12 (architecture review R20) — the AI alert check, so AI failure rate, scheduled-agent refusals, monthly spend
 * against the tenant cap and stale switch overrides reach a human instead of only a screen. The logic, and exactly
 * which checks it covers, live in core/ai-alert-sweep.ts.
 *
 *   node --env-file=.env.production --import tsx scripts/ai-alerts.ts
 *
 * Install it under the existing wrapper (deploy/DEPLOY.md, the cron-alert section, carries the crontab line and its
 * staleness line). It is documented there, not installed by anything in this repository.
 *
 * Exit codes, as scripts/entitlement-alarm.ts: 0 checked and nothing to report · 3 at least one alert ·
 * 2 a tenant could not be checked (an incomplete answer outranks a finding).
 *
 * HEARTBEAT. deploy/cron-alert.sh touches heartbeat/ai-alerts ONLY on exit 0. An alert is a STANDING condition
 * (a failing provider stays failing), so while it lasts this job exits 3 every hour and its heartbeat goes stale on
 * purpose: read heartbeat/ai-alerts as "last CHECKED AND CLEAN", not "last ran". Whether it RAN is the job_run row
 * written below (`ai.alerts`, shown on /admin/scheduled-actions and in the AI inventory). The staleness line in
 * DEPLOY.md therefore uses a window longer than one alerting day, as entitlement-alarm's does.
 *
 * It writes nothing except its own job_run row, on the owner connection, outside every tenant transaction; every
 * tenant transaction is READ ONLY. Output lines carry a tenant id, alert kind, level and count only — no person,
 * prompt, model output or HR value — because the wrapper may forward its tail. Nothing tenant-identifying goes into
 * job_run (its read policy has no tenant dimension; see scripts/entitlement-alarm.ts).
 */
import {createDb} from '../db/client';
import {aiAlertExitCode,aiAlertSweep} from '../core/ai-alert-sweep';
import {recordJobRun} from '../core/job-run';

async function main(){
 const startedAt=Date.now();
 const ownerUrl=process.env.MIGRATION_DATABASE_URL;
 if(!ownerUrl){console.error('ai-alerts requires MIGRATION_DATABASE_URL (the owner role) to read every tenant.');process.exit(2);}
 const owner=createDb(ownerUrl);
 try{
  const run=await aiAlertSweep(owner.db,line=>console.log(line));
  console.log(`ai-alerts checked=${run.tenantsChecked} failed=${run.tenantsFailed} alerting=${run.tenantsAlerting} alerts=${run.alerts.length}`);
  try{
   await recordJobRun(owner.db,{jobKey:'ai.alerts',startedAt,tenantsProcessed:run.tenantsChecked,tenantsFailed:run.tenantsFailed,
    result:{alerts:run.alerts.length,tenantsAlerting:run.tenantsAlerting},
    error:run.alerts.length>0?`${run.alerts.length} AI alert(s) across ${run.tenantsAlerting} tenant(s). Read the detail in the journal: journalctl -t aihr-cron -p err`:null});
  }catch(e){console.error(`ai-alerts — could not write the run log: ${(e as Error).name}`);}
  process.exitCode=aiAlertExitCode(run);
 }finally{await owner.client.end();}
}
main().catch(error=>{console.error(`ai-alerts failed: ${(error as Error).name}`);process.exit(2);});
