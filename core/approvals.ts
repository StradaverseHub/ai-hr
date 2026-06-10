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
import { and, eq, isNull } from 'drizzle-orm';
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
            isNull(reportingLine.validTo),
            isNull(reportingLine.supersededAt),
            eq(employment.personId, ctx.personId),
          ),
        )
        .limit(1)
    : [];
  if (mgr.length === 0) {
    throw new Error(`Only an admin or the administrative manager can decide this ${label}`);
  }
}
