import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listHiringDefaults } from '@/core/hiring-defaults';
import { DEFAULT_REVIEW_REMINDER_DAYS } from '@/core/employment-review';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { saveHiringDefaultsAction } from './actions';

/**
 * Hiring Defaults (r79a, feedback 4fb8b75a step 3) — the new home of two settings that were living on the
 * Payroll Schedule screen with no payroll reader between them:
 *
 *   • Probation months — the default probation length for a FULL-TIME hire. The hire form on
 *     /admin/personnel prefills its provisional end date from it, and the hire action computes the stored
 *     date from it. Blank = the built-in 3.
 *   • Review reminder days — how many days before an employment review's end date the nightly sweep nudges
 *     the manager and HR. Blank = the built-in 30, 14, 7.
 *
 * Both are per company, so one card per company in the admin's scope (the /admin/payroll-config layout).
 * ONE translation namespace, so test/i18n-coverage.test.ts Check C statically resolves every key on this
 * page (Check C skips any file that opens two namespaces — the settingsBack precedent).
 *
 * requireAdmin gates the screen exactly like the rest of /admin/personnel; RLS on `company` is the real
 * backstop. Route registered on the existing `personnelAdmin` entry in lib/permissions.ts, so it inherits
 * that screen's function-access column rather than minting a new one.
 */
export default async function HiringDefaultsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdmin();
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('people.hiringDefaults');
  const { error } = await searchParams;

  const companies = (await listCompanies(s)).filter((c) => scopeIds.includes(c.id));
  const defaults = await listHiringDefaults(s, companies.map((c) => c.id));
  const byCompany = new Map(defaults.map((d) => [d.companyId, d]));
  const reminderPlaceholder = DEFAULT_REVIEW_REMINDER_DAYS.join(', ');

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        back={{ href: '/admin/personnel', label: t('back') }}
      />
      {error && <ErrorBanner message={error} />}

      {companies.length === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('emptyScope')}</p>
        </Card>
      ) : (
        companies.map((company) => {
          const d = byCompany.get(company.id) ?? null;
          return (
            <Card key={company.id}>
              <SectionHeader title={company.name} />
              <form action={saveHiringDefaultsAction} className="space-y-4 p-4">
                <input type="hidden" name="companyId" value={company.id} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('probationMonths')}>
                    <input
                      type="number"
                      name="probationMonths"
                      min={1}
                      defaultValue={d?.probationMonths ?? ''}
                      placeholder="3"
                      className={inputCls}
                    />
                  </Field>
                  <Field label={t('reviewReminderDays')}>
                    <input
                      name="reviewReminderDays"
                      defaultValue={d?.reviewReminderDays?.join(', ') ?? ''}
                      placeholder={reminderPlaceholder}
                      className={inputCls}
                    />
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">{t('probationMonthsHint')}</p>
                <p className="text-xs text-muted-foreground">{t('reviewReminderDaysHint')}</p>
                <button className={btnPrimary}>{t('save')}</button>
              </form>
            </Card>
          );
        })
      )}
    </div>
  );
}
