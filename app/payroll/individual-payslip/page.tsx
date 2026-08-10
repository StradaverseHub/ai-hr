/**
 * Feedback 169e3c24 — Individual Payslip: one named place to review, verify, print and download an
 * employee's payslip BEFORE it is released.
 *
 * REPRODUCED FIRST, AND THE FINDING WAS "adjacent screen". Most of what the ticket asks for already
 * shipped — the itemised admin breakdown lives on Transaction View → History, deliberately without the
 * ESS release gate so a processed-but-unreleased run can be inspected. What was genuinely missing:
 *   1. an entry point. Nothing in the menu said "payslip", so almost nobody found it.
 *   2. print / PDF BEFORE release. The existing PDF route reads through payslipDetail, whose release gate
 *      returns null until the batch is closed AND released — exactly backwards for a reviewer.
 *   3. year-to-date beside the current month.
 *   4. any explanation of the PCB figure, whose every input has been persisted (`pcbMeta`) and displayed
 *      nowhere since it was introduced.
 *
 * SO THIS SCREEN BORROWS RATHER THAN REBUILDS. The earnings / deductions / employer-contribution
 * derivation is `deriveHistoryBreakdown`, the same function History renders, so the two screens cannot
 * drift apart about one payslip's figures.
 *
 * THE RELEASE GATE IS NOT TOUCHED. `payslipDetail` keeps its gate for ESS; this screen and its PDF read
 * through `payslipForReview`, an admin read fenced on the caller's authorised companyIds. Different read,
 * different fence — the gate is not weakened, parameterised or bypassed.
 *
 * READ-ONLY END TO END. No row is inserted, updated, deleted or recomputed, and no employee-visible
 * figure changes.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────────
 * r168a (feedback da4af51f) CHANGED THE EMPLOYEE CONTROL AND THE LETTERHEAD. Nothing else.
 *
 * FOUR OF THE SIX POINTS THAT REQUEST RAISED WERE ALREADY BUILT, and rebuilding them would have risked
 * working screens for nothing, so they were reproduced first and left alone:
 *   - the Year / Month / Cycle hierarchy is the GET form below, and `listProcessedPayslipsAcross` already
 *     takes all three. The "otherRuns" card renders only when matches.length > 1 — it is deliberate
 *     disambiguation between a regular and a bonus run in one month, not a history list, and it does not
 *     grow with the years.
 *   - Earnings / Deductions / employer contributions / YTD are already separate sections.
 *   - the PCB drill-down already reads the payslip's OWN persisted `pcbMeta`, so an old slip explains
 *     itself with the numbers that were true when it ran.
 *   - Print and Download PDF are already wired.
 *
 * THE LOGO — AND A CORRECTION. The comment that used to sit on the letterhead below stated "There is NO
 * company logo anywhere in this product — no column, no upload, no storage". THAT WAS WRONG, and it was
 * wrong when 169e3c24 shipped this screen without a logo on the strength of it. `company_logo`
 * (db/schema.ts) is a 1:1 bytea side table with an upload on the Organization screen, a serve route at
 * /admin/organization/logo/[id], and `listCompanies` already returns `hasLogo` for exactly this kind of
 * caller. So the letterhead now renders it when the company has one and degrades to the legal name when it
 * does not — which is why `hasLogo` is checked rather than the <img> being left to 404.
 *
 * EMAIL PAYSLIP IS NOT BUILT, and the reason is recorded here rather than left as a silent gap: this
 * product has NO outbound mail transport. The single email path in the codebase is the auth provider's own
 * invitation call (core/auth.ts `sendInvitation`), which cannot carry an attachment. Adding one is a
 * transport, a credential, a bounce/delivery-audit story and a PDPA decision about mailing net pay — its
 * own piece of work, not a button on this screen.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────────
 * r179 (feedback f35f758a) — THE SCREEN HALF. Four changes, none of them to a figure:
 *
 *   1. THE EMPLOYEE CONTROL MOVED INTO THE FILTER ROW and the left-hand panel is gone. It is the SHARED
 *      search field (components/employee-search-field.tsx), built once for this item and 98e69987 because
 *      both asked for the same affordance in the same words. It posts a hidden `employmentId` exactly as
 *      the old `<select>` did, so the submitted query string and every guard below are unchanged.
 *   2. THE FILTER BUTTON READS "View Payslip" — the reader is not applying a filter, they are asking for
 *      one person's payslip.
 *   3. THE ONE LONG CARD IS NOW SEPARATE CARDS. Same sections, same order, same figures.
 *   4. PRINT BECAME PREVIEW. Printing the WEB PAGE produced a document that was not the payslip the
 *      employee receives; the preview below frames the ACTUAL FILE from the same route the Download
 *      button uses, so preview and download cannot disagree, and printing is the PDF viewer's own job.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees, listCompanies } from '@/core/read';
import { currentPcbReliefs, listProcessedPayslipsAcross, payslipForReview, sumPayslipYtd } from '@/core/payroll-view';
import { explainPcb } from '@/core/pcb-explain';
import { absenceDaysLabel, payslipAbsenceLines } from '@/core/payslip-absence-lines';
import { payslipEmployerBorne, type EmployerBorneKey } from '@/core/payslip-employer-borne';
import { payrollPublicationState, PAYROLL_PUBLICATION_PILL } from '@/lib/payroll-publication';
import { payslipProvenance } from '@/core/payslip-recompute';
import { formatMoney } from '@/lib/money';
import { packFor } from '@/localization/registry';
import { Button, Card, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { EmployeeSearchField, type EmployeeSearchOption } from '@/components/employee-search-field';
import { deriveHistoryBreakdown } from '../transaction-view/history-breakdown';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;

/** Parse an optional positive-int query param within [min, max]; anything else ⇒ undefined. */
function intParam(v: string | undefined, min: number, max: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * f35f758a — "August 2026", not the stored "2026-08".
 *
 * The idiom this repo already uses for a month name on four screens (statutory forms, the roster,
 * scheduled actions, the EA report): `Intl.DateTimeFormat`, month long, `timeZone: 'UTC'` so a month can
 * never shift by one in a negative-offset render. No new message keys — twelve month names across six
 * locales is a translation set to keep in step for something the platform already knows.
 *
 * A SCREEN formats in the reader's own language. The downloaded document deliberately does not: its
 * embedded font is Latin-1 and a Chinese, Thai or Tamil month name would print as question marks
 * (lib/payslip-pdf-strings.ts says so at the point it pins English).
 */
function monthYear(payPeriod: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return payPeriod ?? '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}

/** The label key for each employer-borne component, exhaustive over EmployerBorneKey. */
const EMPLOYER_BORNE_LABEL: Record<EmployerBorneKey, 'epf' | 'socso' | 'skbbk' | 'eis' | 'pcb'> = {
  epf: 'epf', socso: 'socso', skbbk: 'skbbk', eis: 'eis', tax: 'pcb',
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value || '—'}</dd>
    </div>
  );
}

