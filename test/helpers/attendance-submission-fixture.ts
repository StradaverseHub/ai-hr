/** Explicit test installation setup for suites whose subject is attendance effects, not routing.
 * seedBase itself deliberately remains unconfigured so missing-workflow tests exercise production's
 * fail-closed default. These are real authorised saved workflows, never a production/test bypass.
 */
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled } from '../../core/attendance-workflow';
import { adminCtx, owner, seedBase, type Base } from '../harness';
import { attendanceCorrection } from '../../db/schema';

export async function configureAttendanceSubmissionFixtures(base: Base, companyIds = [base.companyId], applicationTypes: ('irregularity' | 'self_overtime')[] = ['irregularity', 'self_overtime']) {
  const administrator = adminCtx(base);
  for (const companyId of companyIds) {
    for (const applicationType of applicationTypes) {
      await saveAttendanceWorkflow(administrator, {
        companyId,
        code: `FIXTURE_${applicationType.toUpperCase()}`,
        name: 'Explicit fixture manager or HR review',
        description: 'Authorised fixture installation setup, not an automatic submission fallback.',
        applicationType,
        priority: 9000,
        criteria: {},
        stages: [{ name: 'Manager or HR review', level: {
          kind: 'direct_manager', employmentId: null,
          alternates: [{ kind: 'hr_admin', employmentId: null }],
        } }],
        active: true,
      });
      await setAttendanceWorkflowEnabled(administrator, companyId, applicationType, true);
    }
  }
}

export async function seedAttendanceSubmissionBase(): Promise<Base> {
  const base = await seedBase();
  await configureAttendanceSubmissionFixtures(base);
  return base;
}

/** Restore a declared historical record that predates mandatory configured routing. No new-submit
 * service is invoked: production must never recreate the former disabled-workflow fallback. */
export async function restoreHistoricalAttendanceSubmission(base: Base, values: Omit<typeof attendanceCorrection.$inferInsert, 'tenantId'>) {
  const [row] = await owner.db.insert(attendanceCorrection).values({ ...values, tenantId: base.tenantId }).returning();
  return row;
}
