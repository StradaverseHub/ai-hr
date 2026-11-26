/**
 * ADR 0181, employment visibility shadow (migration 7240): the scheduled fictional walkthrough
 * (core/visibility-walkthrough.ts). Staging only, and only while AIHR_VISIBILITY_WALKTHROUGH=on.
 *
 *   node --env-file=.env.production --import tsx scripts/visibility-walkthrough.ts
 *
 * deploy/DEPLOY.md (the cron-alert section) carries its crontab line, every ten minutes under `flock -n`. Nothing in
 * this repository installs it. It reads as the demo seed tenant's fictional line managers and department heads, in
 * READ ONLY transactions, and writes nothing (not even a job_run row). Its output is counts only.
 *
 * Exit codes: 0 ran cleanly, or nothing to do (switched off, or the 7240 mode is not shadow) · 2 refused (not the demo
 * installation, or no actor), or a read failed.
 */
import postgres from 'postgres';
import {runVisibilityWalkthrough,walkthroughExitCode,walkthroughSettings,walkthroughSummary} from '../core/visibility-walkthrough';
import {todayInKualaLumpur} from '../lib/hr-date';

async function main(){
 const settings=walkthroughSettings(process.env);
 if(!settings.enabled&&!settings.refused){console.log(`visibility-walkthrough disabled: ${settings.reason}`);return;}
 const ownerUrl=process.env.MIGRATION_DATABASE_URL,appUrl=process.env.DATABASE_URL;
 if(!ownerUrl||!appUrl){console.error('visibility-walkthrough requires DATABASE_URL (application role) and MIGRATION_DATABASE_URL (owner, preflight only).');process.exit(2);}
 const owner=postgres(ownerUrl,{max:1,idle_timeout:5,connect_timeout:10,onnotice:()=>{}});
 const app=postgres(appUrl,{max:1,idle_timeout:5,connect_timeout:10,onnotice:()=>{}});
 try{
  // One rotation step per ten-minute slot, so successive runs start at successive actors.
  const run=await runVisibilityWalkthrough({owner,app},settings,{hrDate:todayInKualaLumpur(),rotation:Math.floor(Date.now()/600_000),log:line=>console.log(line)});
  console.log(walkthroughSummary(run));
  process.exitCode=walkthroughExitCode(run);
 }finally{await Promise.allSettled([owner.end({timeout:5}),app.end({timeout:5})]);}
}
main().catch(error=>{console.error(`visibility-walkthrough failed: ${(error as {code?:string}).code??(error as Error).name}`);process.exit(2);});
