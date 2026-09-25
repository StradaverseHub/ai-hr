import { getLocale, getTranslations } from 'next-intl/server';
import { listCompanies } from '@/core/read';
import { scopedAdmin } from '@/lib/scope';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
import { Card, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { DownloadDialog } from './download-dialog';
import { SUBMISSION_GROUPS, formatsInGroup, type SubmissionFormat } from './registry';

/**
 * 20f6c6a8 — PAYMENT SUBMISSION: pick a month, see every file this employer can file for it, download it.
 *
 * "THE MODULE GENERATES A FILE AND HANDS IT OVER; IT TRANSMITS NOTHING." That is the item, and it is the
 * one sentence this screen has to keep true. Nothing here submits, files, marks or records: every button
 * is a GET that returns bytes. The screen says so in as many words (`nothingFiledNotice`) because an
 * operator who believes a download filed their PCB will miss a deadline believing it was met.
 *
 * ── THE SCREEN READS THE REGISTRY AND DOES NOT KNOW WHAT AN AUTHORITY IS ─────────────────────────
 * There is no `epf`/`socso`/`lhdn` anywhere below. It iterates `SUBMISSION_GROUPS`, asks
 * `formatsInGroup` for each shelf's entries and renders whatever comes back — so a format added to
 * `registry.ts` appears here with no change to this file, and one removed disappears from it. That is the
 * seam the round was for, and `test/payment-submission-module.test.ts` proves both directions rather than
 * asserting the intention.
 *
 * The cautionary sibling is `app/payroll/statutory-forms/[formId]/page.tsx`, which carries four literal
 * `formId === 'my.cp39' | 'my.socso-eis' | 'my.borang-8a' | 'my.borang-a'` branches: every new form there
 * reopens the component, and the fifth will too.
 *
 * ── PROVENANCE IS ON THE SCREEN, NOT IN A HEADER NOBODY SEES ─────────────────────────────────────
 * Every row prints its `verification`: whether these bytes are checked against a file the customer really
 * filed, or only against the agency's own published sample. The EPF layout was once transcribed from
 * reverse-engineered field tables and filed the wrong numbers in the right shape; the lesson that cost is
 * that a file's provenance must be visible to the person about to upload it. `/payroll/reports` offers the
 * LHDN file today with its draft notice in an HTTP RESPONSE HEADER (`X-Draft-Notice`), which no operator
 * has ever read. Here it is a line of text beside the button.
 *
 * ── e78fd03d: YOU CHOOSE THE FILE FIRST, AND IT THEN ASKS WHAT THE FILE COVERS ───────────────────
 * The screen used to carry a Year / Payroll month pair and a SHOW button ABOVE the shelves, so a selection
 * was made before anything had been chosen to apply it to. Those fields and that button are gone: each
 * available row's Download opens `DownloadDialog`, which asks for company, year and payroll month and then
 * produces that one file. The reporter asked for that order and it is the right way round.
 *
 * ⚠️ THE COMPANY WAS NEVER A FIELD THE REPORTER LOST. Their request describes the old area as "Company,
 * Year and Payroll Month with a SHOW button"; it was Year and Month, and the company came from the
 * switcher at the top of the page. All three are in the pop-up now, as asked.
 *
 * STILL GET-DRIVEN, AND STILL NO SERVER ACTION. The dialog's Download is a plain `<form method="get">`
 * pointed at the same route the row's link used to point at, so generating a file still records nothing.
 * The only client state on this screen is "is the pop-up open", inside the dialog; this file remains a
 * server component that hands the dialog flat props and no closure (the 500-on-every-request trap).
 *
 * ⚠️ NO FORM NESTING, AND NO FORM ON THE PAGE AT ALL ANY MORE. A form inside a form is invalid HTML and
 * browsers drop the inner one; the filter form that made that a hazard has been removed, and each dialog's
 * form lives in a `Dialog.Portal` attached to `document.body` rather than inside this tree.
 *
 * ⚠️ THE PERIOD IS NO LONGER IN THE URL OF THIS SCREEN, only in the download's. `?companyId=&year=&month=`
 * is still READ, so an old bookmark still opens with the same defaults selected in every pop-up — but
 * there is nothing on the screen for a period to change any more, so nothing is shown for it either.
 *
 * GATED LIKE ITS SIBLING SCREENS: `scopedAdmin`, not `isAdmin` — an `hr_admin` grant on ANY company makes
 * `isAdmin` true, and these downloads carry every employee's name, identity card number and contributions.
 * Registered in the function-access matrix under `statutoryForms` (lib/permissions.ts): a guarded page.tsx
 * with no column fails test/function-access.test.ts rather than becoming a screen nobody can grant.
 *
 * ── ENTITLEMENT: THIS RIDES PAYROLL'S, AND IS NOT ITS OWN MODULE (ADR-0077) ──────────────────────
 * `packs/catalog.ts` is the source of truth for what a customer can buy, and every entry there is a
 * COMMERCIAL unit with a category, a price-bearing `billable` flag and a `dependsOn` closure. "Payment
 * Submission" is not one: it sells nothing that Payroll does not already sell, it reads only figures a
 * payroll run produced, and its data path (`reportPreview`, `cp39FileForBatch`) sits behind service files
 * already bound to the `payroll` module by `core/module-gate.ts`. Giving it a code of its own would mean a
 * customer who bought Payroll could not file what Payroll computed until somebody wrote them a second
 * `tenant_module` row — a regression dressed as architecture. The nav row lives inside the payroll pack's
 * node, so `visibleModuleCodes` already hides it for a tenant without Payroll.
 */
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
  // These three are the pop-ups' DEFAULTS now, not a filter the screen applies to anything: nothing on the
  // page below varies with the month any more. `?periodKey=` is still honoured so an old link still opens
  // with the month it named already selected. The dialog joins year and month back into one `periodKey`.
  // Always includes the selected year, so an older link cannot resolve to a year the select cannot show.
  const years = yearOptions(today, year);
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  // The month OPTIONS, named in the reader's own language, built once on the server and handed to every
  // pop-up as flat data. Formatting them in the dialog would need the locale across the boundary for no gain.
  const monthOptions = MONTHS.map((m) => ({
    value: m,
    label: monthFmt.format(new Date(Date.UTC(2000, Number(m) - 1, 1))),
  }));

  /**
   * The provenance line for a row. A MAP, NOT A COMPUTED KEY.
   *
   * `t(`verification.${f.verification}`)` would render MISSING_MESSAGE the first time a new value was
   * added to the union — on a statutory screen, beside a download button. An explicit map is checked by
   * tsc instead: adding a member to `FormatVerification` fails the build here until it is translated.
   */
  const verificationLabel: Record<SubmissionFormat['verification'], string> = {
    'filed-file': t('verificationFiledFile'),
    'specification-sample': t('verificationSpecificationSample'),
    'field-table-only': t('verificationFieldTableOnly'),
  };

  // ONE spelling of the download route, handed to the dialog. The dialog builds the query as form fields
  // rather than as a string, so nothing here encodes a parameter twice.
  const DOWNLOAD_ACTION = '/payroll/payment-submission/download';

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

      {/*
        THE REGISTRY DRIVES EVERYTHING BELOW. No authority is named in this file; the shelves and their
        contents are whatever `registry.ts` declares. See the header.
      */}
      {SUBMISSION_GROUPS.map((group) => {
        const formats = formatsInGroup(group.key);
        return (
          <section key={group.key} data-group={group.key}>
            <SectionHeader title={t(group.labelKey)} />
            {formats.length === 0 ? (
              // An empty shelf EXPLAINS ITSELF rather than vanishing. A missing section reads as an
              // oversight; a present one that says why it is empty reads as a decision. See the registry.
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
                        {/* Provenance, on the screen. See the header for why this is not an HTTP header. */}
                        <p className="text-xs text-muted-foreground" data-verification={f.verification}>
                          {verificationLabel[f.verification]}
                        </p>
                      </div>
                      {f.available ? (
                        // `data-download` stays HERE, on the page's own tree, because that is what the
                        // registry-drives-the-screen guard walks (test/payment-submission-screen-seam.test.ts
                        // renders this component and reads props; it never renders the dialog).
                        <div data-download={f.id}>
                          <DownloadDialog
                            formatId={f.id}
                            formatLabel={t(f.labelKey)}
                            // The format's OWN declaration of what has to be chosen. The screen does not
                            // decide this and does not branch on the shelf it is on.
                            periodKind={f.periodKind}
                            action={DOWNLOAD_ACTION}
                            companies={companies.map((c) => ({ value: c.id, label: c.name }))}
                            defaultCompanyId={companyId}
                            years={years}
                            defaultYear={year}
                            months={monthOptions}
                            defaultMonth={month}
                          />
                        </div>
                      ) : (
                        // No button at all, and none is possible: an unavailable descriptor has no
                        // `build` to call. The reason is printed instead of a disabled control, because a
                        // greyed-out button says "later" and says nothing about what is needed.
                        <p className="max-w-sm text-sm text-muted-foreground" data-unavailable={f.id}>
                          {t(f.unavailableReasonKey)}
                        </p>
                      )}
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
