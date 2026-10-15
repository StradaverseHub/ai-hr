/** Existing minute runner invokes this exported pass; no second scheduler or read-side write. */
import {and,asc,eq,isNull,lt,lte,or,sql} from 'drizzle-orm';
import {createDb,withTenant,type SessionContext} from '../db/client';
import {replacementHolidayQueue} from '../db/schema';
import {resolveEntitlementsTx} from '../core/entitlements';
import {loadSweepScope} from '../core/sweep-scope';
import {reconcileReplacementHolidaysTx} from '../core/holiday-replacements';
import {recordJobRun} from '../core/job-run';
import {publicErrorMessage} from '../lib/public-error';
export async function sweepReplacementHolidayQueue(owner:ReturnType<typeof createDb>,options:{limitPerTenant?:number}={}){
 const startedAt=Date.now(),scope=await loadSweepScope(owner.db),limit=Math.min(100,Math.max(1,Math.trunc(options.limitPerTenant??10)));
 let processed=0,changed=0,review=0,failed=0;const failedTenants=new Set<string>();
 for(const tenant of scope.run){
  const ctx:SessionContext={tenantId:tenant.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenant.id))};
  for(let n=0;n<limit;n++){
   // A short committed claim avoids queue->employment lock inversion with input writers.
   const claim=await withTenant(ctx,async tx=>{
    const [row]=await tx.select().from(replacementHolidayQueue).where(and(lte(replacementHolidayQueue.requestedAt,new Date()),or(isNull(replacementHolidayQueue.claimedAt),lt(replacementHolidayQueue.claimedAt,new Date(Date.now()-10*60_000))))).orderBy(asc(replacementHolidayQueue.requestedAt),asc(replacementHolidayQueue.employmentId)).limit(1).for('update',{skipLocked:true});
    if(!row)return null;
    await tx.update(replacementHolidayQueue).set({claimedAt:new Date(),claimedGeneration:row.generation}).where(eq(replacementHolidayQueue.employmentId,row.employmentId));return row;
   });
   if(!claim)break;
   try{
    const result=await withTenant(ctx,async tx=>{
     const result=await reconcileReplacementHolidaysTx(tx,ctx,claim.employmentId);
     await tx.update(replacementHolidayQueue).set({requestedAt:new Date(Date.now()+86400_000),claimedAt:null,claimedGeneration:null,lastError:null,calendarConflicts:result.calendarConflicts}).where(and(eq(replacementHolidayQueue.employmentId,claim.employmentId),eq(replacementHolidayQueue.generation,claim.generation)));
     return result;
    });processed++;changed+=result.changed;review+=result.review;
   }catch(error){
    failed++;failedTenants.add(tenant.id);
    await withTenant(ctx,tx=>tx.update(replacementHolidayQueue).set({requestedAt:new Date(Date.now()+15*60_000),claimedAt:null,claimedGeneration:null,lastError:publicErrorMessage(error)}).where(and(eq(replacementHolidayQueue.employmentId,claim.employmentId),eq(replacementHolidayQueue.generation,claim.generation))));
   }
  }
 }
 await recordJobRun(owner.db,{jobKey:'replacement-holidays.reconcile',startedAt,tenantsProcessed:scope.run.length,tenantsFailed:failedTenants.size,tenantsSkipped:scope.skipped.length,result:{processed,changed,review,failed}});
 return {processed,changed,review,failed,skipped:scope.skipped.length};
}
async function main(){
 try{process.loadEnvFile('.env.production');}catch{try{process.loadEnvFile('.env.local');}catch{/* supplied by runner */}}
 if(!process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_DATABASE_URL is required.');
 const owner=createDb(process.env.MIGRATION_DATABASE_URL,{max:2});
 try{const result=await sweepReplacementHolidayQueue(owner);console.log(JSON.stringify(result));await owner.client.end();process.exit(result.failed?1:0);}catch(error){console.error(error);await owner.client.end();process.exit(1);}
}
if(process.argv[1]?.endsWith('replacement-holiday-sweep.ts'))void main();
