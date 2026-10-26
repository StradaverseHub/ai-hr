/** Out-of-band expired-custody maintenance. No user/model/HTTP entry point or actor impersonation.
 * The caller supplies its own owner transaction. This grants no database role or HR capability.
 */
import { sql,type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';

export type AiRetentionResult = Readonly<{ tenants: number; busy: number; reviews: number; feedback: number; jobs:number;jobFeedback:number;candidateProvenance:number;plans:number;importAssistance:number }>;
const extraCustody=[
 {key:'plans',id:'id',table:sql`public.ai_agent_plan_proposal`,expiry:sql`expires_at`},
 {key:'jobFeedback',id:'id',table:sql`public.ai_agent_job_feedback`,expiry:sql`expires_at`},
 {key:'candidateProvenance',id:'candidate_id',table:sql`public.ai_agent_candidate_provenance`,expiry:sql`created_at+interval '720 hours'`},
 {key:'jobs',id:'id',table:sql`public.ai_agent_job_receipt`,expiry:sql`coalesce(expires_at,created_at+interval '720 hours')`},
 {key:'importAssistance',id:'id',table:sql`public.personnel_import_assistance_attempt`,expiry:sql`expires_at`}
] as const;
/** Static table/expiry inventory only; no caller SQL or identifiers are accepted. */
export function expiredAiCustodyQueueSql():SQL{return sql`select tenant_id,expires_at from app.assistant_own_leave_review where state='awaiting_confirmation' and expires_at<=now()
 union all select tenant_id,expires_at from public.ai_agent_feedback where expires_at<=now()
 union all ${sql.join(extraCustody.map(item=>sql`select tenant_id,${item.expiry} as expires_at from ${item.table} where ${item.expiry}<=now()`),sql` union all `)}`;}
const unavailable = (): never => { throw new Error('AI retention maintenance could not be confirmed.'); };
const count = (value: unknown, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return unavailable();
  return value;
};

/** Fixed bounds: ten oldest tenant queues, at most100 direct rows of each custody class per tenant; declared child cascades also retire dependent metadata.
 * Expiry is database-owned. Busy Access intervals are skipped, never stolen or waited upon.
 * Completion references remain; expired ciphertext and dictionary-checkable intent hashes do not.
 * No claim of a maximum cleanup lag follows without scheduling/capacity/rollback verification.
 */
export async function retireExpiredAiCustodyTx(tx: Tx): Promise<AiRetentionResult> {
  try {
    const [role] = await tx.execute<{ allowed: boolean }>(sql`select current_user=session_user and current_user<>'ai_hr_app'
      and current_setting('transaction_isolation')='read committed'
      and current_setting('transaction_read_only')='off'
      and has_function_privilege(current_user,'app.agent_signal_custody_visible(text,uuid,uuid,uuid)','EXECUTE')
      and (select count(*)=8 and bool_and(r.rolsuper or c.relowner=r.oid)
        from pg_catalog.pg_roles r cross join pg_catalog.pg_class c where r.rolname=current_user
        and c.oid in ('app.assistant_own_leave_review'::regclass,
          'app.assistant_own_leave_review_content'::regclass,'public.ai_agent_feedback'::regclass,
          'public.ai_agent_plan_proposal'::regclass,'public.ai_agent_job_feedback'::regclass,'public.ai_agent_candidate_provenance'::regclass,
          'public.ai_agent_job_receipt'::regclass,'public.personnel_import_assistance_attempt'::regclass)) as allowed`);
    if (role?.allowed !== true) return unavailable();
    // Each statement is bounded independently; never weaken another owner's timeout or role/session.
    const bounds = await tx.execute(sql`select name,set_config(name,(case
      when setting::bigint=0 then case name when 'statement_timeout' then 5000 else 500 end
      else least(setting::bigint,case name when 'statement_timeout' then 5000 else 500 end)
      end)::text,true) as value from pg_catalog.pg_settings
      where name in ('statement_timeout','lock_timeout') and unit='ms'`);
    if (bounds.length !== 2) return unavailable();
    const tenants = await tx.execute<{ tenant_id: string }>(sql`select tenant_id from (
      ${expiredAiCustodyQueueSql()}
    ) expired group by tenant_id order by min(expires_at),tenant_id limit 10`);
    if (tenants.length > 10) return unavailable();
    let busy = 0, reviews = 0, feedback = 0;
    const removed={jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0};
    for (const tenant of tenants) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tenant.tenant_id)) return unavailable();
      const [lock] = await tx.execute<{ owned: boolean }>(sql`select pg_try_advisory_xact_lock(
        hashtextextended(${'access-configuration:' + tenant.tenant_id},0)) as owned`);
      if (lock?.owned !== true) { busy++; continue; }
      const [review] = await tx.execute<{ retired: number; erased: number }>(sql`with selected as (
        select id from app.assistant_own_leave_review where tenant_id=${tenant.tenant_id}::uuid
          and state='awaiting_confirmation' and expires_at<=now()
        order by expires_at,id limit 100 for update skip locked
      ), retired as (
        update app.assistant_own_leave_review r set state='expired',intent_digest=null,reviewed_digest=null
        from selected s where r.id=s.id and r.tenant_id=${tenant.tenant_id}::uuid returning r.id
      ), erased as (
        delete from app.assistant_own_leave_review_content c using retired r
        where c.action_id=r.id returning c.action_id
      ) select (select count(*)::int from retired) as retired,(select count(*)::int from erased) as erased`);
      const retired = count(review?.retired, 100);
      if (count(review?.erased, 100) !== retired) return unavailable();
      reviews += retired;
      const [opinion] = await tx.execute<{ removed: number }>(sql`with selected as (
        select id from public.ai_agent_feedback where tenant_id=${tenant.tenant_id}::uuid and expires_at<=now()
        order by expires_at,id limit 100 for update skip locked
      ), erased as (delete from public.ai_agent_feedback f using selected s
        where f.id=s.id and f.tenant_id=${tenant.tenant_id}::uuid and f.expires_at<=now() returning f.id)
      select count(*)::int as removed from erased`);
      feedback += count(opinion?.removed, 100);
      for(const item of extraCustody){
        const [erased]=await tx.execute<{removed:number}>(sql`with selected as (
          select ${sql.identifier(item.id)} as id from ${item.table} where tenant_id=${tenant.tenant_id}::uuid and ${item.expiry}<=now()
          order by ${item.expiry},${sql.identifier(item.id)} limit 100 for update skip locked
        ), erased as(delete from ${item.table} target using selected where target.${sql.identifier(item.id)}=selected.id
          and target.tenant_id=${tenant.tenant_id}::uuid returning target.${sql.identifier(item.id)})
        select count(*)::int as removed from erased`);
        removed[item.key]+=count(erased?.removed,100);
      }

    }
    return Object.freeze({ tenants: tenants.length, busy, reviews, feedback,...removed });
  } catch { return unavailable(); }
}
