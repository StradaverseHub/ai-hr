/** Minute notification projection + conditional email delivery. Use flock in cron, not a web request. */
// Only node builtins are imported statically. The parent process exists to respawn under the server runtime,
// and static imports would make it load and transpile the whole HR graph each minute before the child loads it again.
import { spawn } from 'node:child_process';
import type { SessionContext } from '../db/client';
async function main(){
 const [{createDb},{loadSweepScope,describeSkips},{resolveEntitlementsTx,isModuleEnabled},{sweepOnboarding,refreshOnboardingPersonnel,v9Sweep,v9DeliverEmails},{sweepProbation},{sweepContractManagement},{sweepAssessmentReminders},{dispatchNotificationsFromSweep},{deliverNotificationEmails,deliverAttendanceCcEmails},{deliverLetterEmailsFromSweep},{sweepLetterAutomationFromSweep},{projectLetterNotificationsFromSweep},{createNoticeSweepAccess},{NOTIFICATION_ROLE_MISSING,notificationDowngradeReady}]=await Promise.all([
  import('../db/client'),import('../core/sweep-scope'),import('../core/entitlements'),import('../packs/lifecycle/service'),import('../packs/probation/service'),
  import('../packs/contracts/service'),import('../packs/performance/service'),import('../core/notifications'),import('../core/notification-email-delivery'),
  import('../core/letter-email-delivery'),import('../core/letter-automation'),import('../core/letter-notifications'),import('../core/notice-projection'),import('./lib/notification-sweep-role')]);
 const url=process.env.MIGRATION_DATABASE_URL;if(!url)throw new Error('Migration database required');
 const owner=createDb(url);let failed=0;
 try{
  // Probed once: without the downgrade edge projection fails at SET ROLE for every tenant with pending events.
  const downgradeReady=await notificationDowngradeReady(owner.db);if(!downgradeReady)console.error(NOTIFICATION_ROLE_MISSING);
  const scope=await loadSweepScope(owner.db);for(const line of describeSkips(scope))console.log(line);
  for(const tenant of scope.run){
   const startedAt=Date.now();
   try{
    const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenant.id));
    const ctx:SessionContext={tenantId:tenant.id,roles:['hr_admin'],entitlements};
    if(isModuleEnabled(ctx,'lifecycle')){await refreshOnboardingPersonnel(ctx,owner.withTenant);await sweepOnboarding(ctx);const v9=await v9Sweep(ctx,owner);if(v9.failed>0)failed++;const mail=await v9DeliverEmails(ctx,owner);if(mail.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,lifecycleV9:v9,lifecycleV9Mail:mail}));}
    // Each new module checks its own activation and exact company purchase on the real owner connection.
    // Publishing definitions does not activate either module or replay past reminder occurrences.
    if(isModuleEnabled(ctx,'lifecycle')||(entitlements.scopedModules.lifecycle??[]).some(companyId=>isModuleEnabled(ctx,'lifecycle',companyId))){
     try{const probation=await sweepProbation(ctx,owner);if(probation.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,probation}));}catch{failed++;console.error('Probation maintenance failed for tenant '+tenant.id);}
     try{const contracts=await sweepContractManagement(ctx,owner);if(contracts.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,contracts}));}catch{failed++;console.error('Contract maintenance failed for tenant '+tenant.id);}
    }
    const letterAutomation=await sweepLetterAutomationFromSweep(ctx,owner);if(letterAutomation.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,letterAutomation}));
    if(!isModuleEnabled(ctx,'notifications')&&!(entitlements.scopedModules.notifications??[]).some(companyId=>isModuleEnabled(ctx,'notifications',companyId)))continue;
    await sweepAssessmentReminders(ctx);
    const noticeSweep=await createNoticeSweepAccess(ctx,owner);
    const letters=await projectLetterNotificationsFromSweep(ctx,owner),letterMail=await deliverLetterEmailsFromSweep(ctx,owner),projected=downgradeReady?await dispatchNotificationsFromSweep(ctx,owner):null,delivered=await deliverNotificationEmails(ctx,undefined,{noticeSweep}),attendanceCc=await deliverAttendanceCcEmails(ctx);
    if(letters.failed>0||letterMail.failed>0||!projected)failed++;
    // Outcome details live in the delivery log. No addresses, frozen HR text, credentials or raw SMTP errors.
    console.log(JSON.stringify({tenantId:tenant.id,projected:projected?.created??'blocked',letters,letterMail,...delivered,attendanceCc,ms:Date.now()-startedAt}));
   }catch{failed++;console.error('Workflow email sweep failed for tenant '+tenant.id+' after '+(Date.now()-startedAt)+'ms');}
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
