/** AI Centre issue 8 — the retention runner's hard deletion of expired stored chats (migration 0952).
 *
 * Out-of-band only: called by scripts/ai-retention-runner.ts in the physical table owner's own transaction, after the
 * AI custody tick. No user, model or HTTP entry point. db/client-free (the operator runner's import boundary).
 *
 * The owner's session sees teras_chat rows only once they have expired (expires_at: the last message plus the tenant's
 * "Keep chats for" days, brought forward when the setting is shortened) and those rows carry no words. Each chat's
 * turns go with it by the foreign-key cascade; the owner has no policy on teras_chat_turn, so this path can neither read
 * nor select a turn. The chat's task memory goes by the 0952 delete trigger. Expiry is database-owned.
 *
 * Letter requests confirmed from a chat card (migration 0973): the request is HR's record and stays; the card's id on it
 * (letter_request.client_key, chat-linked) is cleared by the 0973 delete trigger on teras_chat, on this path as on every
 * other path that removes a chat. */
import {sql,type SQL} from 'drizzle-orm';
import type {Tx} from '../db/client';

/** At most this many chats per pass, oldest first; the runner reports any backlog. */
export const TERAS_CHAT_RETENTION_BATCH=500;
/** Every relation one pass mutates: directly, by the turn cascade, inside the memory trigger or inside the 0973 letter
 * card-key trigger (client_key only). */
export const TERAS_CHAT_MAINTAINED_RELATIONS=Object.freeze(['public.teras_chat','public.teras_chat_turn','public.teras_task_memory','public.letter_request'] as const);

const unavailable=():never=>{throw new Error('Chat retention could not be confirmed.');};
const count=(value:unknown):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=TERAS_CHAT_RETENTION_BATCH?value:unavailable();

/** Expired chats by tenant and effective deadline only, for the runner's backlog signal. */
export function expiredTerasChatQueueSql():SQL{
 return sql`select tenant_id,expires_at from public.teras_chat where expires_at<=now()`;
}

/** Hard-deletes up to TERAS_CHAT_RETENTION_BATCH expired chats (and, by cascade, their turns and task memory) and
 * returns how many. Refuses unless this is the physical owner's own read-write session, never the application role. */
export async function retireExpiredTerasChatsTx(tx:Tx):Promise<number>{
 try{
  const [role]=await tx.execute<{allowed:boolean}>(sql`select current_user=session_user and current_user<>'ai_hr_app'
   and current_setting('transaction_read_only')='off'
   and (select count(*)=${TERAS_CHAT_MAINTAINED_RELATIONS.length} and bool_and(r.rolsuper or c.relowner=r.oid)
    from pg_catalog.pg_roles r cross join pg_catalog.pg_class c where r.rolname=current_user
    and c.oid in (${sql.join(TERAS_CHAT_MAINTAINED_RELATIONS.map(name=>sql`${name}::regclass`),sql`,`)})) as allowed`);
  if(role?.allowed!==true)return unavailable();
  const [erased]=await tx.execute<{removed:number}>(sql`with selected as (
    select tenant_id,id from public.teras_chat where expires_at<=now() order by expires_at,id limit ${TERAS_CHAT_RETENTION_BATCH}
   ), erased as (delete from public.teras_chat target using selected
    where target.tenant_id=selected.tenant_id and target.id=selected.id
     and target.expires_at<=now() returning target.id)
   select count(*)::int as removed from erased`);
  return count(erased?.removed);
 }catch{return unavailable();}
}
