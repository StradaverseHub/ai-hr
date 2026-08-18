import { getTranslations } from 'next-intl/server';
import { payrollListReturnTo } from '@/lib/return-to';

/**
 * 9066bd6c — the shared "← Payroll" back link for the screens under the Payroll workbench that had none.
 *
 * DIRECTLY MODELLED ON `app/payroll/setup/back.ts`, including the reason it is a module of its own: the
 * `getTranslations('payroll.list')` call lives HERE rather than in each page, so every destination page
 * keeps exactly ONE namespace and stays covered by test/i18n-coverage.test.ts Check C, which only
 * statically resolves single-namespace files. Adding a second namespace to a page silently switches that
 * check off for it.
 *
 * NO NEW KEY IS MINTED. It reuses `payroll.list.title` ("Payroll"), which is already translated in all
 * six locales and is the exact label the run screen's own Back has always shown — so the idiom stays one
 * idiom rather than becoming six near-duplicate strings.
 *
 * `from` is the Payroll Process list's own filter query, handed to every row link by app/payroll/page.tsx
 * so Back returns the list as it was left (same year, months, company, cycle and status). Absent or
 * hostile ⇒ `/payroll`, i.e. exactly today's destination — `payrollListReturnTo` whitelists by shape.
 */
export async function payrollProcessBack(from?: string) {
  const t = await getTranslations('payroll.list');
  return { href: payrollListReturnTo(from), label: t('title') } as const;
}
