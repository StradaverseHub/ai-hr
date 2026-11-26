/**
 * bc6b5490 — THE REVIEWED, ONE-OFF DATA STEP for CP38 "Effective to" (the last month deducted). NOT RUN BY DEPLOY.
 *
 *   node --import tsx scripts/cp38-inclusive-effective-to-bc6b5490.ts                       # list only (default)
 *   node --import tsx scripts/cp38-inclusive-effective-to-bc6b5490.ts --confirm --ids=<id,id>  # move those rows
 *
 * ON THE SERVER, SOURCE THE ENV (see scripts/backfill-assignment-company.ts for why `--env-file` is not used):
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && node --import tsx scripts/cp38-inclusive-effective-to-bc6b5490.ts
 *
 * WHY. Before bc6b5490 the CP38 forms posted the month the operator typed in "Effective to" and the service stored it as
 * the EXCLUSIVE end of the window, so "January to July" was deducted January to June and a one-month record never. From
 * this release the service translates (core/cp38.ts): the stored valid_to is the first day after the last deducted
 * month, and screens show valid_to minus one month. A row whose valid_to was set by setCp38 when it closed the previous
 * record (valid_to = the successor's valid_from) was always exclusive and is already right. A row whose valid_to an
 * operator typed is one month short. The table cannot tell the two apart, so this script LISTS every current row whose
 * valid_to is not another current row's valid_from for the same employment — the operator-typed candidates — with the
 * month it would start deducting and the state of that month's payroll, for the owner and reporter to check.
 *
 * WHAT --confirm DOES, and only for the ids passed in --ids (each must still be a listed candidate; anything else is
 * refused before any write): moves valid_to one month later (the newly deducted month is the old valid_to's month), in
 * one transaction per tenant; appends one 'edit' row per moved record to employee_cp38_revision (before/after, no
 * actor: the data step) and an `employee-cp38.updated` event (refs/dates only); and marks each processed (not closed)
 * run that paid that employee for the newly deducted month as Reprocess Required (category 'cp38'), the same columns and
 * event markBatchesNeedRecalcTx writes. It NEVER changes a closed month: a closed payslip is never recalculated, and a
 * closed run is not marked — the listing shows "closed" so the owner can decide whether that row should move at all.
 * A row whose newly deducted month would overlap the next current record of the employee is refused, not moved.
 *
 * SHAPE. MIGRATION_DATABASE_URL (the owner role) enumerates across tenants, as every other repair script here does.
 * Set-based: one listing statement, and per tenant one update, one revision insert, one event insert and one mark.
 * SAFE TO RE-RUN: a moved row's new valid_to is checked again by the listing (and normally drops out of it when it now
 * equals a successor's start); the confirm list is always explicit.
 *
 * EVIDENCE. Run it separately on each installation (staging, then production with its own permission), keep the
 * printed listing and, after --confirm, the printed counts. Deployment does not imply it ran.
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { appendEvents, type AppendEventArgs } from '../db/events';

/** Stored exclusive end ('YYYY-MM-01') → the inclusive last month, as core/cp38.ts cp38LastMonthOf (kept local so this
 * script adds no importer of the payroll pack's boundary modules). */
const lastMonthOf = (storedTo: string): string => {
  const [y, m] = storedTo.slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
};

type Db = ReturnType<typeof createDb>['db'];

export type Cp38EffectiveToCandidate = {
  id: string;
  tenantId: string;
  employmentId: string;
  employeeCode: string | null;
  cp38Ref: string;
  validFrom: string;
  /** The stored (exclusive) end today. */
  validTo: string;
  /** The month ('YYYY-MM') that would start being deducted: the old valid_to's month. */
  newlyDeductedMonth: string;
  /** Payroll for that month and employee: 'closed', 'processed', 'processing', 'draft' or 'none' (the most final). */
  payrollState: 'closed' | 'processed' | 'processing' | 'draft' | 'none';
  /** The move would overlap the employee's next current record. */
  blocked: boolean;
};

