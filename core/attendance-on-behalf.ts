/**
 * Board 96a54ed2 — Request On Behalf and Approve On Behalf for Attendance Irregularity and Self Overtime.
 *
 * WHO MAY ACT FOR WHOM (one decision, used by every screen and action):
 *   - the caller holds `attendance.request_on_behalf` / `attendance.approve_on_behalf` (lib/payroll-permissions.ts;
 *     company-scoped override rows win over tenant rows, which win over the defaults hr_admin, super_admin, manager);
 *   - the chosen employee is someone else, active, visible to the caller, and either in a company the caller
 *     administers as HR or beneath one of the caller's own employments in the administrative reporting line.
 *     A superior never acts for their own manager, a peer or another team.
 * The existing request screens and the one Attendance engine do the rest: filing goes through
 * requestAttendanceCorrection for the employee (their workflow, Schedule Group and rules), and deciding goes through
 * decideAttendanceCorrection with acting_mode on_behalf, re-proved by app.attendance_workflow_on_behalf_slot.
 *
 * Reads are single set-based statements over bounded pages; nothing here loops per company or per employee in SQL.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { requestAttendanceCorrection, type AttendanceCorrectionRequestInput } from './attendance';
import { submissionRouteForSubjectTx, AttendanceWorkflowError, type AttendanceApplicationType } from './attendance-workflow';
import { ATTENDANCE_ON_BEHALF_KEYS as KEYS, permittedCompaniesTx, type AttendanceOnBehalfPurpose } from './attendance-on-behalf-permission';
export { canApproveOnBehalfForCompanyTx, type AttendanceOnBehalfPurpose } from './attendance-on-behalf-permission';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const ATTENDANCE_ON_BEHALF_PAGE_SIZE = 25;

export class AttendanceOnBehalfError extends Error {
  constructor(public readonly code: 'notAllowed' | 'invalid') { super(code === 'notAllowed' ? 'You may not act on behalf of this employee.' : 'Choose a valid employee.'); this.name = 'AttendanceOnBehalfError'; }
}
export type AttendanceOnBehalfSubject = { employmentId: string; name: string; employeeCode: string | null; companyId: string; company: string; department: string | null; position: string | null };

/** Does the caller hold the key anywhere (menus and the first screen only; every action re-checks the subject). */
export function canActOnBehalf(ctx: SessionContext, purpose: AttendanceOnBehalfPurpose) {
  if (!ctx.userId || !ctx.personId) return Promise.resolve(false);
  return withTenant(ctx, async tx => (await permittedCompaniesTx(tx, ctx, purpose)).length > 0, { readOnlySnapshot: true });
}

/** The caller's administrative downline, once, set-based: mirrors app.is_admin_report_of (company-clamped, active). */
const downline = (personId: string) => sql`with recursive me as (
    select e.id,e.company_id from employment e where e.person_id=${personId}::uuid and e.tenant_id=app.current_tenant_id() and e.terminated_on is null
  ), down as (
    select l.subordinate_employment_id as id,me.company_id as root from reporting_line l join me on me.id=l.manager_employment_id
     join employment sub on sub.id=l.subordinate_employment_id
     where l.tenant_id=app.current_tenant_id() and l.line_type='administrative' and l.superseded_at is null and l.valid_from<=current_date and (l.valid_to is null or l.valid_to>current_date)
      and sub.terminated_on is null and app.is_company_descendant(sub.company_id,me.company_id)
    union
    select l.subordinate_employment_id,d.root from reporting_line l join down d on d.id=l.manager_employment_id
     join employment sub on sub.id=l.subordinate_employment_id
     where l.tenant_id=app.current_tenant_id() and l.line_type='administrative' and l.superseded_at is null and l.valid_from<=current_date and (l.valid_to is null or l.valid_to>current_date)
      and sub.terminated_on is null and app.is_company_descendant(sub.company_id,d.root)
  ) select distinct id from down`;

