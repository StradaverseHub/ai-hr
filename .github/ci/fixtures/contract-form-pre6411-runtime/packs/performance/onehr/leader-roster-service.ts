/**
 * WP-B2 — the read the Leaders screen needs beside the seat registry: the people the viewer administers
 * (with company and current department, for the "By department" view, the unit head counts and the person
 * search), the companies they administer, and what the viewer may write.
 *
 * Read-only. The write capabilities are the database's own authority functions from migration 0663
 * (app.onehr_hod_writer, app.onehr_leader_seat_writer) evaluated for this viewer, so the screen shows a write
 * control exactly when the writer would accept it. They are a display hint only: every write still goes
 * through leader-seat-service, which re-checks the same functions, and RLS is the backstop.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { SessionContext } from '../../../db/client';
import { company, department } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { onehrLabel } from './person-labels';
import { onehrAssignment, onehrEmployment } from './employment-projection';

export type LeaderRosterPerson = {
  employmentId: string; name: string | null; employeeCode: string | null;
  companyId: string; departmentId: string | null; departmentName: string | null;
};
export type LeaderRosterCompany = {
  id: string; name: string; parentCompanyId: string | null;
  /** Has units below it: the anchor of a business group CEO seat. */
  isGroupNode: boolean;
  canWriteBuCeo: boolean; canWriteBgCeo: boolean;
};
export type LeaderRoster = {
  people: LeaderRosterPerson[]; companies: LeaderRosterCompany[];
  /** HOD changes and calibration groups (create, rename, members). */
  canWriteHod: boolean;
  canWriteGroupChief: boolean;
};

export async function getLeaderRoster(ctx: SessionContext): Promise<LeaderRoster> {
  const today = todayInKualaLumpur();
  return withPerformanceTenant(ctx, async (tx) => {
    // No correlated subqueries over a single-table selection here: drizzle renders a column inside an `sql`
    // field of such a selection without its table prefix, so `${company.id}` inside `from company ch` would bind
    // to ch.id (the defect 246ad871b fixed in leader-seat-service). The writer-function arguments below have no
    // inner FROM, so the bare column can only mean this row's.
    const companyRows = await tx.select({
      id: company.id, name: company.legalName, parentCompanyId: company.parentCompanyId,
      administered: sql<boolean>`coalesce(app.onehr_admin(${company.id}),false)`,
      canWriteBuCeo: sql<boolean>`coalesce(app.onehr_leader_seat_writer('bu_ceo'::text,${company.id}::uuid),false)`,
      canWriteBgCeo: sql<boolean>`coalesce(app.onehr_leader_seat_writer('bg_ceo'::text,${company.id}::uuid),false)`,
    }).from(company).orderBy(asc(company.legalName), asc(company.id));
    // A business group node is a company some other company names as its parent.
    const nodes = new Set(companyRows.map((c) => c.parentCompanyId).filter((id): id is string => !!id));
    const companies = companyRows.filter((c) => c.administered).map(({ administered: _administered, ...c }) => ({
      ...c, isGroupNode: nodes.has(c.id), canWriteBuCeo: !!c.canWriteBuCeo, canWriteBgCeo: !!c.canWriteBgCeo,
    }));
    const people = await tx.select({
      employmentId: onehrEmployment.id, name: onehrLabel.fullName(onehrEmployment.id), employeeCode: onehrLabel.employeeCode(onehrEmployment.id),
      companyId: onehrEmployment.companyId,
    }).from(onehrEmployment)
      .where(and(sql`(${onehrEmployment.terminatedOn} is null or ${onehrEmployment.terminatedOn}>${today}::date)`, sql`app.onehr_admin(${onehrEmployment.companyId})`))
      .orderBy(asc(onehrLabel.fullName(onehrEmployment.id)), asc(onehrEmployment.id));
    // Today's assignment per person, in its own (two-table, so fully qualified) query; latest start wins.
    const assignments = people.length ? await tx.select({
      employmentId: onehrAssignment.employmentId, departmentId: onehrAssignment.departmentId, departmentName: department.name,
    }).from(onehrAssignment).leftJoin(department, eq(department.id, onehrAssignment.departmentId))
      .where(and(inArray(onehrAssignment.employmentId, people.map((p) => p.employmentId)), isNull(onehrAssignment.supersededAt),
        lte(onehrAssignment.validFrom, today), or(isNull(onehrAssignment.validTo), gt(onehrAssignment.validTo, today))))
      .orderBy(asc(onehrAssignment.employmentId), desc(onehrAssignment.validFrom), asc(onehrAssignment.id)) : [];
    const currentOf = new Map<string, { departmentId: string; departmentName: string | null }>();
    for (const a of assignments) if (!currentOf.has(a.employmentId)) currentOf.set(a.employmentId, { departmentId: a.departmentId, departmentName: a.departmentName ?? null });
    const [caps] = await tx.execute<{ hod: boolean | null; chief: boolean | null }>(sql`select app.onehr_hod_writer() as hod, app.onehr_leader_seat_writer('group_chief'::text,null::uuid) as chief`);
    return {
      companies,
      people: people.map((p) => ({ ...p, name: p.name ?? null, employeeCode: p.employeeCode ?? null, departmentId: currentOf.get(p.employmentId)?.departmentId ?? null, departmentName: currentOf.get(p.employmentId)?.departmentName ?? null })),
      canWriteHod: !!caps?.hod, canWriteGroupChief: !!caps?.chief,
    };
  });
}
