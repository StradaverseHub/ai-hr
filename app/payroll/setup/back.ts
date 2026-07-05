import { getTranslations } from 'next-intl/server';

/**
 * Shared "← Payroll Settings" back link for every maintenance screen reachable from
 * the /payroll/setup card grid. Reuses payroll.setup.title (already translated in all
 * six locales) so no new i18n key is minted.
 *
 * The second getTranslations('payroll.setup') call lives HERE, not in the page files,
 * so each destination page keeps exactly one namespace and stays fully covered by
 * test/i18n-coverage.test.ts Check C (which only statically resolves single-namespace files).
 */
export async function settingsBack() {
  const t = await getTranslations('payroll.setup');
  return { href: '/payroll/setup', label: t('title') } as const;
}
