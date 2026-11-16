/**
 * Real email for shared workflow steps (migration 5754; ADR 2026-11-15-probation-shared-automation, decision 2).
 *
 * Queueing: a "Send an email" or "Notify someone" step records a durable email intent in the caller's transaction
 * (the same transaction as the command that raised the event) through app.automation_email_queue. To and CC are the
 * user ids the module resolved; routings and groups as recipients reach everyone matched, and the fallback group is the
 * module's concern. People without a sign-in email are returned so the run records them.
 *
 * Delivery: `deliverAutomationEmails` is the out-of-band worker, run by the scheduled workflow sweep on the owner
 * connection. It follows On/Off Boarding V9's worker (packs/lifecycle/v9/service.ts v9DeliverEmails): each claim, start
 * and receipt commits on its own and the SMTP call happens outside every transaction, under no business lock. A message
 * whose send started and whose receipt was lost becomes `uncertain` and is never re-sent automatically.
 */
import type {AutomationRichEmailBody} from '../lib/automation-email-content';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import type {SqlExecutor} from '../db/sql-executor';
import type {NotificationSweepConnection} from './notice-projection';
import {isModuleEnabled} from './entitlements';
import {automationEmailIpc,type AutomationDeliveryRequest,type AutomationDeliveryResult,type AutomationEmailContent} from '../lib/automation-email-ipc';
import {validateAutomationEmailContent} from '../lib/automation-email-content-policy';

export type AutomationEmailQueued = {queued: number; to: string[]; cc: string[]; unreachable: string[]};
/** Records the email intent in the caller's transaction (idempotent on `key`). */
export async function queueAutomationEmailTx(tx: SqlExecutor, input: {module: 'probation'|'contract_staff'|'off'; subjectId: string; key: string; to: readonly string[]; cc: readonly string[]; subject: string; body: string;richBody?:AutomationRichEmailBody;content?:AutomationEmailContent}, ctx?: SessionContext): Promise<AutomationEmailQueued> {
  const array = (ids: readonly string[]) => `{${ids.join(',')}}`;
  if (input.module === 'off') {
    if (!ctx) throw new Error('Resignation email requires the authorized command context.');
    if (input.content) validateAutomationEmailContent(input.content);
    const {prepareResignationEmailTx}=await import('../packs/lifecycle/service');
    await prepareResignationEmailTx(tx,ctx,{caseId:input.subjectId,key:input.key,to:input.to,cc:input.cc,subject:input.subject,body:input.body,content:input.content});
    const [row] = await tx.execute<{data: AutomationEmailQueued}>(sql`select app.resignation_email_queue(${input.subjectId}::uuid, ${input.key}, ${array(input.to)}::uuid[], ${array(input.cc)}::uuid[], ${input.subject}, ${input.body}, ${JSON.stringify(input.content ?? null)}::jsonb) as data`);
    return row.data;
  }
  const [row] = await tx.execute<{data: AutomationEmailQueued}>(sql`select app.automation_email_queue_rich(${input.module}, ${input.subjectId}::uuid, ${input.key}, ${array(input.to)}::uuid[], ${array(input.cc)}::uuid[], ${input.subject.slice(0, 500)}, ${input.body.slice(0, 20000)},${input.richBody?JSON.stringify(input.richBody):null}::jsonb) as data`);
  return row.data;
}

