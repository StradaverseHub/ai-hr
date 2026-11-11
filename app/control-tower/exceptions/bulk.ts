/**
 * Bulk "Mark as expected" for one set-up group of payroll exceptions (AI-native batch, 11 November 2026).
 *
 * NOT A SECOND RESOLVER. The qualifying exceptions are closed by the anomaly owner's batch resolve
 * (core/payroll-anomaly.ts resolveAnomalyVerdicts): one transaction taking the access lock once, with the same permission
 * check for each person's payroll, audit event and learning-ledger stamp that pressing "Correct as it stands" on each one
 * would give, a guard against anything decided meanwhile, and an outcome per exception. This file only decides which of the requested exceptions qualify, using the pure guard in
 * lib/payroll-exceptions/bulk.ts against what the database says now:
 *  - administrators only, never an agent, and never a group that blocks a run or is not a set-up pattern;
 *  - only the ids that were on the person's screen, at most BULK_EXPECT_MAX of them;
 *  - each one re-read under the caller's row-level security: still open, still not blocking, every finding the group's
 *    own check. Anything else is skipped and counted, never closed.
 * No pay figure changes, no model is called, and nothing is decided that a person did not press.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '@/db/client';
import { isAdmin } from '@/lib/authz-model';
import { resolveAnomalyVerdicts } from '@/core/payroll-anomaly';
import {
  BulkExpectInterrupted, BulkExpectRefused, mayBulkExpect, parseGroupKey, planBulkExpect, requestedIds, variantOf, type BulkCandidate,
} from '@/lib/payroll-exceptions';

export type BulkExpectResult = Readonly<{ resolved: number; skipped: number }>;

const NOTE_MAX = 400;


export async function markGroupExpected(supplied: SessionContext, input: Readonly<{ group: unknown; verdictIds: readonly unknown[]; note: unknown }>):
Promise<BulkExpectResult> {
  const ctx: SessionContext = { ...supplied, roles: supplied.roles?.slice(), grants: supplied.grants?.map(grant => ({ ...grant })) };
  if (!ctx.userId || ctx.agent || !isAdmin(ctx)) throw new BulkExpectRefused('not_administrator');
  const group = parseGroupKey(input.group);
  if (!group) throw new BulkExpectRefused('invalid');
  if (!mayBulkExpect(group)) throw new BulkExpectRefused('blocking');
  const ids = requestedIds(input.verdictIds);
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!note || note.length > NOTE_MAX) throw new BulkExpectRefused('invalid');

  // What the database says now about each requested exception, as the caller may see it (the page's own joins).
  const candidates = await withTenant(ctx, async tx => (Array.from(await tx.execute(sql`
    select v.id, v.disposition, v.resolved_at is not null as resolved, v.superseded_at is not null as superseded,
      coalesce(json_agg(json_build_object('checkId', f.detector_id, 'severity', f.severity, 'facts', f.facts) order by f.id)
        filter (where f.id is not null), '[]'::json) as findings
    from public.payroll_anomaly_verdict v
    join public.employment e on e.id = v.employment_id
    join public.person p on p.id = e.person_id
    join public.payroll_batch b on b.id = v.batch_id
    left join public.payroll_anomaly_finding f on f.verdict_id = v.id
    where v.id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
    group by v.id, v.disposition, v.resolved_at, v.superseded_at`)) as unknown as
    { id: string; disposition: string; resolved: boolean; superseded: boolean; findings: { checkId: string; severity: string; facts: Record<string, unknown> | null }[] }[])
    .map((row): BulkCandidate => ({ verdictId: row.id, disposition: row.disposition, resolved: row.resolved, superseded: row.superseded,
      findings: row.findings.map(f => ({ checkId: f.checkId, severity: f.severity, variant: variantOf(f.checkId, f.facts) })) })));

  const plan = planBulkExpect(group, ids, candidates);
  if (plan.resolve.length === 0) return Object.freeze({ resolved: 0, skipped: plan.skipped.length });
  let results: Awaited<ReturnType<typeof resolveAnomalyVerdicts>>['results'];
  try {
    // ONE call, ONE access lock and ONE transaction for the whole press; per-item authority, audit and ledger stamp.
    ({ results } = await resolveAnomalyVerdicts(ctx, { verdictIds: [...plan.resolve], resolution: 'accepted',
      note: `Expected (marked with its group): ${note}`.slice(0, 500) }));
  } catch (error) {
    // A lock timeout, a lost connection or any other database failure: nothing was written. Never counted as a skip.
    throw new BulkExpectInterrupted(0, error);
  }
  // Per-id outcomes: anything not written now (decided meanwhile, superseded, not the caller's payroll) stays as it is.
  const resolved = results.filter(r => r.outcome === 'resolved').length;
  const skipped = plan.skipped.length + results.length - resolved;
  return Object.freeze({ resolved, skipped });
}