/** One card in the payslip stack. The screen used to be a single tall card with <section>s inside it. */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </Card>
  );
}

export default async function IndividualPayslipPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string;
    employmentId?: string;
    year?: string;
    month?: string;
    cycle?: string;
    payslipId?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.individualPayslip');
  const tSlip = await getTranslations('me.payslip');
  const tTxn = await getTranslations('payroll.transactions');
  const locale = await getLocale();
  const sp = await searchParams;

  const [employees, companies] = await Promise.all([listEmployees(s, scopeIds), listCompanies(s)]);
  const scopedCompanies = companies.filter((c) => scopeIds.includes(c.id));

  // SCOPE-GUARD every ?param, exactly as Transaction View does: an out-of-scope companyId/employmentId is
  // treated as "no selection", so URL tampering can only ever narrow, never widen. This guard is UNCHANGED
  // by r179 — the control that expresses the selection moved, the place it is DECIDED did not.
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : undefined;
  const companyIds = companyId ? [companyId] : scopeIds;
  const employmentId =
    sp.employmentId && employees.some((e) => e.employmentId === sp.employmentId) ? sp.employmentId : undefined;
  const year = intParam(sp.year, 2000, 2100);
  const month = intParam(sp.month, 1, 12);
  const cycle = CYCLES.includes(sp.cycle as (typeof CYCLES)[number]) ? sp.cycle : undefined;

  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => nowYear + 1 - i);

  // Fed the SAME set the scope guard above accepts, so the field cannot offer a row the server refuses.
  // The second line is what tells two people with the same name apart at a glance.
  const searchOptions: EmployeeSearchOption[] = employees.map((e) => ({
    value: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    secondary: [e.company, e.department].filter(Boolean).join(' · ') || null,
  }));

  // A payslip only loads once an EMPLOYEE is chosen — the ticket's flow (period → employee → payslip),
  // and also what keeps this screen from becoming a second, slower copy of History.
  const matches = employmentId
    ? await listProcessedPayslipsAcross(s, { companyIds, year, month, employmentId, cycle, limit: 25 })
    : [];
  // The chosen run, or the most recent match. A tampered payslipId simply does not match.
  const chosen = sp.payslipId ? matches.find((r) => r.id === sp.payslipId) : matches[0];

  const row = chosen ? await payslipForReview(s, { companyIds, payslipId: chosen.id }) : null;

  // Year-to-date: the same read for the whole year, no month. No new query shape is needed — the totals
  // are summed from the rows it already returns, so YTD can never disagree with the months it lists.
  const ytdRows =
    row && employmentId
      ? await listProcessedPayslipsAcross(s, {
          companyIds,
          year: Number(row.payPeriod.slice(0, 4)),
          employmentId,
        })
      : [];
  // 5c198931 — the summation moved to core/payroll-view.ts `sumPayslipYtd` (unchanged arithmetic) because
  // the downloaded document now prints this column too. A screen and a document each running their own
  // reduce over the same rows is how the two start disagreeing about someone's year.
  const ytd = sumPayslipYtd(ytdRows);

  const b = row ? deriveHistoryBreakdown(row) : null;
  const eb = row ? payslipEmployerBorne(row.statutory) : null;
  // e2632276 — split "Other deductions" into its named unpaid-leave / absence lines plus the residual.
  // Derived from the PAYSLIP'S OWN stamp, never from today's policy: a slip run before this shipped has no
  // stamp and renders the single lumped row exactly as it always has.
  const absence = payslipAbsenceLines(row?.statutory, row?.otherDeductions);
  // The PCB working. The relief FALLBACK is only consulted for a payslip calculated before the working
  // was recorded on the slip itself, and `explainPcb` reports which of the two it used so the panel can
  // say so on screen.
  const fallbackReliefs = row
    ? await currentPcbReliefs(s, {
        companyIds,
        employmentId: row.employmentId,
        asOf: `${row.payPeriod}-28`,
      })
    : null;
  const pcb = row ? explainPcb(row.statutory, fallbackReliefs) : null;
  const prov = row ? payslipProvenance(row.statutory) : null;
  const cur = row?.currency ?? null;
  const rm = (n: unknown) => formatMoney(n, cur);
  const hrdfRegistered = row
    ? ((await packFor('MY')?.companyStatutory.list(s)) ?? [])
        .filter((r) => r.hrdfStatus !== 'not_registered')
        .some((r) => r.companyId === row.companyId)
    : false;

  const pubState = row ? payrollPublicationState({ status: row.batchStatus, releasedAt: row.releasedAt }) : null;
  // `listCompanies` already returns hasLogo (an EXISTS against company_logo — the bytea itself lives in a
  // side table and is never pulled by this read), and it is already loaded above. No new query.
  const companyHasLogo = row ? companies.some((c) => c.id === row.companyId && c.hasLogo) : false;
  const pdfHref = row ? `/payroll/individual-payslip/${row.id}/pdf` : '';

  return (
    <div className="mx-auto max-w-[100rem] space-y-6 print:max-w-4xl">
      <div className="print:hidden">
        <PageHeader title={t('title')} description={t('subtitle')} />
      </div>

      {/* ── Filters (GET form — pure navigation, no mutation) ──
          r179: the EMPLOYEE is the first field, not a panel down the left. The search box carries the
          committed choice in a hidden input named employmentId, which is exactly what the old <select>
          posted — the query string, the scope guard above and every test of it are unchanged.
          `payslipId` deliberately does NOT ride along: it names a run belonging to whoever was selected
          before, and carrying it would ask the next employee's list for someone else's payslip. */}
      <Card className="p-4 print:hidden">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <Field label={t('filterEmployee')} className="w-full sm:w-72">
            <EmployeeSearchField
              name="employmentId"
              employees={searchOptions}
              value={employmentId ?? null}
              labels={{
                placeholder: t('searchPlaceholder'),
                ariaLabel: t('searchAriaLabel'),
                resultsLabel: t('searchResultsLabel'),
                noMatches: t('searchNoMatches'),
                clear: t('searchClear'),
              }}
            />
          </Field>
          <Field label={t('filterCompany')}>
            <select name="companyId" defaultValue={companyId ?? ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {scopedCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterYear')}>
            <select name="year" defaultValue={year != null ? String(year) : ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterMonth')}>
            <select name="month" defaultValue={month != null ? String(month).padStart(2, '0') : ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterCycle')}>
            <select name="cycle" defaultValue={cycle ?? ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {CYCLES.map((c) => (
                <option key={c} value={c}>{tTxn(`individual.cycle.${c}`)}</option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary">
            {t('viewPayslip')}
          </Button>
        </form>
      </Card>

      {!employmentId && <p className="text-sm text-muted-foreground">{t('chooseEmployeeHint')}</p>}
      {employmentId && !row && <p className="text-sm text-muted-foreground">{t('noPayslip')}</p>}

      {/* More than one run in the selected window (a regular plus a bonus cycle, or a re-issue): offer
          them rather than silently showing the newest. */}
      {matches.length > 1 && (
        <Card className="p-4 print:hidden">
          <SectionHeader title={t('otherRuns')} count={matches.length} />
          <div className="flex flex-wrap gap-2 pt-2">
            {matches.map((m) => (
              <Link
                key={m.id}
                href={`/payroll/individual-payslip?${new URLSearchParams({
                  ...(companyId ? { companyId } : {}),
                  ...(year != null ? { year: String(year) } : {}),
                  ...(month != null ? { month: String(month) } : {}),
                  ...(cycle ? { cycle } : {}),
                  employmentId: employmentId!,
                  payslipId: m.id,
                }).toString()}`}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  m.id === row?.id ? 'border-primary font-medium text-primary' : 'border-border hover:bg-muted'
                }`}
              >
                {monthYear(m.payPeriod, locale)} · {tTxn(`individual.cycle.${m.runType}`)}
                {m.runSeq > 1 ? ` #${m.runSeq}` : ''}
              </Link>
            ))}
          </div>
        </Card>
      )}

      {row && b && eb && pcb && (
        <>
          {/* ── Letterhead ──
              The logo is the company's OWN uploaded file, served by the existing
              /admin/organization/logo/[id] route — the same bytes the Organization screen shows, so the
              payslip cannot display a different mark from the rest of the product. It is rendered only when
              `hasLogo` says one exists (from `listCompanies`, an EXISTS against the side table — never the
              blob), because an <img> pointed at a 404 shows a broken-image icon on a payslip, which is
              worse than a clean text letterhead. No placeholder is invented when there is none. */}
          <Card className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                {companyHasLogo && (
                  /* eslint-disable-next-line @next/next/no-img-element -- a bytea served by our own route,
                     not a build-time asset; next/image would need a loader for an authenticated endpoint. */
                  <img
                    src={`/admin/organization/logo/${row.companyId}`}
                    alt={row.company}
                    className="mb-2 max-h-14 w-auto max-w-[14rem] object-contain"
                  />
                )}
                <h1 className="text-lg font-semibold tracking-tight">{row.company}</h1>
                {row.companyReg && <p className="text-xs text-muted-foreground">{row.companyReg}</p>}
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('payPeriodLine', { period: monthYear(row.payPeriod, locale) })}
                  {row.payDate ? ` · ${t('payDateLine', { date: row.payDate })}` : ''}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PAYROLL_PUBLICATION_PILL[pubState!]}`}>
                  {t(`state_${pubState}`)}
                </span>
                {row.version > 1 && (
                  <span className="text-xs text-muted-foreground">{t('revision', { n: row.version })}</span>
                )}
                {/* r179 — Download stays; Print became Preview. Printing the WEB PAGE produced something
                    that was not the document the employee receives, which is the complaint. Preview jumps
                    to the viewer at the foot of this screen, which frames the real file. */}
                <div className="flex items-center gap-2 print:hidden">
                  <a
                    href={pdfHref}
                    download
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    {tSlip('downloadPdf')}
                  </a>
                  <a
                    href="#payslip-document"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    {t('previewDocument')}
                  </a>
                </div>
              </div>
            </div>
          </Card>

          {/* ── Employee information ── */}
          <Block title={t('employeeHeading')}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Info label={t('fieldEmployeeCode')} value={row.employeeCode} />
              <Info label={t('fieldEmployeeName')} value={row.employeeName} />
              <Info
                label={row.identityIsPassport ? t('fieldPassport') : t('fieldIc')}
                value={row.identityNumber}
              />
              {/* 5c198931 — the statutory registration numbers the downloaded document prints. Added here
                  so the preview and the download show the same employee record, which was the whole
                  complaint: the two had drifted. SOCSO and EIS share ONE number — there is no separate EIS
                  column on employee_statutory_my, and the attached design prints them as one field. */}
              <Info label={t('fieldEpfNumber')} value={row.epfNumber} />
              <Info label={t('fieldSocsoNumber')} value={row.socsoNumber} />
              <Info label={t('fieldTaxNumber')} value={row.taxNumber} />
              <Info label={t('fieldDepartment')} value={row.department} />
              <Info label={t('fieldPosition')} value={row.position} />
              <Info label={t('fieldGrade')} value={row.jobGrade} />
              <Info
                label={t('fieldEmploymentType')}
                value={row.employmentType ? t(`employmentType_${row.employmentType}`) : null}
              />
              <Info
                label={t('fieldPaymentMethod')}
                value={row.paymentMethod ? t(`paymentMethod_${row.paymentMethod}`) : null}
              />
              {/* Masked in the READ, not here: the full account number never reaches the client. */}
              <Info
                label={t('fieldBankAccount')}
                value={row.bankAccountMasked ? `${row.bankName ?? ''} ${row.bankAccountMasked}`.trim() : null}
              />
              <Info label={t('fieldCurrency')} value={row.currency} />
              <Info label={t('fieldDaysWorked')} value={row.daysWorked ?? '—'} />
              <Info label={t('fieldCycle')} value={tTxn(`individual.cycle.${row.runType}`)} />
            </dl>
          </Block>

          {/* ── Earnings ── */}
          <Block title={tSlip('earnings')}>
            <Row label={tSlip('basicSalary')} value={rm(b.basic)} />
            <Row label={tSlip('allowances')} value={rm(b.allowanceNet)} />
            {b.componentsByBucket.wage.map((l, i) => (
              <p key={`w${i}`} className="flex justify-between ps-3 text-xs text-muted-foreground">
                <span>{l.name}</span>
                <span className="tabular-nums">{rm(l.amount)}</span>
              </p>
            ))}
            <Row label={tSlip('overtime')} value={rm(b.overtime)} />
            {b.otConvertAmount > 0 && (
              <Row
                label={tSlip('otConverted', { item: (b.st.otConvert?.name ?? '') })}
                value={rm(b.otConvertAmount)}
              />
            )}
            <Row label={tSlip('bonus')} value={rm(b.bonus)} />
            {b.claim > 0 && <Row label={tSlip('claim')} value={rm(b.claim)} />}
            {b.detailNotRecorded && (
              <p className="pt-1 text-[11px] text-muted-foreground">{tTxn('view.history.detailNotRecorded')}</p>
            )}
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
              <span>{tSlip('grossPay')}</span>
              <span className="tabular-nums">{rm(b.gross)}</span>
            </div>
          </Block>

          {/* ── Deductions, with the PCB drill-down beneath ── */}
          <Block title={tSlip('deductionsHeading')}>
            <Row label={tSlip('epf')} value={rm(eb.employee.epf)} />
            <Row label={tSlip('socso')} value={rm(eb.employee.socso)} />
            {Number(b.st.socsoSkbbk) > 0 && <Row label={tSlip('skbbk')} value={rm(eb.employee.skbbk)} />}
            <Row label={tSlip('eis')} value={rm(eb.employee.eis)} />
            <Row label={tSlip('pcb')} value={rm(eb.employee.pcb)} />
            {Number(b.st.cp38) > 0 && <Row label={tSlip('cp38')} value={rm(b.st.cp38)} />}
            {Number(b.st.zakat) > 0 && (
              <Row label={tSlip('zakat')} value={`${rm(b.st.zakat)} · ${tSlip('zakatOffsetNote')}`} muted />
            )}
            {/* e2632276 — the unpaid-leave and absence halves of the old unnamed lump, each with its own
                day count. `residual` is what is left of Other deductions once they come out of it, so
                the section still sums to Total deductions; a payslip with no stamp takes the `any:false`
                path and prints the single lumped row exactly as before. */}
            {absence.unpaidLeave && (
              <Row
                label={`${tSlip('unpaidLeaveLine')} · ${absenceDaysLabel(absence.unpaidLeave.days, tSlip('dayUnit'), tSlip('daysUnit'))}`}
                value={rm(absence.unpaidLeave.amount)}
              />
            )}
            {absence.absent && (
              <Row
                label={`${tSlip('absentLine')} · ${absenceDaysLabel(absence.absent.days, tSlip('dayUnit'), tSlip('daysUnit'))}`}
                value={rm(absence.absent.amount)}
              />
            )}
            {absence.showResidual && <Row label={tSlip('otherDeductions')} value={rm(absence.residual)} />}
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
              <span>{tSlip('totalDeductions')}</span>
              <span className="tabular-nums">−{rm(b.totalDeductions)}</span>
            </div>

            {/* ── PCB drill-down (169e3c24) ──
                Every figure here was already recorded on the payslip when it ran (`pcbMeta`) and had never
                been shown anywhere. Nothing is recomputed: a panel that re-derived the tax could disagree
                with the figure it claims to explain. Rendered as a native disclosure so it needs no client
                JavaScript and prints open on request. */}
            <details className="mt-4 rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">{t('pcbHeading')}</summary>
              <div className="pt-3">
                {pcb.kind === 'unavailable' && <p className="text-sm text-muted-foreground">{t('pcbUnavailable')}</p>}
                {pcb.kind === 'flat' && (
                  <>
                    <Row
                      label={pcb.nonResident ? t('pcbFlatNonResident') : t('pcbFlatIncentive')}
                      value={`${(pcb.rate * 100).toFixed(0)}%`}
                    />
                    <Row label={tSlip('pcb')} value={rm(pcb.pcb)} />
                    <p className="pt-2 text-xs text-muted-foreground">{t('pcbFlatNote')}</p>
                  </>
                )}
                {pcb.kind === 'mtd' && (
                  <>
                    <Row label={t('pcbMonthOfYear')} value={`${pcb.month} / 12`} />
                    <Row label={t('pcbYtdNet')} value={rm(pcb.ytdNetRemuneration)} />
                    <Row label={t('pcbEpfThisMonth')} value={rm(pcb.epfThisMonth)} />
                    <Row label={t('pcbEpfClaimedYtd')} value={rm(pcb.epfClaimedYtd)} />
                    <Row label={t('pcbPaidYtd')} value={rm(pcb.pcbPaidYtd)} />
                    <Row label={t('pcbChargeable')} value={rm(pcb.chargeableIncome)} />
                    {pcb.chargeableIncomeWithAdditional != null && (
                      <Row label={t('pcbChargeableWithAdditional')} value={rm(pcb.chargeableIncomeWithAdditional)} />
                    )}
                    <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('pcbReliefsHeading')}
                    </h3>
                    <Row label={t('reliefIndividual')} value={rm(pcb.reliefs.individual)} muted />
                    <Row label={t('reliefSpouse')} value={rm(pcb.reliefs.spouse)} muted />
                    <Row label={t('reliefChildren')} value={rm(pcb.reliefs.children)} muted />
                    <Row label={t('reliefDisabledIndividual')} value={rm(pcb.reliefs.disabledIndividual)} muted />
                    <Row label={t('reliefDisabledSpouse')} value={rm(pcb.reliefs.disabledSpouse)} muted />
                    <Row label={t('reliefLp')} value={rm(pcb.reliefs.lp)} muted />
                    <Row label={t('reliefTotal')} value={rm(pcb.reliefs.total)} />
                    {Number(pcb.zakat) > 0 && <Row label={tSlip('zakat')} value={rm(pcb.zakat)} muted />}
                    <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                      <span>{tSlip('pcb')}</span>
                      <span className="tabular-nums">{rm(pcb.pcb)}</span>
                    </div>
                    {pcb.pcbAdditional > 0 && (
                      <p className="pt-1 text-xs text-muted-foreground">
                        {t('pcbSplit', { normal: rm(pcb.pcbNormal), additional: rm(pcb.pcbAdditional) })}
                      </p>
                    )}
                    {/* WHICH relief position is on screen. A silent fallback would explain a closed month
                        with a position that did not exist when it was calculated. */}
                    <p className="pt-2 text-xs text-muted-foreground">
                      {pcb.reliefSource === 'snapshot' ? t('pcbReliefFromSnapshot') : t('pcbReliefFromCurrent')}
                    </p>
                  </>
                )}
              </div>
            </details>
          </Block>

          {/* ── Employer contributions, with the employer-borne disclosure folded in (3c473773) ── */}
          <Block title={tSlip('employerContributionsHeading')}>
            <Row label={tSlip('epf')} value={rm(b.employerContributions.epf)} muted />
            <Row label={tSlip('socso')} value={rm(b.employerContributions.socso)} muted />
            <Row label={tSlip('eis')} value={rm(b.employerContributions.eis)} muted />
            <Row
              label={tSlip('hrdf')}
              value={hrdfRegistered ? rm(b.employerContributions.hrdf) : tTxn('view.history.hrdfNotRegistered')}
              muted
            />
            <Row label={tSlip('totalEmployerCost')} value={rm(row.employerCost)} muted />

            {eb.any && (
              <div className="mt-4 border-t border-border pt-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {tSlip('employerBorneHeading')}
                </h3>
                {eb.keys.map((k) => (
                  <Row key={k} label={tSlip(EMPLOYER_BORNE_LABEL[k])} value={rm(eb.borne[k])} />
                ))}
                <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                  <span>{tSlip('employerBorneTotal')}</span>
                  <span className="tabular-nums">{rm(eb.total)}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{tSlip('employerBorneNote')}</p>
              </div>
            )}
          </Block>

          {/* ── Net pay ──
              The one figure the reader looks for first, so it gets the strongest treatment on the screen
              exactly as it does on the document. Presentation only: the figure and its source are
              untouched. */}
          <Card className="flex items-baseline justify-between bg-primary px-6 py-5 text-primary-foreground">
            <span className="text-sm font-semibold uppercase tracking-wide">{tSlip('netPay')}</span>
            <span className="text-2xl font-bold tabular-nums">{rm(b.net)}</span>
          </Card>

          {/* ── Year to date ──
              Summed from the SAME read that lists this employee's months, so the column beside the
              current month can never disagree with the months it is made of. */}
          <Block title={t('ytdHeading', { year: row.payPeriod.slice(0, 4) })}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">{t('ytdItem')}</th>
                    <th className="py-1 text-right font-medium">{t('ytdCurrent')}</th>
                    <th className="py-1 text-right font-medium">{t('ytdToDate')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {(
                    [
                      [tSlip('grossPay'), b.gross, ytd.gross],
                      [tSlip('epf'), b.st.epfEmployee ?? 0, ytd.epf],
                      [tSlip('socso'), b.st.socsoEmployee ?? 0, ytd.socso],
                      [tSlip('eis'), b.st.eisEmployee ?? 0, ytd.eis],
                      [tSlip('pcb'), b.st.pcb ?? 0, ytd.pcb],
                      [tSlip('netPay'), b.net, ytd.net],
                    ] as [string, unknown, number][]
                  ).map(([label, current, total]) => (
                    <tr key={label}>
                      <td className="py-1.5">{label}</td>
                      <td className="py-1.5 text-right tabular-nums">{rm(current)}</td>
                      <td className="py-1.5 text-right tabular-nums">{rm(total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* The YTD column is the FULL employee share as computed and filed, which is why it can differ
                from the deduction lines above when the employer bore part of them. Said, not hidden. */}
            <p className="mt-2 text-xs text-muted-foreground">{t('ytdNote')}</p>

            {b.recordLines.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {tTxn('view.history.itemsHeading')}
                </h3>
                {b.recordLines.map((l, i) => (
                  <Row key={`${l.code}-${i}`} label={`${l.code} · ${l.name}`} value={rm(l.amount)} muted />
                ))}
                <p className="mt-2 text-xs text-muted-foreground">{tTxn('view.history.itemsNote')}</p>
              </div>
            )}
          </Block>

          {/* ── The document itself (r179) ──
              THE REAL FILE, not a copy of this page. `?inline=1` on the SAME route the Download button
              uses asks for the same bytes with an inline disposition, so what is previewed and what is
              downloaded cannot disagree — which the old browser-print of the web page could not promise.
              There is deliberately NO Print control here: the PDF viewer has its own, and a second one
              beside it would print the surrounding page again. The viewer shape (an iframe over an inline
              URL with a Download anchor beneath) is the knowledge-base article page's. */}
          <Card className="space-y-3 p-6 print:hidden" id="payslip-document">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('previewDocument')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('previewHint')}</p>
            <iframe
              src={`${pdfHref}?inline=1`}
              title={t('previewDocument')}
              className="h-[70vh] w-full rounded-lg border border-border"
            />
            <a
              href={pdfHref}
              download
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              {tSlip('downloadPdf')}
            </a>
          </Card>

          {/* THE PROVENANCE LINE STAYS ON THIS SCREEN (f35f758a). It came off the document and off the
              employee's own copy, because the reporter reads it as internal. It is kept here, on the
              HR-facing review screen, because it is the answer to "why did my tax change when my pay did
              not?" and whoever is checking a figure needs it. That split is the plan's, deliberately. */}
          {prov?.rulesetVersion && (
            <p className="text-xs text-muted-foreground">
              {tSlip('provenanceFooter', { ruleset: prov.rulesetVersion })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
