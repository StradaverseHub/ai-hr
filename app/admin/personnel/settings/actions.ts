'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setHiringDefaults } from '@/core/hiring-defaults';

const PAGE = '/admin/personnel/settings';

/**
 * Save one company's hiring defaults (r79a, 4fb8b75a step 3).
 *
 * requireAdmin here mirrors the rest of the personnel-admin surface; RLS on `company` is the real backstop.
 * Both fields clamp to NULL when blank/invalid inside the service, which restores the built-in default
 * (3 months / [30, 14, 7]) rather than storing a broken value.
 */
export async function saveHiringDefaultsAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await setHiringDefaults(s, {
      companyId: String(formData.get('companyId') ?? ''),
      probationMonths: String(formData.get('probationMonths') ?? '').trim() || null,
      reviewReminderDays: String(formData.get('reviewReminderDays') ?? '').trim() || null,
    });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?toast=${encodeURIComponent('Hiring defaults saved')}`);
}
