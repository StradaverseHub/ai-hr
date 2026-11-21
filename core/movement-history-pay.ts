import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  isMovementHistoryPayField, normaliseHistoryPayValue, type HistoryPayFacts,
} from '../lib/movement-history-pay';

export async function canWriteMovementHistoryPayTx(tx: Tx, employmentId: string, companyIds: string[] = []) {
  const [scope] = await tx.execute<{ allowed: boolean }>(sql`
    select exists (
      select from public.employment e where e.id=${employmentId}::uuid and app.can_admin_employment(e.id)
        and app.can_admin_payroll_for(e.company_id)
    ) and not exists(
      select from jsonb_array_elements_text(${JSON.stringify(companyIds)}::jsonb) c(id)
      where not coalesce(app.can_admin_payroll_for(c.id::uuid), false)
    ) as allowed
  `);
  return scope?.allowed === true;
}

export function canWriteMovementHistoryPay(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, (tx) => canWriteMovementHistoryPayTx(tx, employmentId));
}

export function normaliseMovementHistoryPay(facts: HistoryPayFacts): HistoryPayFacts | null {
  const canonical: HistoryPayFacts = {};
  for (const [field, fact] of Object.entries(facts)) {
    if (!isMovementHistoryPayField(field)) return null;
    const before = normaliseHistoryPayValue(field, fact.before);
    const after = fact.after == null ? undefined : normaliseHistoryPayValue(field, fact.after);
    if (before == null || after === null) return null;
    canonical[field] = { before, ...(after !== undefined ? { after } : {}) };
  }
  return canonical;
}

export async function readMovementHistoryPayTx(tx: Tx, employmentId: string, eventId: string) {
  const [row] = await tx.execute<{ facts: HistoryPayFacts }>(sql`
    select facts from app.movement_history_pay_evidence
    where event_id=${eventId}::uuid and employment_id=${employmentId}::uuid
  `);
  return row?.facts;
}

export async function storeMovementHistoryPayTx(
  tx: Tx, employmentId: string, eventId: string, companyIds: string[], facts: HistoryPayFacts,
) {
  await tx.execute(sql`
    insert into app.movement_history_pay_evidence(event_id,tenant_id,employment_id,company_ids,facts)
    values(${eventId}::uuid,app.current_tenant_id(),${employmentId}::uuid,
      array(select jsonb_array_elements_text(${JSON.stringify(companyIds)}::jsonb))::uuid[],
      ${JSON.stringify(facts)}::jsonb)
  `);
}