type Job = {id: string; module: string; subject_id: string; status: string; lease_token: string | null; started_at: string | null; company_id: string | null};
/** Durable transport worker for shared workflow email. Requires the owner connection (no signed-in user). */
export async function deliverAutomationEmails(ctx: SessionContext, connection: NotificationSweepConnection, send: (request: AutomationDeliveryRequest) => Promise<AutomationDeliveryResult> = automationEmailIpc) {
  if (ctx.userId) throw new Error('Workflow email delivery requires the storage owner.');
  const output = {attempted: 0, sent: 0, held: 0, failed: 0, cancelled: 0};
  const due = await connection.withTenant(ctx, async tx => {
    const [owner] = await tx.execute<{ok: boolean}>(sql`select current_user='ai_hr_owner' or exists(select 1 from pg_roles where rolname=current_user and rolsuper) as ok`);
    if (!owner?.ok) throw new Error('Workflow email delivery requires the storage owner.');
    await tx.execute(sql`update automation_email_delivery set status='uncertain',completed_at=now(),error_code='uncertain',updated_at=now() where tenant_id=${ctx.tenantId}::uuid and status='sending' and lease_until<=now()`);
    await tx.execute(sql`update automation_email_delivery set status='queued',lease_token=null,lease_until=null,updated_at=now() where tenant_id=${ctx.tenantId}::uuid and status='leased' and started_at is null and lease_until<=now()`);
    return tx.execute<{id: string}>(sql`select id from automation_email_delivery where tenant_id=${ctx.tenantId}::uuid and status='queued' and next_attempt_at<=now() order by next_attempt_at,id limit 25`);
  });
  for (const {id} of due) {
    try {
      const claim = await connection.withTenant(ctx, async tx => {
        const [job] = await tx.execute<Job>(sql`select d.id,d.module,d.subject_id,d.status,d.lease_token,d.started_at,coalesce(c.company_id,contract.company_id,j.company_id) as company_id from automation_email_delivery d left join probation_case c on d.module='probation' and c.id=d.subject_id and c.tenant_id=d.tenant_id left join contract_case contract on d.module='contract_staff' and contract.id=d.subject_id and contract.tenant_id=d.tenant_id left join resignation_journey j on d.module='off' and j.id=d.subject_id and j.tenant_id=d.tenant_id where d.id=${id}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.status='queued' and d.next_attempt_at<=now() for update of d skip locked`);
        if (!job) return null;
        // The module must still be in use for the case's company; otherwise the message is cancelled, never sent.
        if (!job.company_id || ctx.entitlementsExempt === undefined && !isModuleEnabled(ctx, 'lifecycle', job.company_id)) {
          await tx.execute(sql`update automation_email_delivery set status='cancelled',error_code='notEligible',updated_at=now() where id=${id}::uuid`);
          return 'cancelled' as const;
        }
        const token = randomUUID();
        await tx.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where id=${id}::uuid and started_at is null`);
        return {deliveryId: id, leaseToken: token};
      });
      if (!claim) continue;
      if (claim === 'cancelled') { output.cancelled++; continue; }
      output.attempted++;
      let response: AutomationDeliveryResult | null = null;
      try { response = await send(claim); } catch { /* Only the durable start marker and receipt decide replay safety. */ }
      const status = await connection.withTenant(ctx, async tx => {
        const [job] = await tx.execute<Job>(sql`select id,module,subject_id,status,lease_token,started_at,null as company_id from automation_email_delivery where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and lease_token=${claim.leaseToken}::uuid for update`);
        if (!job) return 'uncertain';
        if (job.status === 'leased' && !job.started_at) {
          // Not started: a missing relay is held for a later attempt; any other refusal is final and recorded.
          const held = response?.outcome === 'skipped' && response.error === 'relayUnavailable';
          const error = response?.outcome === 'skipped' ? response.error ?? 'notEligible' : 'notEligible';
          await tx.execute(sql`update automation_email_delivery set status=${held ? 'queued' : 'failed'},error_code=${error},lease_token=null,lease_until=null,next_attempt_at=now()+interval '5 minutes',updated_at=now() where id=${id}::uuid`);
          return held ? 'held' : 'failed';
        }
        if (job.status === 'sending') {
          await tx.execute(sql`update automation_email_delivery set status='uncertain',completed_at=now(),error_code='uncertain',updated_at=now() where id=${id}::uuid`);
          return 'uncertain';
        }
        return job.status;
      });
      if (status === 'sent') output.sent++; else if (status === 'held' || status === 'uncertain') output.held++; else output.failed++;
    } catch { output.failed++; }
  }
  return output;
}
