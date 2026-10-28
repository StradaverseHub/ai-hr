/** Non-increasing local bounds, installed before native completed readers can take row locks.
 * No authority or resource ownership is acquired here. Refusals require whole caller-Tx rollback. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
export async function boundNativeOutcomeTransactionTx(tx:Tx){
 const bounds=await tx.execute(sql`select name,set_config(name,(case when setting::bigint=0 then case name when 'statement_timeout' then 5000 else 500 end else least(setting::bigint,case name when 'statement_timeout' then 5000 else 500 end) end)::text,true) as value from pg_catalog.pg_settings where name in ('statement_timeout','lock_timeout') and unit='ms'`);
 if(bounds.length!==2)throw Error('Native outcome unavailable.');
}
