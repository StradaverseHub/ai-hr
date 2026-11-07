/** Minute notification projection + conditional email delivery. Use flock in cron, not a web request. */
// Only node builtins are imported statically. The parent process exists to respawn under the server runtime,
// and static imports would make it load and transpile the whole HR graph each minute before the child loads it again.
import { spawn } from 'node:child_process';
import type { SessionContext } from '../db/client';
import type { StartedJobRun } from '../core/job-run';
async function main(){
 const [{createDb},{loadSweepScope,describeSkips},{resolveEntitlementsTx,isModuleEnabled},{sweepOnboarding,refreshOnboardingPersonnel,v9Sweep,v9DeliverEmails},{sweepProbation},{sweepContractManagement},{sweepAssessmentReminders},{dispatchNotificationsFromSweep},{deliverNotificationEmails,deliverAttendanceCcEmails},{deliverLetterEmailsFromSweep},{sweepLetterAutomationFromSweep},{projectLetterNotificationsFromSweep},{createNoticeSweepAccess},{NOTIFICATION_ROLE_MISSING,notificationDowngradeReady},{startJobRun,completeJobRun,jobOutcome},{notificationProjectionCounters,recordCommittedProjectionBatch,NOTIFICATION_PROJECTION_JOB_KEY},{drainNotificationProjection},{notificationEventProcessing,domainEvent},{and,eq,isNull,sql}]=await Promise.all([
  import('../db/client'),import('../core/sweep-scope'),import('../core/entitlements'),import('../packs/lifecycle/service'),import('../packs/probation/service'),
  import('../packs/contracts/service'),import('../packs/performance/service'),import('../core/notifications'),import('../core/notification-email-delivery'),
  import('../core/letter-email-delivery'),import('../core/letter-automation'),import('../core/letter-notifications'),import('../core/notice-projection'),import('./lib/notification-sweep-role'),
  import('../core/job-run'),import('../lib/notification-scheduling-evidence'),import('../core/orchestrator-harness'),import('../db/schema'),import('drizzle-orm')]);
 const url=process.env.MIGRATION_DATABASE_URL;if(!url)throw new Error('Migration database required');
 const owner=createDb(url);let failed=0,tenantsProcessed=0,tenantsFailed=0,tenantsSkipped=0,fatal=false;
 const counters=notificationProjectionCounters();let run:StartedJobRun|undefined;
 // The old accepted-artifact interface does not cover this worker. Do not infer identity from cwd,
 // environment SHA strings, a configured timer, or a successful process exit.
 async function observeBacklog(ctx:SessionContext){
  const consumer=isModuleEnabled(ctx,'notifications')?'notifications':'assessment-reminders';
  const [backlog]=await owner.db.select({pending:sql<number>`count(*)::double precision`,oldest:sql<number>`coalesce(greatest(0,extract(epoch from (now()-min(${domainEvent.createdAt}))))::double precision,0)`})
   .from(notificationEventProcessing).innerJoin(domainEvent,and(eq(domainEvent.id,notificationEventProcessing.eventId),eq(domainEvent.tenantId,notificationEventProcessing.tenantId)))
   .where(and(eq(notificationEventProcessing.tenantId,ctx.tenantId),eq(notificationEventProcessing.consumer,consumer),isNull(notificationEventProcessing.disposition)));
  if(!backlog||!Number.isSafeInteger(backlog.pending)||backlog.pending<0||!Number.isFinite(backlog.oldest)||backlog.oldest<0)throw new Error('Projection backlog unavailable.');
  counters.backlogObservedTenants++;counters.pendingEvents+=backlog.pending;counters.oldestPendingSeconds=Math.max(counters.oldestPendingSeconds,backlog.oldest);
 }
 try{
  run=await startJobRun(owner.db,NOTIFICATION_PROJECTION_JOB_KEY,counters);
  // Probed once: without the downgrade edge projection fails at SET ROLE for every tenant with pending events.
  const downgradeReady=await notificationDowngradeReady(owner.db);if(!downgradeReady)console.error(NOTIFICATION_ROLE_MISSING);
  const scope=await loadSweepScope(owner.db);counters.scopeLoaded=1;tenantsSkipped=scope.skipped.length;for(const line of describeSkips(scope))console.log(line);
  for(const tenant of scope.run){
   const startedAt=Date.now(),failuresBefore=failed;let projectionSettled=false;tenantsProcessed++;
   try{
    const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenant.id));
    const ctx:SessionContext={tenantId:tenant.id,roles:['hr_admin'],entitlements};
    const notificationsEnabled=isModuleEnabled(ctx,'notifications')||(entitlements.scopedModules.notifications??[]).some(companyId=>isModuleEnabled(ctx,'notifications',companyId));
    if(notificationsEnabled)counters.projectionTenants++;else projectionSettled=true;
    if(isModuleEnabled(ctx,'lifecycle')){await refreshOnboardingPersonnel(ctx,owner.withTenant);await sweepOnboarding(ctx);const v9=await v9Sweep(ctx,owner);if(v9.failed>0)failed++;const mail=await v9DeliverEmails(ctx,owner);if(mail.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,lifecycleV9:v9,lifecycleV9Mail:mail}));}
    // Each new module checks its own activation and exact company purchase on the real owner connection.
    // Publishing definitions does not activate either module or replay past reminder occurrences.
    if(isModuleEnabled(ctx,'lifecycle')||(entitlements.scopedModules.lifecycle??[]).some(companyId=>isModuleEnabled(ctx,'lifecycle',companyId))){
     try{const probation=await sweepProbation(ctx,owner);if(probation.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,probation}));}catch{failed++;console.error('Probation maintenance failed for tenant '+tenant.id);}
     try{const contracts=await sweepContractManagement(ctx,owner);if(contracts.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,contracts}));}catch{failed++;console.error('Contract maintenance failed for tenant '+tenant.id);}
    }
    const letterAutomation=await sweepLetterAutomationFromSweep(ctx,owner);if(letterAutomation.failed>0)failed++;console.log(JSON.stringify({tenantId:tenant.id,letterAutomation}));
    if(!notificationsEnabled)continue;
    await sweepAssessmentReminders(ctx);
    const noticeSweep=await createNoticeSweepAccess(ctx,owner);
    const letters=await projectLetterNotificationsFromSweep(ctx,owner),letterMail=await deliverLetterEmailsFromSweep(ctx,owner);
    let projected:Awaited<ReturnType<typeof drainNotificationProjection>>|null=null;
    try{
     if(!downgradeReady){counters.projectionBlockedTenants++;projectionSettled=true;failed++;}
     else{
      projected=await drainNotificationProjection(async limit=>{
       const batch=await dispatchNotificationsFromSweep(ctx,owner,{limit});
       recordCommittedProjectionBatch(counters,batch);return batch;
      });
      counters.projectionCompletedTenants++;projectionSettled=true;
      if(projected.cappedOut){counters.cappedTenants++;failed++;}
     }
    }catch{throw new Error('Notification projection failed.');}
    finally{await observeBacklog(ctx);}
    const delivered=await deliverNotificationEmails(ctx,undefined,{noticeSweep}),attendanceCc=await deliverAttendanceCcEmails(ctx);
    counters.emailAttempted+=delivered.attempted;counters.emailSkipped+=delivered.skipped;
    if(delivered.unavailable||attendanceCc.unavailable)counters.emailUnavailableTenants++;
    if(delivered.cappedOut||attendanceCc.cappedOut)counters.emailCappedTenants++;
    if(letters.failed>0||letterMail.failed>0)failed++;
    // Outcome details live in the delivery log. No addresses, frozen HR text, credentials or raw SMTP errors.
    console.log(JSON.stringify({tenantId:tenant.id,projected:projected?.created??'blocked',letters,letterMail,...delivered,attendanceCc,ms:Date.now()-startedAt}));
   }catch{if(!projectionSettled)counters.projectionFailedTenants++;failed++;console.error('Workflow email sweep failed for tenant '+tenant.id+' after '+(Date.now()-startedAt)+'ms');}
   finally{if(failed>failuresBefore)tenantsFailed++;}
  }
 }catch{fatal=true;failed++;console.error('Workflow sweep could not complete its scheduled run.');}
 finally{
  if(run){try{await completeJobRun(owner.db,run,{
   outcome:fatal?'failed':jobOutcome(tenantsProcessed,tenantsFailed),tenantsProcessed,tenantsFailed,
   result:{...counters,skipped:tenantsSkipped},error:fatal?'Scheduled sweep interrupted before completion.':failed?'Scheduled sweep has incomplete work; inspect protected logs.':null,
  });}catch{failed++;console.error('Workflow sweep completion evidence unavailable.');}}
  await owner.client.end();
 }
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
