/** Reserved, unjournaled SQL only in a disposable hosted worker. No shared/live migration state. */
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {owner} from '../harness';
export async function installOfflineDraftForWorker(){
 const [before]=await owner.db.execute(sql`select to_regclass('public.mobile_offline_context') IS NOT NULL installed`);
 if(before.installed)return async()=>{};
 const source=readFileSync(new URL('../../db/migrations/0647_mobile_offline_attendance.sql',import.meta.url),'utf8');
 await owner.db.transaction(async tx=>{for(const block of source.split('--> statement-breakpoint').filter(value=>value.trim()))await tx.execute(sql.raw(block));});
 return async()=>{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`DROP TRIGGER mobile_offline_key_counter ON mobile_integrity_key`);
   await tx.execute(sql`DROP TABLE mobile_offline_photo,mobile_offline_claim,mobile_offline_permit,mobile_offline_context CASCADE`);
   for(const signature of ['mobile_offline_immutable()','mobile_offline_context_progress()','mobile_offline_inventory_complete()',
    'mobile_offline_claim_ordered()','mobile_offline_key_counter()','mobile_offline_key_leased(uuid,uuid)','mobile_offline_claim_committed()','mobile_offline_permit_inventory()','mobile_offline_photo_expired()','mobile_offline_photo_committed()'])
    await tx.execute(sql.raw('DROP FUNCTION IF EXISTS app.'+signature));
  });
  const [after]=await owner.db.execute(sql`select to_regclass('public.mobile_offline_context') IS NOT NULL installed, to_regprocedure('app.mobile_offline_key_leased(uuid,uuid)') IS NOT NULL ready`);
  if(after.installed||after.ready)throw new Error('Offline worker schema restoration failed');
 };
}
