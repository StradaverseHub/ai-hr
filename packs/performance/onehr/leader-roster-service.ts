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
import { and, asc, sql } from 'drizzle-orm';
import type { SessionContext } from '../../../db/client';
import { company } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { onehrLabel } from './person-labels';
import { onehrEmployment } from './employment-projection';

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

const live = (from: unknown, to: unknown, day: string) => sql`${from}<=${day}::date and (${to} is null or ${to}>${day}::date)`;

export async function getLeaderRoster(ctx: SessionContext): Promise<LeaderRoster> {
  const today = todayInKualaLumpur();
  return withPerformanceTenant(ctx, async (tx) => {
    const companies = await tx.select({
      id: company.id, name: company.legalName, parentCompanyId: company.parentCompanyId,
      isGroupNode: sql<boolean>`exists(select 1 from company ch where ch.parent_company_id=${company.id} and ch.tenant_id=${company.tenantId})`,
      canWriteBuCeo: sql<boolean>`coalesce(app.onehr_leader_seat_writer('bu_ceo'::text,${company.id}::uuid),false)`,
      canWriteBgCeo: sql<boolean>`coalesce(app.onehr_leader_seat_writer('bg_ceo'::text,${company.id}::uuid),false)`,
    }).from(company).where(sql`app.onehr_admin(${company.id})`).orderBy(asc(company.legalName), asc(company.id));
    const inDepartmentNow = sql`a.employment_id=${onehrEmployment.id} and a.superseded_at is null and ${live(sql`a.valid_from`, sql`a.valid_to`, today)} order by a.valid_from desc, a.id limit 1`;
    const people = await tx.select({
      employmentId: onehrEmployment.id, name: onehrLabel.fullName(onehrEmployment.id), employeeCode: onehrLabel.employeeCode(onehrEmployment.id),
      companyId: onehrEmployment.companyId,
      departmentId: sql<string | null>`(select a.department_id from app.onehr_assignment a where ${inDepartmentNow})`,
      departmentName: sql<string | null>`(select d.name from app.onehr_assignment a left join department d on d.id=a.department_id where ${inDepartmentNow})`,
    }).from(onehrEmployment)
      .where(and(sql`(${onehrEmployment.terminatedOn} is null or ${onehrEmployment.terminatedOn}>${today}::date)`, sql`app.onehr_admin(${onehrEmployment.companyId})`))
      .orderBy(asc(onehrLabel.fullName(onehrEmployment.id)), asc(onehrEmployment.id));
    const [caps] = await tx.execute<{ hod: boolean | null; chief: boolean | null }>(sql`select app.onehr_hod_writer() as hod, app.onehr_leader_seat_writer('group_chief'::text,null::uuid) as chief`);
    return {
      companies: companies.map((c) => ({ ...c, isGroupNode: !!c.isGroupNode, canWriteBuCeo: !!c.canWriteBuCeo, canWriteBgCeo: !!c.canWriteBgCeo })),
      people: people.map((p) => ({ ...p, name: p.name ?? null, employeeCode: p.employeeCode ?? null })),
      canWriteHod: !!caps?.hod, canWriteGroupChief: !!caps?.chief,
    };
  });
}
