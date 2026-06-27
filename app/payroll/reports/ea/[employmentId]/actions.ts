'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { setEaOverride, clearEaOverride, EaOverrideError } from '@/core/ea-override';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where to bounce back to after a write — the EA page for this employment + year. Toast/error in qs
 *  (already-localized strings, like the pay-components actions). */
function back(employmentId: string, year: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ year, ...params }).toString();
  redirect(`/payroll/reports/ea/${employmentId}?${qs}`);
}

/** Map an EaOverrideError code → a localized message under payroll.ea.override. Unknown codes pass through. */
async function localizeError(code: string): Promise<string> {
  const t = await getTranslations('payroll.ea.override');
  const KEY: Record<string, string> = {
    forbidden: 'reasonRequired', // forbidden is RBAC; surfaced generically — service guard is primary
    invalidField: 'invalidAmount',
    invalidAmount: 'invalidAmount',
    invalidYear: 'invalidAmount',
    reasonRequired: 'reasonRequired',
    notFound: 'invalidAmount',
  };
  return t(KEY[code] ?? 'invalidAmount');
}

/** Amend one EA field (server action). Actor threaded from getSession(); the service guards RBAC. */
export async function amendEaFieldAction(formData: FormData) {
  const employmentId = String(formData.get('employmentId') ?? '');
  const year = String(formData.get('year') ?? '');
  const field = String(formData.get('field') ?? '');
  const amount = Number(formData.get('amount'));
  const reason = String(formData.get('reason') ?? '');
  if (!UUID.test(employmentId) || !/^\d{4}$/.test(year)) redirect('/payroll/reports');
  const s = await getSession();
  try {
    const { cleared } = await setEaOverride(s, { employmentId, year, field, amount, reason });
    revalidatePath(`/payroll/reports/ea/${employmentId}`);
    const t = await getTranslations('payroll.ea.override');
    back(employmentId, year, { toast: cleared ? t('cleared') : t('saved') });
  } catch (e) {
    if (e instanceof EaOverrideError) return back(employmentId, year, { error: await localizeError(e.code) });
    throw e;
  }
}

/** Reset one EA field to its payroll-derived value (hard delete + cleared event). */
export async function clearEaFieldAction(formData: FormData) {
  const employmentId = String(formData.get('employmentId') ?? '');
  const year = String(formData.get('year') ?? '');
  const field = String(formData.get('field') ?? '');
  if (!UUID.test(employmentId) || !/^\d{4}$/.test(year)) redirect('/payroll/reports');
  const s = await getSession();
  try {
    await clearEaOverride(s, { employmentId, year, field });
    revalidatePath(`/payroll/reports/ea/${employmentId}`);
    const t = await getTranslations('payroll.ea.override');
    back(employmentId, year, { toast: t('cleared') });
  } catch (e) {
    if (e instanceof EaOverrideError) return back(employmentId, year, { error: await localizeError(e.code) });
    throw e;
  }
}
