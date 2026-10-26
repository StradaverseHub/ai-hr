import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * ADR-0142 — OneHR administration reads person LABELS through app.onehr_person_labels (0611), never by
 * joining `person`. The projection returns only full name, preferred name and employee code, and only for
 * employments whose company the caller administers for OneHR (app.onehr_admin: HR administrators, perf-comp
 * partners and performance partners alike). `person` RLS is deliberately not widened for the performance
 * partner, because a person row carries date of birth, address, gender and marital status.
 *
 * Each helper is a scalar subquery keyed by an employment id, so a call site swaps `person.fullName` for
 * `onehrLabel.fullName(employment.id)` without changing its row set or result shape. `visible` replaces the
 * row filter the old INNER JOIN on person applied.
 *
 * `labelOrPerson` is for the few readers shared with NON-administrators (a manager assigning a panel): the
 * person row they could already read wins, and the projection only fills in for an administrator who cannot
 * read person. For an HR administrator both sources agree, so the result is unchanged.
 */
type Ref = AnyColumn | SQL;
const call = (employmentId: Ref) => sql`app.onehr_person_labels(array[${employmentId}]::uuid[])`;

export const onehrLabel = {
  fullName: (employmentId: Ref) => sql<string>`(select l.full_name from ${call(employmentId)} l)`,
  preferredName: (employmentId: Ref) => sql<string | null>`(select l.preferred_name from ${call(employmentId)} l)`,
  employeeCode: (employmentId: Ref) => sql<string | null>`(select l.employee_code from ${call(employmentId)} l)`,
  personId: (employmentId: Ref) => sql<string>`(select l.person_id from ${call(employmentId)} l)`,
  visible: (employmentId: Ref) => sql<boolean>`exists(select 1 from ${call(employmentId)} l)`,
  /** Person column the caller can already read, else the administrator projection. */
  labelOrPerson: (personFullName: Ref, employmentId: Ref) =>
    sql<string>`coalesce(${personFullName}, (select l.full_name from ${call(employmentId)} l))`,
  /**
   * A login's name when only its person id is known (actor names, reviewer pickers): the label of any of
   * that person's employments the caller administers for OneHR, lowest employment id first. Null when none.
   * The employments come from app.onehr_employment (VF-07): the partner reads no employment row of others.
   */
  fullNameForPerson: (personId: Ref) =>
    sql<string | null>`(select l.full_name from app.onehr_person_labels(array(select e.id from app.onehr_employment e where e.person_id=${personId} and e.tenant_id=app.current_tenant_id() order by e.id)) l order by l.employment_id limit 1)`,
};
