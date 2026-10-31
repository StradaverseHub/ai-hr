import type { SessionContext } from '@/db/client';
import { auditEvents } from '@/core/read';

/**
 * 6d091cc0 (r301) — "Last updated" on the Company Policy Settings card.
 *
 * ── THERE IS NO updated_at COLUMN, SO THIS READS THE AUDIT LEDGER ──────────────────────────────────────────
 * `attendance_policy` has no timestamp of its own. What it has is `setAttendancePolicy` (core/attendance.ts),
 * the table's ONLY writer outside provisioning, which appends `attendance-policy.updated` with the company in
 * its payload on every save — and has since the table's first commit (4058b9ec). So the latest of those events
 * for a company IS when its setting was last changed. No second source of truth, no new column: a reader over
 * the ledger through the EXISTING `auditEvents` read, with the same filter the Audit Trail screen uses.
 *
 * ── WHO CAN READ IT (verified, not assumed — test/r301-schedule-general.test.ts) ───────────────────────────
 * domain_event's read policy (migration 0037) is `app.is_admin() OR <subject employment visible>`, and these
 * events have NO subject employment. `app.is_admin()` is true for ANY hr_admin or super_admin grant, group-wide
 * or company-scoped — the same people requireAdmin() lets onto the Schedule screen. Anyone else reads nothing,
 * which is fail-closed, and the screen is admin-only anyway.
 *
 * ── WHAT A MISSING EVENT MEANS ─────────────────────────────────────────────────────────────────────────────
 * A company can have a SAVED row and no event: provisioning (db/provision.ts seedCompanyCatalogs) inserts the
 * starter row directly. The card must not read "never changed" off an absence, and it must not print a dash
 * as if the date were known to be empty — it says no change is recorded. The Map simply has no entry.
 *
 * One read per company, each `limit 1`, newest first by `occurred_at` then `sequence` (auditEvents' own
 * ORDER BY). A tenant has a handful of companies; the admin predicate is a constant (see migration 0455).
 */
export async function policyLastUpdated(ctx: SessionContext, companyIds: readonly string[]): Promise<Map<string, Date>> {
  const rows = await Promise.all(
    companyIds.map(async (companyId) => {
      const [latest] = await auditEvents(ctx, {
        aggregateType: 'attendance-policy',
        action: 'updated',
        companyId,
        limit: 1,
      });
      return [companyId, latest?.occurredAt ?? null] as const;
    }),
  );
  const out = new Map<string, Date>();
  for (const [companyId, at] of rows) if (at) out.set(companyId, at);
  return out;
}
