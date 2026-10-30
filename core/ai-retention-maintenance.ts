/** Out-of-band expired-custody maintenance. No user/model/HTTP entry point or actor impersonation.
 * The caller supplies its own owner transaction. This grants no database role or HR capability.
 */
import { sql,type SQL } from 'drizzle-orm';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
import {ASSISTANT_TRANSCRIPT_RETENTION_DAYS,expiredAssistantHistoryQueueSql,retireExpiredAssistantHistoryTx} from './assistant-history-expiry';
import type { Tx } from '../db/client';

/** `transcripts` counts exchanges whose raw content (question/answer/tool inputs/disclosure receipt/error)
 * was retired this pass. Their linked feedback, completed strategy marker and original-identity custody
 * (at most one of each per exchange) retire with them and are NOT added to feedback/conversationUses. */
export type AiRetentionResult = Readonly<{ tenants: number; busy: number; reviews: number; feedback: number; transcripts:number; jobs:number;jobFeedback:number;candidateProvenance:number;plans:number;importAssistance:number;importEvaluations:number;nativeOutcomes:number;nativeSources:number;conversationArms:number;conversationUses:number;conversationIntents:number }>;
const extraCustody=[
 {key:'conversationArms',id:'id',table:sql`public.ai_assistant_answer_evaluation_arm`,expiry:sql`expires_at`},
 {key:'conversationUses',id:'id',table:sql`public.ai_assistant_answer_strategy_use`,expiry:sql`expires_at`},
 // Expired-owner UPDATE visibility (row lock only) and the exclusive-Access DELETE custody trigger are
 // declared by the conversation draft; this tick already owns that Access interval.
 {key:'conversationIntents',id:'id',table:sql`public.ai_assistant_answer_evaluation_intent`,expiry:sql`expires_at`},
 {key:'plans',id:'id',table:sql`public.ai_agent_plan_proposal`,expiry:sql`expires_at`},
 {key:'jobFeedback',id:'id',table:sql`public.ai_agent_job_feedback`,expiry:sql`expires_at`},
 {key:'candidateProvenance',id:'candidate_id',table:sql`public.ai_agent_candidate_provenance`,expiry:sql`created_at+interval '720 hours'`},
 {key:'jobs',id:'id',table:sql`public.ai_agent_job_receipt`,expiry:sql`coalesce(expires_at,created_at+interval '720 hours')`},
 {key:'importAssistance',id:'id',table:sql`public.personnel_import_assistance_attempt`,expiry:sql`expires_at`},
 {key:'importEvaluations',id:'id',table:sql`public.employee_import_evaluation_attempt`,expiry:sql`expires_at`}
] as const;
/** Every relation this tick mutates: directly, through a declared FK child cascade (run membership,
 * source target), or inside the owner-only transcript helper (exchange content, original identity
 * custody, per-transaction retirement scope, linked feedback/markers). The count is derived from this
 * list; a duplicate or missing relation refuses the whole tick. */
export const AI_RETENTION_MAINTAINED_RELATIONS=Object.freeze([
 'public.ai_assistant_answer_evaluation_arm','public.ai_assistant_answer_strategy_use','public.ai_assistant_answer_evaluation_intent',
 'app.assistant_own_leave_review','app.assistant_own_leave_review_content','public.ai_agent_feedback',
 'public.ai_agent_plan_proposal','public.ai_agent_job_feedback','public.ai_agent_candidate_provenance','public.ai_agent_job_receipt',
 'public.personnel_import_assistance_attempt','public.employee_import_evaluation_attempt','public.employee_import_evaluation_run_membership',
 'public.ai_native_outcome_association','app.native_outcome_source_capture','app.native_outcome_source_target',
 'public.assistant_exchange','app.assistant_transcript_identity','app.assistant_transcript_retirement_scope',
] as const);
/** Static table/expiry inventory only; no caller SQL or identifiers are accepted. */
export function expiredAiCustodyQueueSql():SQL{return sql`select tenant_id,expires_at from app.assistant_own_leave_review where state='awaiting_confirmation' and expires_at<=now()
 union all select tenant_id,expires_at from public.ai_agent_feedback where expires_at<=now()
 union all select tenant_id,expires_at from public.ai_native_outcome_association where expires_at<=now()
 union all select tenant_id,expires_at from app.native_outcome_source_capture where expires_at<=now()
 union all ${expiredAssistantHistoryQueueSql()}
 union all ${sql.join(extraCustody.map(item=>sql`select tenant_id,${item.expiry} as expires_at from ${item.table} where ${item.expiry}<=now()`),sql` union all `)}`;}
const unavailable = (): never => { throw new Error('AI retention maintenance could not be confirmed.'); };
const count = (value: unknown, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return unavailable();
  return value;
};

