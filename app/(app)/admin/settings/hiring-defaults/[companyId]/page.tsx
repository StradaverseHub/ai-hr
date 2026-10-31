import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { getHiringDefaults } from '@/core/hiring-defaults';
import { DEFAULT_REVIEW_REMINDER_DAYS } from '@/core/employment-review';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { saveHiringDefaultsAction } from '../actions';

const PAGE = '/admin/settings/hiring-defaults';

/**
 * Hiring Defaults — ONE COMPANY (feedback 7b5f18c3).
 *
 * The detail half of the list+detail shape. Exactly the two settings the previous all-companies-on-one-
 * page screen carried, for the single company named in the address:
 *
 *   • Probation months — the default probation length for a FULL-TIME hire. The Create New Employee
 *     wizard prefills its provisional end date from it. Blank = the built-in 3.
 *   • Review reminder days — how many days before an employment review's end date the nightly sweep
 *     nudges the manager and HR. Blank = the built-in 30, 14, 7.
 *
 * A DEDICATED ROUTE, NOT A ?edit= PANEL. Movement Settings (1b87e8a0) uses the query-param panel that
 * Employee ID established, and this one does not, on purpose: a company is a first-class thing an admin
 * links to and bookmarks, and the reporter asked to "open its Hiring Defaults configuration". The two
 * screens share the LIST conventions (components/settings-list.tsx) — the toolbar, the house table, the
 * row actions — not their editor mechanism. Say that in the release note so the difference is not read
 * as drift.
 *
 * SCOPE IS THE GUARD, notFound() IS THE ANSWER. A company outside the acting admin's scope 404s rather
 * than rendering an empty form: RLS would refuse the write anyway, and a form that cannot save is worse
 * than an honest miss.
 *
 * ONE TRANSLATION NAMESPACE (Check C).
 */
export default async function HiringDefaultsCompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('hiringDefaults');
  const { companyId } = await params;
  const { error } = await searchParams;

  const company = (await listCompanies(s, { includeArchived: true })).find(
    (c) => c.id === companyId && scopeIds.includes(c.id),
  );
  if (!company) notFound();

  const d = await getHiringDefaults(s, company.id);
  const reminderPlaceholder = DEFAULT_REVIEW_REMINDER_DAYS.join(', ');

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* The COMPANY is the subject of this page, so it is the heading; the back-link names the list you
          came from. There is no separate `back` label key — the list's own title is the honest label,
          and minting a second string for it is how two names for one screen start. */}
      <PageHeader
        title={company.name}
        description={company.companyLabel ?? undefined}
        back={{ href: PAGE, label: t('title') }}
      />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title={t('title')} />
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
          <div className="flex items-center gap-3">
            <button className={btnPrimary}>{t('save')}</button>
            <Link href={PAGE} className="text-sm font-medium text-muted-foreground hover:text-foreground">
              {t('cancel')}
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
