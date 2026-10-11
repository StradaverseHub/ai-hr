/** Minute notification projection + conditional email delivery. Use flock in cron, not a web request. */
import { createDb,type SessionContext } from '../db/client';
import { loadSweepScope,describeSkips } from '../core/sweep-scope';
import { resolveEntitlementsTx,isModuleEnabled } from '../core/entitlements';
import { dispatchNotifications } from '../core/notifications';
import { deliverNotificationEmails } from '../core/notification-email-delivery';
async function main(){
 const url=process.env.MIGRATION_DATABASE_URL;if(!url)throw new Error('Migration database required');
 const owner=createDb(url);let failed=0;
 try{
  const scope=await loadSweepScope(owner.db);for(const line of describeSkips(scope))console.log(line);
  for(const tenant of scope.run){
   try{
    const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenant.id));
    const ctx:SessionContext={tenantId:tenant.id,roles:['hr_admin'],entitlements};
    if(!isModuleEnabled(ctx,'notifications'))continue;
    const projected=await dispatchNotifications(ctx),delivered=await deliverNotificationEmails(ctx);
    // Outcome details live in the delivery log. No addresses, frozen HR text, credentials or raw SMTP errors.
    console.log(JSON.stringify({tenantId:tenant.id,projected:projected.created,...delivered}));
   }catch{failed++;console.error('Workflow email sweep failed for tenant '+tenant.id);}
  }
 }finally{await owner.client.end();}
 process.exit(failed?1:0);
}
main().catch(()=>{console.error('Workflow email sweep failed.');process.exit(1);});
