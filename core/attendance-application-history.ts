import type { AttendanceResolvedStage } from '../lib/attendance-workflow';
import { attendanceApplicationReviewTx, attendanceProgressTx, attendanceApproverCodesTx } from './attendance-application-review';
import type { AttendanceProgress } from '../lib/attendance-progress';
/** One scoped read model over attendance_correction; no copied application records. */
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import { withAttendanceTenant as withTenant } from './module-gate';
import { attendanceCorrection as correction, employment, person, company, department, businessUnit, jobGrade, profileOption, domainEvent, appUser, position } from '../db/schema';
import { CATEGORY_EMPLOYMENT_COLUMN, EMPLOYMENT_PROFILE_CATEGORIES } from './profile-options';
import type { AttendanceWorkflowCriteria } from '../lib/attendance-workflow';
import { attendanceWorkflowsForTx, attendanceWorkflowForTx } from './attendance-workflow';

import { attendanceApplicationType, type AttendanceApplicationType } from '../lib/attendance-workflow';
import { todayInKualaLumpur } from '../lib/hr-date';
import { visibleLabelIdsCondition } from './system-labels';
import { checkedAttendanceHistoryFilter, attendanceHistoryId, type AttendanceHistoryFilter } from '../lib/attendance-history-filter';
import { hasGrantFor, withEffectiveGrants } from '../lib/authz-model';
export type { AttendanceHistoryFilter } from '../lib/attendance-history-filter';
export type AttendanceHistoryCounts = { pending:number; approved:number; rejected:number; cancelled:number; withdrawn:number; cancelledWithdrawn:number; all:number };
export const EMPTY_ATTENDANCE_HISTORY_COUNTS: AttendanceHistoryCounts = { pending:0, approved:0, rejected:0, cancelled:0, withdrawn:0, cancelledWithdrawn:0, all:0 };

