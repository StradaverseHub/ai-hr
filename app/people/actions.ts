'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { computeProvisionalEndOn, hireEmployee, resolveProbationMonths } from '@/core/org';
import { listLeaveTypes } from '@/core/read';
import { getPayrollConfig } from '@/core/payroll-config';
import { decideProfileChange } from '@/core/profile';

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';

// Standing entitlements granted on hire (pack-driven, ADR-0008); situational types
// (maternity / paternity / unpaid) are claimed per event, not granted as balances.
const STANDING_GRANTS = new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION']);

export async function hireAction(formData: FormData) {
  const session = await getSession();
  const str = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v || undefined;
  };
  try {
    const types = await listLeaveTypes(session);
    const companyId = String(formData.get('companyId'));
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
    await hireEmployee(session, {
      person: {
        fullName: String(formData.get('fullName') ?? '').trim(),
        primaryEmail: String(formData.get('primaryEmail') ?? '').trim(),
      },
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
  } catch (e) {
    redirect(`/people?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/people');
  redirect('/people?toast=Employee hired');
}

export async function decideProfileChangeAction(formData: FormData) {
  const session = await getSession();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  try {
    await decideProfileChange(session, {
      requestId: String(formData.get('requestId')),
      decision,
    });
  } catch (e) {
    redirect(`/people?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/people');
  redirect(`/people?toast=${encodeURIComponent('Change ' + decision)}`);
}
