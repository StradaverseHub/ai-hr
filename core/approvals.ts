/**
 * Shared approval authorization (used by leave + attendance corrections).
 *
 * RLS already controls *visibility* (an employee can read their own rows, a manager
 * their reports', an admin everything), and it makes self rows *writable* — so the
 * decide path must add the policy guard the database can't express:
 *   - no self-approval (super_admin keeps a sole-admin escape hatch for tiny firms);
 *   - only an admin or the subject's *active administrative* manager may decide.
 * Every decision is still evented with the real actor.
 */
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { employment, reportingLine } from '../db/schema';

export async function assertCanDecide(
  tx: Tx,
  ctx: SessionContext,
  subjectEmploymentId: string,
  label: string,
  // R44 delegation (Phase 2): the module/task this decision belongs to. When supplied, a SCOPED delegation
  // only authorises the delegate if it covers this (module, taskType) — a whole-scope (no scope rows)
  // delegation still covers everything. When OMITTED (legacy callers: profile, performance, …) the
  // 1-arg helper runs → whole-scope behaviour, unchanged.
  scope?: { module: string; taskType: string },
): Promise<void> {
  const [subject] = await tx
    .select({ personId: employment.personId })
    .from(employment)
    .where(eq(employment.id, subjectEmploymentId))
    .limit(1);
  const roles = ctx.roles ?? [];
  const isSuperAdmin = roles.includes('super_admin');
  const isAdminRole = isSuperAdmin || roles.includes('hr_admin');
  const isSelf = ctx.personId != null && subject?.personId === ctx.personId;
  // Self-approval ban (task #84) — preserved against the SUBJECT. A delegate who is themselves the
  // subject (or routed into their own approval chain) is still blocked below by this guard, never
  // re-opened by the delegation branch.
  if (isSelf && !isSuperAdmin) throw new Error(`You cannot decide your own ${label}`);
  if (isAdminRole) return;
  const mgr = ctx.personId
    ? await tx
        .select({ id: reportingLine.id })
        .from(reportingLine)
        .innerJoin(employment, eq(employment.id, reportingLine.managerEmploymentId))
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, subjectEmploymentId),
            eq(reportingLine.lineType, 'administrative'),
            // The line must be in its effective window NOW — not future-dated, not ended. Matches
            // currentAdminManager (perf spawn); previously this checked only isNull(validTo), so a
            // not-yet-effective or future-ending line could authorise a decision.
            lte(reportingLine.validFrom, sql`current_date`),
            or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
            isNull(reportingLine.supersededAt),
            eq(employment.personId, ctx.personId),
          ),
        )
        .limit(1)
    : [];
  if (mgr.length > 0) return;

  // Delegation branch (ADR-0052 Step 4): the caller is a valid decider if an ACTIVE `delegate` edge
  // names them as the delegate AND the delegator is the subject's CURRENT direct administrative manager —
  // re-validated at decision time (not merely at create time), window covering current_date, delegator
  // still live, ONE hop only (no transitive chaining). This is encoded once in the SECURITY-DEFINER
  // helper app.can_decide_via_delegation, which we reuse here: the delegate cannot SEE the delegator's
  // employment under RLS (no visibility inheritance), so an in-statement join through `employment` would
  // be wrongly filtered — the definer helper resolves it without leaking visibility. The self-ban above
  // already blocked a delegate who is the subject.
  //
  // R51 (baf56348, migration 0286): ALWAYS the 3-arg overload. NULL module/task = no module filter
  // (byte-identical to the old 1-arg decide behaviour), so the legacy scope-less callers (profile,
  // performance, offboarding, employment review — travel was one until b833a077/r362 removed it) keep
  // their whole-scope semantics — while the new ORG gate
  // inside the function now applies to every decide path through this one chokepoint.
  if (ctx.personId) {
    const res = scope
      ? await tx.execute(
          sql`SELECT app.can_decide_via_delegation(${subjectEmploymentId}, ${scope.module}, ${scope.taskType}) AS ok`,
        )
      : await tx.execute(sql`SELECT app.can_decide_via_delegation(${subjectEmploymentId}, NULL, NULL) AS ok`);
    const ok = (res as unknown as { ok: boolean }[])[0]?.ok;
    if (ok) return;
  }
  throw new Error(`Only an admin or the administrative manager can decide this ${label}`);
}

/**
 * R51 (baf56348) — org-scope filter for the DELEGATE-facing pending lists (leave / attendance corrections /
 * claims). RLS row visibility deliberately stays unchanged (the 1-arg visibility form is untouched — 0230's
 * precedent of authority being narrower than visibility), so a delegation-routed row is still READABLE; this
 * app-level predicate keeps it OUT of the approver's to-do list when the subject sits outside the
 * delegation's org coverage, so the stand-in is never teased with items they cannot act on. Rows the caller
 * can see in their OWN right (self / admin downline / admin role) always pass. The decide-time guard remains
 * the backstop for a raced decide.
 */
export async function filterDelegationOrgScopeTx<T>(
  tx: Tx,
  ctx: SessionContext,
  rows: T[],
  subjectOf: (row: T) => string,
): Promise<T[]> {
  const roles = ctx.roles ?? [];
  if (rows.length === 0 || roles.includes('hr_admin') || roles.includes('super_admin')) return rows;
  const ids = [...new Set(rows.map(subjectOf))];
  // One round trip; each id bound as its own parameter (VALUES list — no array-binding dependency).
  const res = await tx.execute(sql`
    SELECT s.id AS id,
           app.can_see_employment(s.id) AS visible,
           app.can_decide_via_delegation(s.id, NULL, NULL) AS del_ok
    FROM (VALUES ${sql.join(ids.map((i) => sql`(${i}::uuid)`), sql`, `)}) AS s(id)
  `);
  const allowed = new Set(
    (res as unknown as { id: string; visible: boolean; del_ok: boolean }[])
      .filter((r) => r.visible || r.del_ok)
      .map((r) => r.id),
  );
  return rows.filter((r) => allowed.has(subjectOf(r)));
}
