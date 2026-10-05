'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setHiringDefaults } from '@/core/hiring-defaults';

const PAGE = '/admin/settings/hiring-defaults';

/**
 * Save one company's hiring defaults.
 *
 * MOVED VERBATIM from app/admin/personnel/settings/actions.ts by 7b5f18c3 — same service call, same
 * guard, same clamp-to-NULL semantics (blank/invalid restores the built-in 3 months / [30, 14, 7]
 * rather than storing a broken value). The only change is where an error or a success lands: the
 * detail page on failure, so the admin sees the message beside the form they were filling, and the
 * company list on success, which is the "set it and come back" flow the redesign asks for.
 *
 * requireAdmin here mirrors the screen's own scopedAdmin guard (scopedAdmin calls requireAdmin
 * internally); RLS on `company` is the real backstop, and it is what stops a forged companyId in the
 * form body from writing to a company outside the tenant.
 */
export async function saveHiringDefaultsAction(formData: FormData) {
  const s = await requireAdmin();
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await setHiringDefaults(s, {
      companyId,
      probationMonths: String(formData.get('probationMonths') ?? '').trim() || null,
      reviewReminderDays: String(formData.get('reviewReminderDays') ?? '').trim() || null,
    });
  } catch (e) {
    redirect(`${PAGE}/${companyId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(PAGE);
  revalidatePath(`${PAGE}/${companyId}`);
  redirect(`${PAGE}?toast=${encodeURIComponent('Hiring defaults saved')}`);
}
