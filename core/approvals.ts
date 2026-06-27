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
  if (ctx.personId) {
    const res = await tx.execute(sql`SELECT app.can_decide_via_delegation(${subjectEmploymentId}) AS ok`);
    const ok = (res as unknown as { ok: boolean }[])[0]?.ok;
    if (ok) return;
  }
  throw new Error(`Only an admin or the administrative manager can decide this ${label}`);
}