export type AttendanceHistoryRow = {
    requestKind: string|null;
    selectable: boolean;
    id: string;
    employmentId: string;
    employeeCode: string | null;
    employee: string;
    companyId: string;
    company: string;
    attendanceDate: string;
    submittedAt: Date | string;
    progress?: AttendanceProgress;
    currentParticipantSlot?: string | null;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'withdrawn';
    applicationType: AttendanceApplicationType;
    currentStage: number | null;
    stages: AttendanceResolvedStage[] | null;

    templateName: string | null;
};
function admin(ctx: SessionContext) {
    const effective = withEffectiveGrants(ctx);
    if (!hasGrantFor(effective, 'hr_admin') && !hasGrantFor(effective, 'super_admin'))
        throw new Error('Attendance Application History requires an HR administrator.');
}
const typeSql = sql `CASE WHEN c.request_kind IS NOT NULL THEN CASE WHEN c.request_kind='self_overtime' THEN 'self_overtime' ELSE 'irregularity' END WHEN c.requested_ot_minutes IS NOT NULL AND c.proposed_check_in IS NULL AND c.proposed_check_out IS NULL AND c.clock_changes IS NULL THEN 'self_overtime' ELSE 'irregularity' END`;
const statusSql = sql `CASE WHEN c.status='cancelled' THEN coalesce(c.cancellation_kind,'withdrawn') ELSE c.status::text END`;
export async function listAttendanceApplicationHistory(ctx: SessionContext, companyIds: string[], raw: AttendanceHistoryFilter = {}) {
    admin(ctx);
    const f = checkedAttendanceHistoryFilter(raw);
    return withTenant(ctx, async (tx) => {
        if (!companyIds.length || (f.companyId && !companyIds.includes(f.companyId)))
            return { rows: [] as AttendanceHistoryRow[], total: 0, counts: {...EMPTY_ATTENDANCE_HISTORY_COUNTS}, page: f.page, pageSize: f.pageSize };
        const companies = f.companyId ? [f.companyId] : companyIds;
        const conditions: SQL[] = [sql `e.company_id IN (${sql.join(companies.map(id => sql `${id}::uuid`), sql `,`)})`, sql `app.is_admin_for(e.company_id)`];
        if(f.employmentId)conditions.push(sql`e.id=${f.employmentId}::uuid`);
        if(f.requestKind)conditions.push(f.requestKind==='unknown'?sql`c.request_kind IS NULL`:sql`c.request_kind=${f.requestKind}`);
        if(f.attendanceFrom)conditions.push(sql`c.attendance_date>=${f.attendanceFrom}::date`);
        if(f.attendanceTo)conditions.push(sql`c.attendance_date<=${f.attendanceTo}::date`);
        if (f.applicationType)
            conditions.push(sql `${typeSql}=${f.applicationType}`);
        if (f.submittedFrom)
            conditions.push(sql `(c.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=${f.submittedFrom}::date`);
        if (f.submittedTo)
            conditions.push(sql `(c.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=${f.submittedTo}::date`);
        if (f.gradeId)
            conditions.push(sql `e.grade_id=${f.gradeId}::uuid`);
        if (f.division)
            conditions.push(sql `e.org_division=${f.division}`);
        if (f.departmentId || f.businessUnitId)
            conditions.push(sql `EXISTS(SELECT 1 FROM assignment a LEFT JOIN department d ON d.id=a.department_id WHERE a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=${todayInKualaLumpur()}::date AND (a.valid_to IS NULL OR a.valid_to>${todayInKualaLumpur()}::date) ${f.departmentId ? sql `AND a.department_id=${f.departmentId}::uuid` : sql ``} ${f.businessUnitId ? sql `AND coalesce(a.business_unit_id,d.business_unit_id)=${f.businessUnitId}::uuid` : sql ``})`);
        if (f.query?.trim()) {
            const q = '%' + f.query.trim().replace(/[\\%_]/g, c => '\\' + c) + '%';
            conditions.push(sql `(p.full_name ILIKE ${q} OR e.employee_code ILIKE ${q} OR c.id::text ILIKE ${q})`);
        }
        const from = sql `FROM attendance_correction c JOIN employment e ON e.id=c.employment_id JOIN person p ON p.id=e.person_id JOIN company co ON co.id=e.company_id LEFT JOIN attendance_workflow_request w ON w.correction_id=c.id WHERE ${sql.join(conditions, sql ` AND `)}`;
        // Counts and page rows are selected from ONE authorized/filter-bound snapshot. Status alone
        // is excluded from the tab counts; employee/company/search/date predicates are identical.
        const statusCondition = !f.status || f.status === 'all' ? sql`true`
            : f.status === 'cancelled_withdrawn' ? sql`status in ('cancelled','withdrawn')` : sql`status=${f.status}`;
        const [result] = await tx.execute(sql`WITH filtered AS MATERIALIZED (
          SELECT c.request_kind AS "requestKind",(c.status='pending' AND p.id IS DISTINCT FROM ${ctx.personId??null}::uuid) AS selectable,
            c.id,c.employment_id AS "employmentId",e.employee_code AS "employeeCode",p.full_name AS employee,
            e.company_id AS "companyId",co.legal_name AS company,c.attendance_date AS "attendanceDate",c.created_at AS "submittedAt",
            ${statusSql} AS status,${typeSql} AS "applicationType",w.current_stage AS "currentStage",w.stages,w.template_name AS "templateName" ${from}
        ), counted AS (
          SELECT count(*) FILTER(WHERE ${statusCondition})::int AS total,
            jsonb_build_object('pending',count(*) FILTER(WHERE status='pending'),'approved',count(*) FILTER(WHERE status='approved'),
              'rejected',count(*) FILTER(WHERE status='rejected'),'cancelled',count(*) FILTER(WHERE status='cancelled'),
              'withdrawn',count(*) FILTER(WHERE status='withdrawn'),'cancelledWithdrawn',count(*) FILTER(WHERE status IN ('cancelled','withdrawn')),'all',count(*)) AS counts
          FROM filtered
        ), selected AS (
          SELECT * FROM filtered WHERE ${statusCondition} ORDER BY "submittedAt" DESC,id DESC LIMIT ${f.pageSize} OFFSET ${(f.page-1)*f.pageSize}
        ) SELECT counted.*,coalesce((SELECT jsonb_agg(to_jsonb(selected) ORDER BY "submittedAt" DESC,id DESC) FROM selected),'[]'::jsonb) AS rows FROM counted`) as unknown as {total:number;counts:AttendanceHistoryCounts;rows:AttendanceHistoryRow[]}[];
        const rows=result?.rows??[];
        const workflows=await attendanceWorkflowsForTx(tx,rows.map(row=>row.id));
        for(const row of rows){
          const flow=workflows.get(row.id)??null;
          row.stages=flow?.effectiveStages??flow?.stages??null;
          row.progress=await attendanceProgressTx(tx,flow,row.status);
          row.currentParticipantSlot=flow?.currentParticipantSlot??null;
          if(row.selectable&&flow?.routingVersion===2){
            const [authority]=await tx.execute(sql`select app.attendance_workflow_v2_decide(${row.id}::uuid) as ok`) as unknown as {ok:boolean}[];
            row.selectable=authority?.ok===true;
          }else if(row.selectable&&flow?.routingVersion===3)row.selectable=row.currentParticipantSlot!=null;
        }
        return {rows,total:result?.total??0,counts:result?.counts??{...EMPTY_ATTENDANCE_HISTORY_COUNTS},page:f.page,pageSize:f.pageSize};

    });
}
export async function attendanceApplicationDetail(ctx: SessionContext, companyIds: string[], id: string) {
    admin(ctx);
    if (!attendanceHistoryId(id))
        return null;
    return withTenant(ctx, async (tx) => {
        if (!companyIds.length)
            return null;
        const [row] = await tx.select({ application: correction, employee: person.fullName, personId: employment.personId, employeeCode: employment.employeeCode, company: company.legalName, companyId: employment.companyId, hasAttachment: sql<boolean> `exists(select 1 from attendance_correction_attachment f where f.attendance_correction_id=${correction.id})`, allowed: sql<boolean> `app.is_admin_for(${employment.companyId})` }).from(correction).innerJoin(employment, eq(employment.id, correction.employmentId)).innerJoin(person, eq(person.id, employment.personId)).innerJoin(company, eq(company.id, employment.companyId)).where(and(eq(correction.id, id), inArray(employment.companyId, companyIds))).limit(1);
        if (!row?.allowed)
            return null;
        const workflow = await attendanceWorkflowForTx(tx, id);
        const events = await tx.select({ id: domainEvent.id, eventType: domainEvent.eventType, actorId: domainEvent.actorId, actorType: domainEvent.actorType, actorName: person.fullName, occurredAt: domainEvent.occurredAt, payload: domainEvent.payload }).from(domainEvent).leftJoin(appUser, eq(appUser.id, domainEvent.actorId)).leftJoin(person, eq(person.id, appUser.personId)).where(and(eq(domainEvent.subjectEmploymentId, row.application.employmentId), sql `(${domainEvent.aggregateId}=${id} OR (${domainEvent.payload}->>'correctionId')=${id})`)).orderBy(asc(domainEvent.occurredAt), asc(domainEvent.sequence), asc(domainEvent.id));
        const self = !!ctx.personId && ctx.personId === row.personId;
        const [v2Authority] = workflow?.routingVersion === 3 ? [{ ok: workflow.currentParticipantSlot != null }] : workflow?.routingVersion === 2 ? await tx.execute(sql`select app.attendance_workflow_v2_decide(${id}::uuid) as ok`) as unknown as { ok: boolean }[] : [];
        const review=await attendanceApplicationReviewTx(tx,{employmentId:row.application.employmentId,date:row.application.attendanceDate});
        const progress=await attendanceProgressTx(tx,workflow,row.application.status);
        const approverCodes=await attendanceApproverCodesTx(tx,[...([...(workflow?.stages??[]),...(workflow?.effectiveStages??[])].flatMap(stage=>stage.approvers.flatMap(actor=>actor.employmentId?[actor.employmentId]:[]))),...([...(workflow?.decisions??[]),...(workflow?.participantDecisions??[])].flatMap(record=>record.actualEmploymentId?[record.actualEmploymentId]:[]))]);
        return { ...row, applicationType: attendanceApplicationType(row.application), workflow, events, review, progress, approverCodes, canReassign: !self && row.application.status === 'pending' && (workflow?.routingVersion === 2 || workflow?.routingVersion === 3) && workflow.currentStage < workflow.stages.length, canDecide: !self && row.application.status === 'pending' && ((workflow?.routingVersion !== 2 && workflow?.routingVersion !== 3) || v2Authority?.ok === true), canCancel: !self && (row.application.status === 'pending' || row.application.status === 'approved') };
    });
}
export function attendanceApplicationFilterOptions(ctx: SessionContext, companyIds: string[]) {
    admin(ctx);
    return withTenant(ctx, async (tx) => {
        if (!companyIds.length)
            return { companies: [], departments: [], businessUnits: [], grades: [], divisions: [], employees: [], positions: [], profileFields: {} };
        const companies = await tx.select({ id: company.id, name: company.legalName }).from(company).where(and(inArray(company.id, companyIds), sql `app.is_admin_for(${company.id})`)).orderBy(asc(company.legalName));
        if (!companies.length)
            return { companies: [], departments: [], businessUnits: [], grades: [], divisions: [], employees: [], positions: [], profileFields: {} };
        const departments = await tx.select({ id: department.id, name: department.name }).from(department).where(and(isNull(department.archivedAt), visibleLabelIdsCondition(department, 'department', companies.map(c => c.id)))).orderBy(asc(department.name));
        const businessUnits = await tx.select({ id: businessUnit.id, name: businessUnit.name }).from(businessUnit).where(and(isNull(businessUnit.archivedAt), visibleLabelIdsCondition(businessUnit, 'business_unit', companies.map(c => c.id)))).orderBy(asc(businessUnit.name));
        const grades = await tx.select({ id: jobGrade.id, name: jobGrade.name }).from(jobGrade).where(isNull(jobGrade.archivedAt)).orderBy(asc(jobGrade.rank), asc(jobGrade.name));
        const divisions = await tx.select({ id: profileOption.value, name: profileOption.label }).from(profileOption).where(and(eq(profileOption.category, 'division'), eq(profileOption.isActive, true))).orderBy(asc(profileOption.sortOrder), asc(profileOption.label));
        const positions = await tx.select({ id: position.id, name: position.title }).from(position).where(and(isNull(position.archivedAt), visibleLabelIdsCondition(position, 'position', companies.map(c => c.id)))).orderBy(asc(position.title), asc(position.id));
        const profileOptions = await tx.select({ category: profileOption.category, id: profileOption.value, name: profileOption.label }).from(profileOption).where(and(inArray(profileOption.category, [...EMPLOYMENT_PROFILE_CATEGORIES]), eq(profileOption.isActive, true))).orderBy(asc(profileOption.sortOrder), asc(profileOption.label), asc(profileOption.id));
        const profileFields: Partial<Record<keyof AttendanceWorkflowCriteria, { id: string; name: string }[]>> = {};
        for (const option of profileOptions) {
            const category=EMPLOYMENT_PROFILE_CATEGORIES.find(value=>value===option.category);
            if(!category)continue;
            const field=CATEGORY_EMPLOYMENT_COLUMN[category]?.[0];
            if(!field)continue;
            const key=field as keyof AttendanceWorkflowCriteria;
            const values = profileFields[key] ?? []; values.push({ id: option.id, name: option.name }); profileFields[key] = values;
        }
        const employees=await tx.select({id:employment.id,name:person.fullName,employeeCode:employment.employeeCode}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(inArray(employment.companyId,companies.map(c=>c.id))).orderBy(asc(person.fullName),asc(employment.id));
        const approverEmployees = await tx.execute(sql`select id,name,employee_code as "employeeCode" from app.attendance_workflow_v3_approver_options(ARRAY[${sql.join(companies.map(row => sql`${row.id}::uuid`), sql`, `)}]::uuid[])`) as unknown as { id: string; name: string; employeeCode: string | null }[];
        return { companies, departments, businessUnits, grades, divisions, employees, approverEmployees, positions, profileFields };
    });
}
