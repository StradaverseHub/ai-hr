'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { hireEmployee } from '@/core/org';
import { listLeaveTypes } from '@/core/read';

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';

// Standing entitlements granted on hire (pack-driven, ADR-0008); situational types
// (maternity / paternity / unpaid) are claimed per event, not granted as balances.
const STANDING_GRANTS = new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION']);

export async function hireAction(formData: FormData) {
  const session = await getSession();
  try {
    const types = await listLeaveTypes(session);
    await hireEmployee(session, {
      person: {
        fullName: String(formData.get('fullName') ?? '').trim(),
        primaryEmail: String(formData.get('primaryEmail') ?? '').trim(),
      },
      companyId: String(formData.get('companyId')),
      departmentId: String(formData.get('departmentId')),
      employmentType: String(formData.get('employmentType')) as EmploymentType,
      hiredOn: String(formData.get('hiredOn')),
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