/** One page of employees the caller may act for, searched by Employee ID or name. */
export async function searchAttendanceOnBehalfSubjects(ctx: SessionContext, input: { purpose: AttendanceOnBehalfPurpose; query: string; page: number }) {
  if (!ctx.userId || !ctx.personId) return { rows: [] as AttendanceOnBehalfSubject[], more: false };
  if (typeof input.query !== 'string' || input.query.length > 100 || !Number.isInteger(input.page) || input.page < 0 || input.page > 400) throw new AttendanceOnBehalfError('invalid');
  const personId = ctx.personId;
  return withTenant(ctx, async tx => {
    const companies = await permittedCompaniesTx(tx, ctx, input.purpose);
    if (!companies.length) return { rows: [] as AttendanceOnBehalfSubject[], more: false };
    const pattern = '%' + input.query.trim().replace(/[\\%_]/g, '\\$&') + '%';
    const rows = await tx.execute<AttendanceOnBehalfSubject>(sql`with mine as (${downline(personId)})
      select e.id as "employmentId",p.full_name as name,e.employee_code as "employeeCode",e.company_id as "companyId",c.legal_name as company,d.name as department,pos.title as position
      from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id
      left join assignment a on a.employment_id=e.id and a.valid_to is null and a.superseded_at is null
      left join department d on d.id=a.department_id left join position pos on pos.id=a.position_id
      where e.tenant_id=app.current_tenant_id() and e.person_id<>${personId}::uuid and e.company_id=any(ARRAY[${sql.join(companies.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[])
       and e.hired_on<=(now() at time zone 'Asia/Kuala_Lumpur')::date and e.blacklisted_at is null and (e.terminated_on is null or e.terminated_on>(now() at time zone 'Asia/Kuala_Lumpur')::date)
       and (app.is_admin_for(e.company_id) or e.id in (select id from mine))
       and (p.full_name ilike ${pattern} or e.employee_code ilike ${pattern})
      order by e.employee_code nulls last,p.full_name,e.id limit ${ATTENDANCE_ON_BEHALF_PAGE_SIZE + 1} offset ${input.page * ATTENDANCE_ON_BEHALF_PAGE_SIZE}`);
    return { rows: rows.slice(0, ATTENDANCE_ON_BEHALF_PAGE_SIZE), more: rows.length > ATTENDANCE_ON_BEHALF_PAGE_SIZE };
  }, { readOnlySnapshot: true });
}

/** The one authorization question for a chosen employee, inside the caller's transaction. */
export async function attendanceOnBehalfSubjectTx(tx: Tx, ctx: SessionContext, purpose: AttendanceOnBehalfPurpose, employmentId: string): Promise<AttendanceOnBehalfSubject | null> {
  if (!ctx.userId || !ctx.personId || typeof employmentId !== 'string' || !UUID.test(employmentId)) return null;
  const companies = await permittedCompaniesTx(tx, ctx, purpose);
  const [row] = await tx.execute<AttendanceOnBehalfSubject & { hr: boolean; downline: boolean }>(sql`select e.id as "employmentId",p.full_name as name,e.employee_code as "employeeCode",e.company_id as "companyId",c.legal_name as company,d.name as department,pos.title as position,
      app.is_admin_for(e.company_id) as hr,
      exists(select 1 from employment me where me.person_id=${ctx.personId}::uuid and me.tenant_id=e.tenant_id and me.terminated_on is null and app.is_admin_report_of(e.id,me.id)) as downline
     from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id
     left join assignment a on a.employment_id=e.id and a.valid_to is null and a.superseded_at is null
     left join department d on d.id=a.department_id left join position pos on pos.id=a.position_id
     where e.id=${employmentId}::uuid and e.tenant_id=app.current_tenant_id() and e.person_id<>${ctx.personId}::uuid and app.can_see_employment(e.id)
      and e.hired_on<=(now() at time zone 'Asia/Kuala_Lumpur')::date and e.blacklisted_at is null and (e.terminated_on is null or e.terminated_on>(now() at time zone 'Asia/Kuala_Lumpur')::date)`);
  if (!row || !companies.includes(row.companyId) || !(row.hr || row.downline)) return null;
  const { hr: _hr, downline: _downline, ...subject } = row;
  return subject;
}
export function attendanceOnBehalfSubject(ctx: SessionContext, purpose: AttendanceOnBehalfPurpose, employmentId: string) {
  return withTenant(ctx, tx => attendanceOnBehalfSubjectTx(tx, ctx, purpose, employmentId), { readOnlySnapshot: true });
}

