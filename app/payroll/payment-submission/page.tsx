import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { scopedAdmin } from '@/lib/scope';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
import { Card, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { BankDownloadDialog } from './bank-download-dialog';
import { DownloadDialog } from './download-dialog';
import { SUBMISSION_GROUPS, formatsInGroup, type SubmissionFormat } from './registry';

/** Government exports retain the per-format registry and GET flow. Bank downloads share
 * one entry per payment group and resolve the exact format after the authorised account is chosen. */
export const dynamic = 'force-dynamic';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/** Default to the month just ENDED — the one whose returns are actually open. Same rule as the shelf. */
function previousMonth(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

type Search = Record<string, string | string[] | undefined>;

export default async function PaymentSubmissionPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations('payroll.paymentSubmission');
  const locale = await getLocale();
  const sp = await searchParams;

  const { s, scopeIds } = await scopedAdmin();
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt && scopeIds.includes(c.id));
  // An out-of-scope companyId in the URL falls back to the first company this admin CAN administer rather
  // than being honoured — the same rule the download route's builders apply, so the screen and the file
  // cannot disagree about which company is being looked at.
  const requested = typeof sp.companyId === 'string' && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const companyId = requested || companies[0]?.id || '';

  const today = todayInKualaLumpur();
  const spPeriod = typeof sp.periodKey === 'string' ? sp.periodKey : '';
  const fallback = /^\d{4}-\d{2}$/.test(spPeriod) ? spPeriod : previousMonth(today);
  const year = typeof sp.year === 'string' && /^\d{4}$/.test(sp.year) ? sp.year : fallback.slice(0, 4);
  const month = MONTHS.includes(sp.month as (typeof MONTHS)[number]) ? (sp.month as string) : fallback.slice(5, 7);
  // Preserve linked period defaults for government exports and prefer them for eligible bank runs.
  const years = yearOptions(today, year);
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  // The month OPTIONS, named in the reader's own language, built once on the server and handed to every
  // pop-up as flat data. Formatting them in the dialog would need the locale across the boundary for no gain.
  const monthOptions = MONTHS.map((m) => ({
    value: m,
    label: monthFmt.format(new Date(Date.UTC(2000, Number(m) - 1, 1))),
  }));

  // Keep file provenance visible beside the action, including the selected bank format in its dialog.
  const verificationLabel: Record<SubmissionFormat['verification'], string> = {
    'filed-file': t('verificationFiledFile'),
    'specification-sample': t('verificationSpecificationSample'),
    'field-table-only': t('verificationFieldTableOnly'),
  };

  const DOWNLOAD_ACTION = '/payroll/payment-submission/download';
  const RUNS_ENDPOINT = '/payroll/payment-submission/runs';

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      {/*
        THE ONE SENTENCE THIS SCREEN EXISTS TO KEEP TRUE, above the files rather than under them. An
        operator who believes downloading filed their return will miss the deadline believing it was met.
      */}
      <Card className="border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-medium">{t('nothingFiledTitle')}</p>
        <p className="mt-1">{t('nothingFiledNotice')}</p>
      </Card>

      {SUBMISSION_GROUPS.map((group) => {
        const formats = formatsInGroup(group.key);
        const companyOptions = companies.map((c) => ({ value: c.id, label: c.name }));
        if (group.key !== 'governmentStatutory') {
          const bankFormats = formats.flatMap(f => f.available && f.transport === 'bank-post' ? [{
            id: f.id,
            label: t(f.labelKey),
            description: t(f.descriptionKey),
            verification: verificationLabel[f.verification],
            testIndicator: f.testIndicator,
          }] : []);
          return <section key={group.key} data-group={group.key}>
            <Card className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
              <h2 className="font-medium">{t(group.key === 'salary' ? 'bankSalaryPayment' : 'bankStatutoryPayment')}</h2>
              {bankFormats.length ? <BankDownloadDialog
                group={group.key}
                formats={bankFormats}
                endpoint="/payroll/payment-submission/bank-file"
                companies={companyOptions}
                months={monthOptions}
                defaultPeriodKey={year + '-' + month}
                defaultPaymentDate={today}
              /> : <p className="text-sm text-muted-foreground" data-empty-group={group.key}>{t(group.emptyNoteKey)}</p>}
            </Card>
          </section>;
        }
        return (
          <section key={group.key} data-group={group.key}>
            <SectionHeader title={t(group.labelKey)} />
            {formats.length === 0 ? (
              <Card className="px-4 py-4 text-sm text-muted-foreground" data-empty-group={group.key}>
                {t(group.emptyNoteKey)}
              </Card>
            ) : (
              <div className="space-y-3">
                {formats.map((f) => (
                  <Card key={f.id} className="px-4 py-4" data-format={f.id}>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">
                          {t(f.labelKey)}{' '}
                          <span className="text-sm font-normal text-muted-foreground">· {f.authority}</span>
                        </p>
                        <p className="text-sm text-muted-foreground">{t(f.descriptionKey)}</p>
                        <p className="text-xs text-muted-foreground" data-verification={f.verification}>
                          {verificationLabel[f.verification]}
                        </p>
                      </div>
                      {f.available && f.transport !== 'bank-post' && (
                        <div data-download={f.id}>
                          <DownloadDialog
                            formatId={f.id}
                            formatLabel={t(f.labelKey)}
                            periodKind={f.periodKind}
                            action={DOWNLOAD_ACTION}
                            companies={companyOptions}
                            defaultCompanyId={companyId}
                            years={years}
                            defaultYear={year}
                            months={monthOptions}
                            defaultMonth={month}
                            runsEndpoint={RUNS_ENDPOINT}
                          />
                        </div>
                      )}
                      {!f.available && <p className="max-w-sm text-sm text-muted-foreground" data-unavailable={f.id}>
                        {t(f.unavailableReasonKey)}
                      </p>}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
