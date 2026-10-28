/** Reserved, unjournaled 0671 SQL only in a disposable hosted worker. No shared/live migration state. */
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {owner} from '../harness';
const state=()=>owner.db.execute<{registration:boolean;delivery:boolean;release:boolean;guard:boolean;trigger:boolean}>(sql`select
 to_regclass('public.mobile_push_registration') IS NOT NULL registration,to_regclass('public.mobile_push_delivery') IS NOT NULL delivery,
 to_regprocedure('app.mobile_push_release(uuid,text,text)') IS NOT NULL release,to_regprocedure('app.mobile_push_registration_guard()') IS NOT NULL guard,
 EXISTS(select 1 from pg_trigger where tgname='mobile_push_registration_guard') "trigger"`);
/** Install 0671 exactly as written (statement blocks, one transaction) unless present; the returned function drops
 * every object 0671 created and proves none remains. 0671 alters no existing object, so nothing else needs restoring. */
export async function installPushDraftForWorker(){
 const [before]=await state();
 if(before.registration)return async()=>{};
 if(before.delivery||before.release||before.guard||before.trigger)throw new Error('Push worker schema is partially installed');
 const source=readFileSync(new URL('../../db/migrations/0671_mobile_push_tokens.sql',import.meta.url),'utf8');
 await owner.db.transaction(async tx=>{for(const block of source.split('--> statement-breakpoint').filter(value=>value.trim()))await tx.execute(sql.raw(block));});
 const [installed]=await state();
 if(!installed.registration||!installed.delivery||!installed.release||!installed.guard||!installed.trigger)throw new Error('Push worker schema installation incomplete');
 return async()=>{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`DROP TABLE mobile_push_delivery,mobile_push_registration`);
   await tx.execute(sql`DROP FUNCTION app.mobile_push_release(uuid,text,text)`);
   await tx.execute(sql`DROP FUNCTION app.mobile_push_registration_guard()`);
  });
  const [after]=await state();
  if(after.registration||after.delivery||after.release||after.guard||after.trigger)throw new Error('Push worker schema restoration failed');
 };
}