/** Every current CP38 row whose valid_to was typed by an operator (not set by a successor's start). One statement. */
export async function listCp38EffectiveToCandidates(db: Db): Promise<Cp38EffectiveToCandidate[]> {
  const rows = await db.execute<Cp38EffectiveToCandidate>(sql`
    select r.id, r.tenant_id as "tenantId", r.employment_id as "employmentId", e.employee_code as "employeeCode",
      r.cp38_ref as "cp38Ref", r.valid_from::text as "validFrom", r.valid_to::text as "validTo",
      to_char(r.valid_to, 'YYYY-MM') as "newlyDeductedMonth",
      coalesce((select case max(case b.status when 'closed' then 4 when 'processed' then 3 when 'processing' then 2 else 1 end)
                  when 4 then 'closed' when 3 then 'processed' when 2 then 'processing' when 1 then 'draft' end
                from payroll_batch b join payslip ps on ps.batch_id = b.id and ps.employment_id = r.employment_id
                where b.tenant_id = r.tenant_id and b.pay_period = to_char(r.valid_to, 'YYYY-MM')), 'none') as "payrollState",
      exists (select 1 from employee_cp38 o where o.employment_id = r.employment_id and o.id <> r.id and o.superseded_at is null
              and daterange(o.valid_from, o.valid_to, '[)') && daterange(r.valid_to, (r.valid_to + interval '1 month')::date, '[)')) as blocked
    from employee_cp38 r
    join employment e on e.id = r.employment_id and e.tenant_id = r.tenant_id
    where r.superseded_at is null and r.valid_to is not null
      and not exists (select 1 from employee_cp38 s where s.employment_id = r.employment_id and s.id <> r.id
                      and s.superseded_at is null and s.valid_from = r.valid_to)
    order by r.tenant_id, e.employee_code nulls last, r.valid_from, r.id`);
  return Array.from(rows);
}

