import 'server-only';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withAttendanceTenant } from '@/core/module-gate';
import { CATEGORY_EMPLOYMENT_COLUMN, EMPLOYMENT_PROFILE_CATEGORIES } from '@/core/profile-options';
import { visibleLabelIdsCondition } from '@/core/system-labels';
import type { SessionContext } from '@/db/client';
import { businessUnit, company, department, employment, jobGrade, person, position, profileOption } from '@/db/schema';
import { hasGrantFor, withEffectiveGrants } from '@/lib/authz-model';
import type { WorkflowAssignmentField, WorkflowAssignmentOption } from './assignment-field';
import { selectWorkflowCompanyLabels } from './company-labels';

/** A single editor picker uses the existing Attendance and Organisation scope rules. */
export async function readWorkflowAssignmentOptions(
  session: SessionContext, companyIds: string[], field: WorkflowAssignmentField,
): Promise<WorkflowAssignmentOption[]> {
  const effective = withEffectiveGrants(session);
  if (!hasGrantFor(effective, 'hr_admin') && !hasGrantFor(effective, 'super_admin')) {
    throw new Error('Attendance workflow options require an HR administrator.');
  }
  return withAttendanceTenant(session, async tx => {
    if (!companyIds.length) return [];
    const authorised = (await selectWorkflowCompanyLabels(tx, companyIds)).map(row => row.id);
    if (!authorised.length) return [];
    switch (field) {
      case 'departmentIds':
        return tx.select({ id: department.id, name: department.name }).from(department)
          .where(and(isNull(department.archivedAt), visibleLabelIdsCondition(department, 'department', authorised)))
          .orderBy(asc(department.name));
      case 'businessUnitIds':
        return tx.select({ id: businessUnit.id, name: businessUnit.name }).from(businessUnit)
          .where(and(isNull(businessUnit.archivedAt), visibleLabelIdsCondition(businessUnit, 'business_unit', authorised)))
          .orderBy(asc(businessUnit.name));
      case 'gradeIds':
        return tx.select({ id: jobGrade.id, name: jobGrade.name }).from(jobGrade)
          .where(isNull(jobGrade.archivedAt)).orderBy(asc(jobGrade.rank), asc(jobGrade.name));
      case 'positionIds':
        return tx.select({ id: position.id, name: position.title }).from(position)
          .where(and(isNull(position.archivedAt), visibleLabelIdsCondition(position, 'position', authorised)))
          .orderBy(asc(position.title), asc(position.id));
      case 'employeeIds': {
        const rows = await tx.select({ id: employment.id, name: person.fullName, code: employment.employeeCode })
          .from(employment).innerJoin(person, eq(person.id, employment.personId))
          .innerJoin(company, eq(company.id, employment.companyId))
          .where(and(inArray(employment.companyId, authorised), sql`app.is_admin_for(${employment.companyId})`))
          .orderBy(asc(person.fullName), asc(employment.id));
        return rows.map(({ id, name, code }) => ({ id, name: code ? `${code} · ${name}` : name }));
      }
      default: {
        const category = EMPLOYMENT_PROFILE_CATEGORIES.find(value => CATEGORY_EMPLOYMENT_COLUMN[value]?.[0] === field);
        if (!category) return [];
        return tx.select({ id: profileOption.value, name: profileOption.label }).from(profileOption)
          .where(and(eq(profileOption.category, category), eq(profileOption.isActive, true)))
          .orderBy(asc(profileOption.sortOrder), asc(profileOption.label), asc(profileOption.id));
      }
    }
  }, { readOnlySnapshot: true });
}
