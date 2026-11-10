/** Last Login for the Security Center Users list (board 07c98c36).
 * One owner: the existing app-user.logged-in audit events written by every provider's session start
 * (lib/internal-auth/service.ts, lib/entra/sessions.ts, core/auth.ts). No column duplicates the fact.
 * One batched read for the listed ids; migration 4601's partial index makes each lookup an index seek. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {isAdmin} from '../lib/authz-model';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO instant of each listed app user's latest successful sign-in. An absent id has never signed in. */
export async function readLastSignIns(ctx:SessionContext,userIds:string[]):Promise<Record<string,string>>{
 const ids=[...new Set(userIds.filter(id=>UUID.test(id)).map(id=>id.toLowerCase()))].sort();
 if(!ctx.userId||!isAdmin(ctx)||ids.length===0)return {};
 return withTenant(ctx,async tx=>{
  const rows=await tx.execute(sql`select u.id::text app_user_id,
    (select d.occurred_at from domain_event d where d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='app-user'
      and d.event_type='app-user.logged-in' and d.aggregate_id=u.id order by d.occurred_at desc limit 1) last_sign_in
   from unnest(ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) as u(id) order by u.id`) as unknown as {app_user_id:string;last_sign_in:Date|string|null}[];
  const result:Record<string,string>={};
  for(const row of rows)if(row.last_sign_in!=null)result[row.app_user_id]=new Date(row.last_sign_in).toISOString();
  return result;
 });
}
