/** Reserved, unjournaled SQL only in a disposable hosted worker. No shared/live migration state. */
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {owner} from '../harness';
const guard=()=>owner.db.execute<{definition:string;source:string;config:string[]|null}>(sql`select pg_get_functiondef(p.oid) definition,p.prosrc source,p.proconfig config from pg_proc p where p.oid='app.attendance_capture_punch_guard()'::regprocedure`);
export async function installOfflineDraftForWorker(){
 const [before]=await owner.db.execute(sql`select to_regclass('public.mobile_offline_context') IS NOT NULL installed`);
 if(before.installed)return async()=>{};
 // The predecessor punch guard, read before 0647 replaces it, so restoration is exact rather than retyped.
 const [original]=await guard();if(!original?.definition)throw new Error('Offline worker punch guard unavailable');
 const source=readFileSync(new URL('../../db/migrations/0647_mobile_offline_attendance.sql',import.meta.url),'utf8');
 await owner.db.transaction(async tx=>{for(const block of source.split('--> statement-breakpoint').filter(value=>value.trim()))await tx.execute(sql.raw(block));});
 return async()=>{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`DROP TRIGGER mobile_offline_key_counter ON mobile_integrity_key`);
   await tx.execute(sql`DROP TABLE mobile_offline_claim_resolution,mobile_offline_photo,mobile_offline_claim,mobile_offline_permit,mobile_offline_context CASCADE`);
   for(const signature of ['mobile_offline_immutable()','mobile_offline_context_progress()','mobile_offline_inventory_complete()',
    'mobile_offline_claim_ordered()','mobile_offline_key_counter()','mobile_offline_key_leased(uuid,uuid)','mobile_offline_claim_committed()','mobile_offline_permit_inventory()','mobile_offline_photo_expired()','mobile_offline_photo_committed()',
    'mobile_offline_claim_window(uuid)','mobile_offline_claim_resolution_bound()'])
    await tx.execute(sql.raw('DROP FUNCTION IF EXISTS app.'+signature));
   // Drops its CHECK with it. clock_method keeps 'mobile_offline': PostgreSQL cannot drop an enum value, and
   // 0647's ADD VALUE IF NOT EXISTS re-applies idempotently. The restored guard refuses it on any capture-linked punch.
   await tx.execute(sql`ALTER TABLE attendance_clock_capture DROP COLUMN effective_at`);
   // The per-company offline settings, with their CHECK.
   await tx.execute(sql`ALTER TABLE attendance_policy DROP COLUMN offline_clocking_enabled, DROP COLUMN offline_max_proven_window_seconds`);
   await tx.execute(sql.raw(original.definition));
  });
  const [after]=await owner.db.execute(sql`select to_regclass('public.mobile_offline_context') IS NOT NULL installed, to_regprocedure('app.mobile_offline_key_leased(uuid,uuid)') IS NOT NULL ready,
   EXISTS(select 1 from pg_attribute where attrelid='attendance_clock_capture'::regclass and attname='effective_at' and NOT attisdropped) effective,
   EXISTS(select 1 from pg_attribute where attrelid='attendance_policy'::regclass and attname in ('offline_clocking_enabled','offline_max_proven_window_seconds') and NOT attisdropped) settings,
   to_regclass('public.mobile_offline_claim_resolution') IS NOT NULL resolution,to_regprocedure('app.mobile_offline_claim_window(uuid)') IS NOT NULL claim_window,
   to_regprocedure('app.mobile_offline_claim_resolution_bound()') IS NOT NULL resolution_bound`);
  const [restored]=await guard();
  if(after.installed||after.ready||after.effective||after.settings||after.resolution||after.claim_window||after.resolution_bound||restored?.source!==original.source||JSON.stringify(restored?.config)!==JSON.stringify(original.config))throw new Error('Offline worker schema restoration failed');
 };
}
