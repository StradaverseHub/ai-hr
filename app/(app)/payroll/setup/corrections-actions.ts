'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { setTenantSetting, TenantSettingError } from '@/core/tenant-settings';

export type CorrectionsState = { saved?: boolean; error?: string };

/** One fixed tenant setting: neither the key nor tenant identity comes from the browser. */
export async function savePayrollCorrections(
  _previous: CorrectionsState,
  formData: FormData,
): Promise<CorrectionsState> {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.setup.corrections');
  const values = formData.getAll('enabled');
  if (values.length > 1 || (values.length === 1 && values[0] !== 'on')) {
    return { error: t('invalid') };
  }
  try {
    // The canonical writer rechecks current group authority under the Access lock, then commits
    // the setting and actor-attributed audit event in the same transaction.
    await setTenantSetting(s, { key: 'payroll.reset_enabled', value: values.length === 1 });
  } catch (error) {
    return { error: t(error instanceof TenantSettingError && error.reason === 'not_group_admin' ? 'readOnly' : 'failed') };
  }
  revalidatePath('/payroll', 'layout');
  return { saved: true };
}
