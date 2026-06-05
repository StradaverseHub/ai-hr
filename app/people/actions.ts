'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { hireEmployee } from '@/core/org';

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';

export async function hireAction(formData: FormData) {
  const session = await getSession();
  try {
    await hireEmployee(session, {
      person: {
        fullName: String(formData.get('fullName') ?? '').trim(),
        primaryEmail: String(formData.get('primaryEmail') ?? '').trim(),
      },
      companyId: String(formData.get('companyId')),
      departmentId: String(formData.get('departmentId')),
      employmentType: String(formData.get('employmentType')) as EmploymentType,
      hiredOn: String(formData.get('hiredOn')),
      annualLeaveTypeId: (formData.get('annualLeaveTypeId') as string) || undefined,
    });
  } catch (e) {
    redirect(`/people?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/people');
  redirect('/people?toast=Employee hired');
}
