import { getTranslations } from 'next-intl/server';
import { PEOPLE_SETTINGS_HREF } from '@/lib/navigation/people-settings';

/**
 * 82748f92 — the shared "← Back to Settings" link for the People setup pages reachable from the
 * /admin/settings/people card grid (modelled on app/payroll/setup/back.ts settingsBack()).
 *
 * The getTranslations('peopleSettingsHub') call lives HERE, not in the page files, so each destination page keeps
 * its own namespaces and stays statically resolvable by test/i18n-coverage.test.ts Check C.
 */
export async function peopleSettingsBack() {
  const t = await getTranslations('peopleSettingsHub');
  return { href: PEOPLE_SETTINGS_HREF, label: t('backToSettings') } as const;
}
