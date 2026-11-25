/**
 * ADR 0181: rebuild-and-compare of precomputed employment visibility (core/access-visible-employment-check.ts).
 *
 *   node --env-file=.env.production --import tsx scripts/access-visible-employment-check.ts            # rebuild due tenants, then verify every tenant
 *   node --env-file=.env.production --import tsx scripts/access-visible-employment-check.ts --rebuild-only  # rebuild stale or expired tenants only
 *
 * Install both under the existing wrapper (deploy/DEPLOY.md, the cron-alert section, carries the crontab lines): the
 * full check shortly after midnight Kuala Lumpur time, and --rebuild-only every ten minutes so a tenant marked stale
 * by a large restructure returns to the stored answer soon. Nothing in this repository installs them.
 *
 * Exit codes: 0 clean · 3 a tenant differs or is untrusted (standing until an operator re-trusts it) · 2 a tenant
 * could not be rebuilt or checked.
 */
import {createDb} from '../db/client';
import {accessVisibleEmploymentCheck,accessVisibleEmploymentExitCode} from '../core/access-visible-employment-check';

async function main(){
 const ownerUrl=process.env.MIGRATION_DATABASE_URL;
 if(!ownerUrl){console.error('access-visible-employment-check requires MIGRATION_DATABASE_URL (the owner role).');process.exit(2);}
 const owner=createDb(ownerUrl);
 try{
  const run=await accessVisibleEmploymentCheck(owner.db,line=>console.log(line),{verify:!process.argv.includes('--rebuild-only')});
  console.log(`access-visible-employment rebuilt=${run.tenantsRebuilt} checked=${run.tenantsChecked} failed=${run.tenantsFailed} differing=${run.tenantsDiffering} untrusted=${run.tenantsUntrusted}`);
  process.exitCode=accessVisibleEmploymentExitCode(run);
 }finally{await owner.client.end();}
}
main().catch(error=>{console.error(`access-visible-employment-check failed: ${(error as Error).name}`);process.exit(2);});
