/**
 * ADR 0181 Phase 2 pilot: rebuild-and-compare of precomputed company access (core/access-effective-company-check.ts).
 *
 *   node --env-file=.env.production --import tsx scripts/access-effective-company-check.ts
 *
 * Install it under the existing wrapper (deploy/DEPLOY.md, the cron-alert section, carries the crontab line). It is
 * documented there, not installed by anything in this repository. It runs shortly after midnight Kuala Lumpur time,
 * when a future-dated restructure's date window expires.
 *
 * Exit codes: 0 checked and clean · 3 a tenant differs or is untrusted (a standing condition until an operator
 * re-trusts it, so the heartbeat stays stale on purpose) · 2 a tenant could not be checked.
 */
import {createDb} from '../db/client';
import {accessEffectiveCompanyCheck,accessEffectiveCompanyExitCode} from '../core/access-effective-company-check';

async function main(){
 const ownerUrl=process.env.MIGRATION_DATABASE_URL;
 if(!ownerUrl){console.error('access-effective-company-check requires MIGRATION_DATABASE_URL (the owner role) to verify every tenant.');process.exit(2);}
 const owner=createDb(ownerUrl);
 try{
  const run=await accessEffectiveCompanyCheck(owner.db,line=>console.log(line));
  console.log(`access-effective-company checked=${run.tenantsChecked} failed=${run.tenantsFailed} differing=${run.tenantsDiffering} untrusted=${run.tenantsUntrusted} windows_refreshed=${run.windowsRefreshed}`);
  process.exitCode=accessEffectiveCompanyExitCode(run);
 }finally{await owner.client.end();}
}
main().catch(error=>{console.error(`access-effective-company-check failed: ${(error as Error).name}`);process.exit(2);});
