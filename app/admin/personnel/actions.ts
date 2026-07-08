'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { computeProvisionalEndOn, hireEmployee, resolveProbationMonths } from '@/core/org';
import { setCompensation } from '@/core/comp';
import { listLeaveTypes } from '@/core/read';
import { getPayrollConfig } from '@/core/payroll-config';
import { decideProfileChange } from '@/core/profile';

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';

// Standing entitlements granted on hire (pack-driven, ADR-0008); situational types
// (maternity / paternity / unpaid) are claimed per event, not granted as balances.
const STANDING_GRANTS = new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION']);

export async function hireAction(formData: FormData) {
  const session = await requireAdmin();
  const str = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v || undefined;
  };
  try {
    const types = await listLeaveTypes(session);
    const companyId = String(formData.get('companyId'));
    // Create Initial Basic Salary (feedback 87c82b18, flow #2): the admin is PROMPTED for — and required
    // to supply — the employee's initial basic salary at creation. Validate before hiring so a bad value
    // never creates an employee with no salary. The client also marks the field required.
    const initialBasicSalary = Number(formData.get('initialBasicSalary') ?? '');
    if (!Number.isFinite(initialBasicSalary) || initialBasicSalary <= 0) {
      throw new Error('Initial basic salary is required');
    }
    const employmentType = String(formData.get('employmentType')) as EmploymentType;
    const hiredOn = String(formData.get('hiredOn'));
    const rawEnd = str('provisionalEndOn');
    // Server is the source of truth for the provisional end date (never trust the client to have
    // hidden/derived the right field): part_time → null; full_time → user date or the computed default
    // (company-configured probation months) when blank; contract / intern → the user-entered fixed-term
    // date (or null). getPayrollConfig runs in this admin-gated hire path so RLS reads it fine.
    let provisionalEndOn: string | null;
    if (employmentType === 'part_time') {
      provisionalEndOn = null;
    } else if (employmentType === 'full_time') {
      const cfg = await getPayrollConfig(session, companyId);
      const probationMonths = resolveProbationMonths(cfg?.probationMonths);
      provisionalEndOn = rawEnd ?? computeProvisionalEndOn(hiredOn, 'full_time', probationMonths);
    } else {
      provisionalEndOn = rawEnd ?? null;
    }
    const { employmentId } = await hireEmployee(session, {
      person: {
        fullName: String(formData.get('fullName') ?? '').trim(),
        primaryEmail: String(formData.get('primaryEmail') ?? '').trim(),
      },
      // Employee ID (feedback 38668d9b): HR keys it in. hireEmployee validates format + tenant-uniqueness
      // and surfaces a clear error (caught below → redirect error param) on a bad/duplicate value.
      employeeCode: String(formData.get('employeeCode') ?? '').trim(),
      companyId,
      departmentId: String(formData.get('departmentId')),
      positionId: str('positionId'),
      costCenterId: str('costCenterId'),
      gradeId: str('gradeId') ?? null,
      reportingManagerEmploymentId: str('reportingManagerEmploymentId'),
      employmentType,
      hiredOn,
      provisionalEndOn,
      grantLeaveTypes: types
        .filter((t) => STANDING_GRANTS.has(t.code))
        .map((t) => ({ id: t.id, code: t.code })),
    });
    // Seed the first salary-history record (validated above) with the JOIN DATE as its effective date.
    // The service CLOSEs/INSERTs, appends the compensation.set event, and marks it active — no extra
    // plumbing (feedback 87c82b18, Create Initial Basic Salary flow #2).
    await setCompensation(session, {
      employmentId,
      basicSalary: initialBasicSalary,
      effectiveFrom: hiredOn,
      remarks: str('initialSalaryRemarks'),
    });
  } catch (e) {
    redirect(`/admin/personnel?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/admin/personnel');
  redirect('/admin/personnel?toast=Employee hired');
}

export async function decideProfileChangeAction(formData: FormData) {
  const session = await requireAdmin();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  try {
    await decideProfileChange(session, {
      requestId: String(formData.get('requestId')),
      decision,
    });
  } catch (e) {
    redirect(`/admin/personnel?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/admin/personnel');
  redirect(`/admin/personnel?toast=${encodeURIComponent('Change ' + decision)}`);
}
