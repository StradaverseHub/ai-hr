/**
 * ADR 0181 payroll read addendum, section 11.2: the every-user comparison of each switched payroll read step
 * (core/payroll-read-access-check.ts).
 *
 *   node --env-file=.env.production --import tsx scripts/payroll-read-access-check.ts
 *
 * Install under the existing wrapper (deploy/DEPLOY.md, the cron-alert section, carries the crontab line), nightly
 * shortly after midnight Kuala Lumpur time. Nothing in this repository installs it. It compares only steps in
 * 'shadow' or 'precomputed', so it does nothing until an operator switches a step.
 *
 * Exit codes: 0 clean · 3 a step differs or is untrusted on a tenant (standing until an operator re-trusts it) · 2 a
 * comparison could not run.
 */
import {createDb} from '../db/client';
import {payrollReadAccessCheck,payrollReadAccessExitCode} from '../core/payroll-read-access-check';

async function main(){
 const ownerUrl=process.env.MIGRATION_DATABASE_URL;
 if(!ownerUrl){console.error('payroll-read-access-check requires MIGRATION_DATABASE_URL (the owner role).');process.exit(2);}
 const owner=createDb(ownerUrl);
 try{
  const run=await payrollReadAccessCheck(owner.db,line=>console.log(line));
  console.log(`payroll-read-access steps=${run.stepsCompared} tenants=${run.tenantsCompared} failed=${run.comparisonsFailed} differing=${run.comparisonsDiffering} untrusted=${run.untrusted}`);
  process.exitCode=payrollReadAccessExitCode(run);
 }finally{await owner.client.end();}
}
main().catch(error=>{console.error(`payroll-read-access-check failed: ${(error as Error).name}`);process.exit(2);});
