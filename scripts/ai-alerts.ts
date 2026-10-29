/**
 * WP12 (architecture review R20) — the AI alert check, so AI failure rate, scheduled-agent refusals, spend near its
 * cap and switch drift reach a human instead of only a screen. The logic lives in core/ai-alert-sweep.ts.
 *
 *   node --env-file=.env.production --import tsx scripts/ai-alerts.ts
 *
 * Install it under the existing wrapper, which owns the log, the heartbeat and the three alert channels
 * (journal at priority err, cron mail, AIHR_ALERT_COMMAND). The release owner installs it; nothing here does:
 *
 *   15 * * * * cd /opt/ai-hr && deploy/cron-alert.sh ai-alerts /home/ubuntu/aihr-cron-logs/ai-alerts.log \
 *       /opt/node20/bin/node --env-file=.env.production --import tsx scripts/ai-alerts.ts
 *
 * Exit codes: 0 nothing to report · 3 at least one alert · 2 a tenant could not be checked.
 * It writes nothing: every tenant transaction is READ ONLY. Output lines carry a tenant id, alert kind, level and
 * count only — no person, prompt, model output or HR value — because the wrapper may forward its tail.
 * It is not registered in core/job-run.ts JOB_KEYS (no job_run row): an alert is a standing condition, and
 * deploy/cron-alert.sh's heartbeat covers "stopped running".
 */
import {createDb} from '../db/client';
import {aiAlertExitCode,aiAlertSweep} from '../core/ai-alert-sweep';

async function main(){
 const ownerUrl=process.env.MIGRATION_DATABASE_URL;
 if(!ownerUrl){console.error('ai-alerts requires MIGRATION_DATABASE_URL (the owner role) to read every tenant.');process.exit(2);}
 const owner=createDb(ownerUrl);
 try{
  const run=await aiAlertSweep(owner.db,line=>console.log(line));
  console.log(`ai-alerts checked=${run.tenantsChecked} failed=${run.tenantsFailed} alerting=${run.tenantsAlerting} alerts=${run.alerts.length}`);
  process.exitCode=aiAlertExitCode(run);
 }finally{await owner.client.end();}
}
main().catch(error=>{console.error(`ai-alerts failed: ${(error as Error).name}`);process.exit(2);});