/** Fixed bounds: ten oldest tenant queues, at most100 direct rows of each custody class per tenant; declared child cascades also retire dependent metadata.
 * Raw transcript content retires FIRST inside each owned Access interval, before any metadata expiry,
 * through the owner-only 30-day helper (at most100 exchanges per tenant).
 * Expiry is database-owned. Busy Access intervals are skipped, never stolen or waited upon.
 * Completion references remain; expired ciphertext and dictionary-checkable intent hashes do not.
 * No claim of a maximum cleanup lag follows without scheduling/capacity/rollback verification.
 */
export async function retireExpiredAiCustodyTx(tx: Tx): Promise<AiRetentionResult> {
  try {
    // Install non-increasing bounds BEFORE even catalog/ownership probes can wait.
    await boundNativeOutcomeTransactionTx(tx);
    const [role] = await tx.execute<{ allowed: boolean }>(sql`select current_user=session_user and current_user<>'ai_hr_app'
      and current_setting('transaction_isolation')='read committed'
      and current_setting('transaction_read_only')='off'
      and has_function_privilege(current_user,'app.agent_signal_custody_visible(text,uuid,uuid,uuid)','EXECUTE')
      and has_function_privilege(current_user,'app._payroll_completion_shape(jsonb,text,text)','EXECUTE')
      and (select r.rolsuper or p.proowner=r.oid from pg_catalog.pg_roles r cross join pg_catalog.pg_proc p
        where r.rolname=current_user and p.oid='app.assistant_transcripts_retire_expired(uuid,integer,integer)'::regprocedure) is true
      and (select count(*)=${AI_RETENTION_MAINTAINED_RELATIONS.length} and bool_and(r.rolsuper or c.relowner=r.oid)
        from pg_catalog.pg_roles r cross join pg_catalog.pg_class c where r.rolname=current_user
        and c.oid in (${sql.join(AI_RETENTION_MAINTAINED_RELATIONS.map(name=>sql`${name}::regclass`),sql`,`)})) as allowed`);
    if (role?.allowed !== true) return unavailable();
    const tenants = await tx.execute<{ tenant_id: string }>(sql`select tenant_id from (
      ${expiredAiCustodyQueueSql()}
    ) expired group by tenant_id order by min(expires_at),tenant_id limit 10`);
    if (tenants.length > 10) return unavailable();
    let busy = 0, reviews = 0, feedback = 0, transcripts = 0;
    const removed={jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0};
    for (const tenant of tenants) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tenant.tenant_id)) return unavailable();
      const [lock] = await tx.execute<{ owned: boolean }>(sql`select pg_try_advisory_xact_lock(
        hashtextextended(${'access-configuration:' + tenant.tenant_id},0)) as owned`);
      if (lock?.owned !== true) { busy++; continue; }
      // Raw chat content first, under this same exclusive Access interval and BEFORE metadata expiry.
      // The SQL owner re-proves physical ownership, re-enters (never waits for) this Access interval,
      // retires at most100 exchanges and deletes no exchange row, so no allowance is replenished.
      transcripts += count(await retireExpiredAssistantHistoryTx(tx, tenant.tenant_id, ASSISTANT_TRANSCRIPT_RETENTION_DAYS, 100), 100);
      const [review] = await tx.execute<{ retired: number; erased: number }>(sql`with selected as (
        select id from app.assistant_own_leave_review where tenant_id=${tenant.tenant_id}::uuid
          and state='awaiting_confirmation' and expires_at<=now()
        order by expires_at,id limit 100 for update skip locked
      ), retired as (
        update app.assistant_own_leave_review r set state='expired',intent_digest=null,reviewed_digest=null,
          payroll_completion_root=case when r.action_kind='payroll.reopen' then null else r.payroll_completion_root end,
          org_manager_person_id=null,org_previous_manager_person_id=null
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
      // Append/delete-only native custody has NO UPDATE policy or privilege. A plain bounded
      // selection followed by DELETE joins its trigger-enforced TRY custody interval. Never reuse
      // the generic FOR UPDATE SKIP LOCKED inventory below for these relations. Busy row/trigger
      // failure rolls back the ENTIRE maintenance tick; no partial-success receipt is returned.
      for(const item of [
        {key:'nativeOutcomes',table:sql`public.ai_native_outcome_association`},
        {key:'nativeSources',table:sql`app.native_outcome_source_capture`}
      ] as const){
        const [erased]=await tx.execute<{removed:number}>(sql`with selected as(
          select id from ${item.table} where tenant_id=${tenant.tenant_id}::uuid and expires_at<=now()
          order by expires_at,id limit 100
        ), erased as(delete from ${item.table} target using selected
          where target.id=selected.id and target.tenant_id=${tenant.tenant_id}::uuid and target.expires_at<=now() returning target.id)
        select count(*)::integer as removed from erased`);
        removed[item.key]+=count(erased?.removed,100);
      }
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
    return Object.freeze({ tenants: tenants.length, busy, reviews, feedback, transcripts,...removed });
  } catch { return unavailable(); }
}