/** The route the chosen employee's application would take (their workflow, never the submitter's). */
export function attendanceSubmissionRouteOnBehalf(ctx: SessionContext, employmentId: string, applicationType: AttendanceApplicationType) {
  return withTenant(ctx, async tx => {
    const subject = await attendanceOnBehalfSubjectTx(tx, ctx, 'request', employmentId);
    if (!subject) throw new AttendanceWorkflowError('scope', 'The employee is not visible.');
    return submissionRouteForSubjectTx(tx, ctx, { companyId: subject.companyId }, subject.employmentId, applicationType);
  }, { readOnlySnapshot: true });
}

/**
 * File an application for the chosen employee through the unchanged Attendance owner. The database stamps the live
 * caller as the submitter only for this authorised employment in this transaction; the routing, Schedule Group and
 * rules are the employee's own. One pending application per day stays the owner's duplicate guard.
 */
export async function requestAttendanceCorrectionOnBehalf(ctx: SessionContext, input: AttendanceCorrectionRequestInput) {
  if (!ctx.userId || !ctx.personId) throw new AttendanceOnBehalfError('notAllowed');
  return withTenant(ctx, async tx => {
    const subject = await attendanceOnBehalfSubjectTx(tx, ctx, 'request', input.employmentId);
    if (!subject) throw new AttendanceOnBehalfError('notAllowed');
    await tx.execute(sql`select set_config('app.attendance_on_behalf_submission',${subject.employmentId + ':' + ctx.userId},true)`);
    const result = await requestAttendanceCorrection(ctx, { ...input, employmentId: subject.employmentId }, tx);
    await tx.execute(sql`select set_config('app.attendance_on_behalf_submission','',true)`);
    return result;
  });
}

/** Approve On Behalf: pending applications whose current level waits for this designated employee and that the
 *  caller may decide for them. A containment pre-filter on the current level narrows to that approver's work before
 *  the per-application authority proof; the page is bounded. */
export async function attendanceOnBehalfApprovals(ctx: SessionContext, designatedEmploymentId: string, page = 0) {
  if (!Number.isInteger(page) || page < 0 || page > 400) throw new AttendanceOnBehalfError('invalid');
  return withTenant(ctx, async tx => {
    const designated = await attendanceOnBehalfSubjectTx(tx, ctx, 'approve', designatedEmploymentId);
    if (!designated) return null;
    // Narrowed to applications waiting at their current level for this designated approver (containment on the frozen
    // level), authorised in the same statement, then paged: no fixed candidate cap ahead of the authority filter.
    const rows = await tx.execute<{ correctionId: string; slot: string; stageIndex: number }>(sql`select x.correction_id as "correctionId",x.authority->>'slot' as slot,x.current_stage as "stageIndex" from (
      select w.correction_id,w.current_stage,c.created_at,app.attendance_workflow_on_behalf_slot(w.correction_id,${designated.employmentId}::uuid) as authority
      from attendance_workflow_request w join attendance_correction c on c.id=w.correction_id and c.tenant_id=w.tenant_id
      where w.tenant_id=app.current_tenant_id() and w.routing_version in (3,4) and c.status='pending'
       and w.current_stage<jsonb_array_length(w.stages) and w.stages->w.current_stage->'approvers' @> ${JSON.stringify([{ employmentId: designated.employmentId }])}::jsonb
      ) x where x.authority is not null order by x.created_at,x.correction_id
      limit ${ATTENDANCE_ON_BEHALF_PAGE_SIZE + 1} offset ${page * ATTENDANCE_ON_BEHALF_PAGE_SIZE}`);
    return { designated, rows: rows.slice(0, ATTENDANCE_ON_BEHALF_PAGE_SIZE), more: rows.length > ATTENDANCE_ON_BEHALF_PAGE_SIZE };
  }, { readOnlySnapshot: true });
}

export { KEYS as ATTENDANCE_ON_BEHALF_KEYS };
