/** Minute notification projection + conditional email delivery. Use flock in cron, not a web request. */
import { spawn } from 'node:child_process';
import { createDb,type SessionContext } from '../db/client';
import { loadSweepScope,describeSkips } from '../core/sweep-scope';
import { resolveEntitlementsTx,isModuleEnabled } from '../core/entitlements';
import { sweepOnboarding, refreshOnboardingPersonnel, v9Sweep, v9DeliverEmails } from '../packs/lifecycle/service';
import { sweepAssessmentReminders } from '../packs/performance/service';
import { dispatchNotificationsFromSweep } from '../core/notifications';
import { deliverNotificationEmails,deliverAttendanceCcEmails } from '../core/notification-email-delivery';
import {deliverLetterEmailsFromSweep} from '../core/letter-email-delivery';
import {sweepLetterAutomationFromSweep} from '../core/letter-automation';
import {projectLetterNotificationsFromSweep} from '../core/letter-notifications';
import {createNoticeSweepAccess} from '../core/notice-projection';
async function main(){
 const url=process.env.MIGRATION_DATABASE_URL;if(!url)throw new Error('Migration database required');
 const owner=createDb(url);let failed=0;
 try{
  const scope=await loadSweepScope(owner.db);for(const line of describeSkips(scope))console.log(line);
  for(const tenant of scope.run){
   try{
    const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenant.id));
    const ctx:SessionContext={tenantId:tenant.id,roles:['hr_admin'],entitlements};
    if(isModuleEnabled(ctx,'lifecycle')){await refreshOnboardingPersonnel(ctx,owner.withTenant);await sweepOnboarding(ctx);const v9=await v9Sweep(ctx,owner);if(v9.failed>0)failed++;const mail=await v9DeliverEmails(ctx,owner);if(mail.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,lifecycleV9:v9,lifecycleV9Mail:mail}));}
    const letterAutomation=await sweepLetterAutomationFromSweep(ctx,owner);if(letterAutomation.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,letterAutomation}));
    if(!isModuleEnabled(ctx,'notifications')&&!(entitlements.scopedModules.notifications??[]).some(companyId=>isModuleEnabled(ctx,'notifications',companyId)))continue;
    await sweepAssessmentReminders(ctx);
    const noticeSweep=await createNoticeSweepAccess(ctx,owner);
    const letters=await projectLetterNotificationsFromSweep(ctx,owner),letterMail=await deliverLetterEmailsFromSweep(ctx,owner),projected=await dispatchNotificationsFromSweep(ctx,owner),delivered=await deliverNotificationEmails(ctx,undefined,{noticeSweep}),attendanceCc=await deliverAttendanceCcEmails(ctx);
    if(letters.failed>0||letterMail.failed>0)failed++;
    // Outcome details live in the delivery log. No addresses, frozen HR text, credentials or raw SMTP errors.
    console.log(JSON.stringify({tenantId:tenant.id,projected:projected.created,letters,letterMail,...delivered,attendanceCc}));
   }catch{failed++;console.error('Workflow email sweep failed for tenant '+tenant.id);}
  }
 }finally{await owner.client.end();}
 process.exit(failed?1:0);
}
// Honor the installed marker package's official server export in this standalone worker.
// Other lifecycle scripts keep their ordinary Node runtime through the lazy facade.
if (!process.execArgv.includes('--conditions=react-server')) {
 const worker=spawn(process.execPath,['--conditions=react-server',...process.execArgv,...process.argv.slice(1)],{stdio:'inherit',env:process.env});
 worker.once('error',()=>{console.error('Workflow email server runtime unavailable.');process.exitCode=1;});
 worker.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>worker.kill(signal));
} else main().catch(()=>{console.error('Workflow email sweep failed.');process.exit(1);});