/** Move the confirmed candidates. Refuses (before any write) an id that is not a listed, unblocked candidate. */
export async function applyCp38EffectiveTo(db: Db, ids: readonly string[]): Promise<{ moved: number; marked: number }> {
  const candidates = await listCp38EffectiveToCandidates(db);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const chosen = ids.map((id) => byId.get(id));
  const bad = ids.filter((id, i) => !chosen[i] || chosen[i]!.blocked);
  if (bad.length) throw new Error(`Not listed, or blocked by the next record, so nothing was written: ${bad.join(', ')}`);
  const byTenant = new Map<string, Cp38EffectiveToCandidate[]>();
  for (const c of chosen as Cp38EffectiveToCandidate[]) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c]);
  let moved = 0;
  let marked = 0;
  for (const [tenantId, rows] of byTenant) {
    await db.transaction(async (tx) => {
      const list = JSON.stringify(rows.map((r) => ({ id: r.id, valid_to: r.validTo })));
      // Re-checks the row inside the write: still current and still ending where it was listed.
      const updated = await tx.execute<{ id: string; before: unknown; after: unknown; employmentId: string; cp38Ref: string; validFrom: string; oldTo: string; newTo: string }>(sql`
        with chosen as (select * from jsonb_to_recordset(${list}::jsonb) as c(id uuid, valid_to date)),
        moved as (
          update employee_cp38 r set valid_to = (r.valid_to + interval '1 month')::date
          from chosen c where r.id = c.id and r.tenant_id = ${tenantId}::uuid and r.superseded_at is null and r.valid_to = c.valid_to
          returning r.*, c.valid_to as old_to)
        select m.id, m.employment_id as "employmentId", m.cp38_ref as "cp38Ref", m.valid_from::text as "validFrom",
          m.old_to::text as "oldTo", m.valid_to::text as "newTo",
          jsonb_build_object('cp38Ref', m.cp38_ref, 'amount', m.amount::text, 'lastMonthAmount', m.last_month_amount::text,
            'validFrom', m.valid_from::text, 'validTo', to_char(m.old_to - interval '1 month', 'YYYY-MM-DD'), 'remarks', m.remarks) as before,
          jsonb_build_object('cp38Ref', m.cp38_ref, 'amount', m.amount::text, 'lastMonthAmount', m.last_month_amount::text,
            'validFrom', m.valid_from::text, 'validTo', m.old_to::text, 'remarks', m.remarks) as after
        from moved m`);
      if (updated.length !== rows.length) throw new Error(`Tenant ${tenantId}: ${rows.length - updated.length} row(s) changed since listing; nothing written.`);
      const revisions = JSON.stringify(updated.map((u) => ({ cp38_id: u.id, employment_id: u.employmentId, before: u.before, after: u.after })));
      await tx.execute(sql`insert into employee_cp38_revision (tenant_id, cp38_id, employment_id, action, before, after, actor_user_id)
        select ${tenantId}::uuid, v.cp38_id, v.employment_id, 'edit', v.before, v.after, null
        from jsonb_to_recordset(${revisions}::jsonb) as v(cp38_id uuid, employment_id uuid, before jsonb, after jsonb)`);
      const events: AppendEventArgs[] = updated.map((u) => ({
        tenantId, aggregateType: 'employee-cp38', aggregateId: u.id, eventType: 'employee-cp38.updated', actor: { type: 'system' },
        subjectEmploymentId: u.employmentId,
        payload: { before: { cp38Ref: u.cp38Ref, validFrom: u.validFrom, validTo: lastMonthOf(u.oldTo) },
          after: { cp38Ref: u.cp38Ref, validFrom: u.validFrom, validTo: u.oldTo }, diff: ['validTo'], source: 'bc6b5490_effective_to_step' },
      }));
      // Mark the processed (not closed) runs that paid the employee for the newly deducted month, as the native mark does.
      const months = JSON.stringify(updated.map((u) => ({ employment_id: u.employmentId, period: u.oldTo.slice(0, 7) })));
      const runs = await tx.execute<{ id: string; ids: string[]; added: string[] }>(sql`
        with wanted as (select * from jsonb_to_recordset(${months}::jsonb) as w(employment_id uuid, period text)),
        hits as (select b.id, array_agg(distinct ps.employment_id::text order by ps.employment_id::text) as added
          from payroll_batch b join payslip ps on ps.batch_id = b.id join wanted w on w.employment_id = ps.employment_id and w.period = b.pay_period
          where b.tenant_id = ${tenantId}::uuid and b.status = 'processed' group by b.id),
        locked as (select b.id, b.recalc_employment_ids from payroll_batch b join hits h on h.id = b.id order by b.id for update of b)
        update payroll_batch b set needs_recalc_at = coalesce(b.needs_recalc_at, now()),
          recalc_employment_ids = (select to_jsonb(array_agg(distinct x order by x)) from (
            select jsonb_array_elements_text(coalesce(l.recalc_employment_ids, '[]'::jsonb)) as x union select unnest(h.added)) u)
        from hits h join locked l on l.id = h.id where b.id = h.id
        returning b.id, (select array(select jsonb_array_elements_text(b.recalc_employment_ids))) as ids, h.added`);
      for (const run of runs) {
        events.push({ tenantId, aggregateType: 'payroll-batch', aggregateId: run.id, eventType: 'payroll-batch.recalc-required', actor: { type: 'system' },
          payload: { employmentIds: run.ids, addedEmploymentIds: run.added, changeCategory: 'cp38', source: 'bc6b5490_effective_to_step' } });
      }
      await appendEvents(tx, events);
      moved += updated.length;
      marked += runs.length;
    });
  }
  return { moved, marked };
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const ids = (process.argv.find((a) => a.startsWith('--ids='))?.slice('--ids='.length) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('cp38-inclusive-effective-to requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  if (confirm && ids.length === 0) {
    console.error('--confirm needs --ids=<id,id,...>: the rows the owner and reporter confirmed from the listing.');
    process.exit(1);
  }
  const storage = createDb(ownerUrl, { max: 1 });
  try {
    if (!confirm) {
      const rows = await listCp38EffectiveToCandidates(storage.db);
      console.log(`cp38-inclusive-effective-to LIST ONLY (pass --confirm --ids=… to move) — ${rows.length} candidate row(s)`);
      for (const r of rows) {
        console.log([r.tenantId, r.id, r.employeeCode ?? '-', r.cp38Ref, `from ${r.validFrom}`, `stored end ${r.validTo}`,
          `would also deduct ${r.newlyDeductedMonth}`, `payroll ${r.payrollState}`, r.blocked ? 'BLOCKED by next record' : ''].join('\t'));
      }
      return;
    }
    const result = await applyCp38EffectiveTo(storage.db, ids);
    console.log(`cp38-inclusive-effective-to APPLIED — moved ${result.moved} row(s), marked ${result.marked} processed run(s) Reprocess Required`);
  } finally {
    await storage.client.end();
  }
}

if (process.argv[1]?.endsWith('/cp38-inclusive-effective-to-bc6b5490.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'CP38 Effective to step failed.');
    process.exitCode = 1;
  });
}
