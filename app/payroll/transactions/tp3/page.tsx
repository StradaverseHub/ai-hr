import Link from 'next/link';
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { tp3LineFigures } from '@/lib/tp3-line-figures';
import { listEmployees } from '@/core/read';
import {
  deriveAccumulatorSeed,
  tp3EpfReliefCap,
  getTp3ForPersonYear,
  tp3ExemptionOverLimits,
  getTp3Identity,
  listTp3YearsForPerson,
  tp3LineNumber,
  TP3_MAX_EMPLOYERS,
  TP3_SECTION_C,
  TP3_SECTION_D,
  type Tp3AccumulatorSeed,
  type Tp3Identity,
  type Tp3Record,
} from '@/packs/payroll/service';
import { amountField, employerNameField, employerTinField, subField, TP3_FORM_MARKER } from '@/lib/tp3-form-input';
import {
  Button,
  Card,
  EmployeeName,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnGhost,
  btnPrimary,
  inputCls,
  pageWideCls,
} from '@/components/ui';
import { CollapsibleEmployeePanel, EmployeeScopePanel, type ScopeEmployee } from '@/components/collapsible-employee-panel';
import { timeInKualaLumpur, todayInKualaLumpur } from '@/lib/hr-date';
import { deleteTp3Action, saveTp3Action } from './actions';

/**
 * HR Payroll → Transaction Entry → Form TP3 (item df35d60d, STAGE 1).
 *
 * ── WHAT THIS SCREEN IS FOR, AND WHAT THE REPORTER ACTUALLY ASKED ──────────────────────────────────
 *
 * A new joiner who worked elsewhere earlier in the same year hands in a TP3. Until this screen, the only
 * place to key any of it was the four opening-balance boxes on the employee's Payroll tab — and those
 * four hold C1, the C2 excess and C3 as ONE already-combined figure. The form asks for C1, C2(i)…(v) and C3 as
 * seven separate boxes, and no arithmetic recovers seven numbers from one. That is why the reporter
 * found the Previous Employment section insufficient, and it is the whole of why this screen exists.
 *
 * LAID OUT IN THE FORM'S OWN FIVE SECTIONS, in the form's own order, so somebody holding the paper TP3
 * can work down it. That was promised in the approved plan and it is the layout's only organising idea.
 *
 * ── ⚠️ SECTION C NOW MOVES THE MONTHLY DEDUCTION, AND SECTION D STILL DOES NOT ────────────────────
 *
 * Item 1bb09a73. `core/payroll.ts` still seeds the PCB accumulators from `employee_statutory_my.tp3_*`
 * — but `saveTp3` now writes those four columns from this form's Section C, so saving here DOES change
 * the monthly deduction. `stageNote` is rewritten to say exactly that, and to keep saying what is still
 * true: Section D's seventeen reliefs are captured and printed and are NOT yet read by the calculation.
 * An operator who reads the old banner and a screen that now moves money is the surprise this banner
 * exists to prevent, in whichever direction it runs.
 *
 * ── THE RECONCILIATION STRIP IS THE HONEST HALF OF THE OVERLAP ─────────────────────────────────────
 *
 * Two stores now hold previous-employment money: the four columns (authoritative for tax) and this
 * record (authoritative for the form). Rather than leave that silent, the strip prints what the
 * accumulator seed WOULD be from the boxes above — gross less exempt less EPF — beside what the tax
 * calculation is actually using. Nothing is copied in either direction and nothing refuses a save; a
 * difference is information. Stage 2 is where the two are joined, once and deliberately.
 *
 * ── RSC BOUNDARY ──────────────────────────────────────────────────────────────────────────────────
 *
 * A server component. The employee panel is the only client island and every prop crossing into it is
 * plain data. The two server actions are used as a `<form action={…}>` on SERVER-rendered forms — they
 * are never passed as props into an island, which is the boundary bug that 500s every request while
 * tsc, the suite and `next build` all stay green.
 *
 * ── ONE NAMESPACE ─────────────────────────────────────────────────────────────────────────────────
 *
 * Every caption resolves from `taxRelief`, the chrome included, and Section D's seventeen item labels
 * are `taxRelief.items.*` — THE SAME KEYS the TP1 form renders. One taxonomy, one label set, two forms.
 * A single-namespace file is also the only shape `test/i18n-coverage.test.ts` case C can check.
 */

/** One cookie per screen — the convention every sibling transaction screen follows. */
export const TP3_PANEL_COOKIE = 'txn_tp3_panel';

/** A stored figure, or null when the box was never filled. Null prints EMPTY, never `0.00`. */
const box = (v: number | undefined): string => (v == null || v === 0 ? '' : String(v));

export default async function Tp3Page({
  searchParams,
}: {
  searchParams: Promise<{
    employmentId?: string;
    year?: string;
    error?: string;
    toast?: string;
    /** Item 1bb09a73 — the assessment year that holds the payroll columns, when this save did not. */
    heldBy?: string;
    confirmDelete?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('taxRelief');
  const sp = await searchParams;

  // NARROW THE SELECTION TO THE ADMIN'S OWN COMPANY SCOPE, the way every sibling transaction screen
  // does. The database already fails closed (employment RLS routes through app.is_admin_for); this
  // makes the reachable set and the visible set the same thing.
  const employees = await listEmployees(s, scopeIds);
  const selectedEmp = (sp.employmentId ? employees.find((e) => e.employmentId === sp.employmentId) : undefined) ?? null;
  const selectedEmploymentId = selectedEmp?.employmentId ?? null;

  const panelDefaultOpen = (await cookies()).get(TP3_PANEL_COOKIE)?.value !== '0';
  const panelEmployees: ScopeEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    company: e.company,
    companyId: e.companyId,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));

  // The assessment year is a MYT calendar fact — between 00:00 and 08:00 MYT on 1 January a host-clock
  // year is still last year's (lib/hr-date.ts). Fixtures included: never `new Date().getFullYear()`.
  const currentYear = Number(todayInKualaLumpur().slice(0, 4));
  const rawYear = Number(sp.year);
  const selectedYear = Number.isInteger(rawYear) && rawYear >= 2000 && rawYear <= 2100 ? rawYear : currentYear;

  const [record, identity, recordedYears]: [Tp3Record | null, Tp3Identity | null, number[]] = selectedEmp
    ? await Promise.all([
        getTp3ForPersonYear(s, { personId: selectedEmp.personId, assessmentYear: selectedYear }),
        getTp3Identity(s, { personId: selectedEmp.personId }),
        listTp3YearsForPerson(s, { personId: selectedEmp.personId }),
      ])
    : [null, null, []];

  const yearOptions = Array.from(new Set([currentYear, selectedYear, ...recordedYears])).sort((a, b) => b - a);
  const derived: Tp3AccumulatorSeed | null = deriveAccumulatorSeed(record?.payload);
  const c = record?.payload?.sectionC ?? {};
  const d = record?.payload?.sectionD ?? {};
  /**
   * r350 — is anything keyed into a C2 sub-line that has NO sourced exemption limit?
   *
   * Read off TP3_SECTION_C, never a hardcoded ['iii','v']: the catalogue is the one owner of which
   * lines carry a limit, and a second list here would keep naming C2(iii) after LHDN published one.
   */
  const unlimitedC2Keyed = (TP3_SECTION_C.find((l) => l.code === 'c2')?.subItems ?? []).some(
    (sub) => sub.exemptionLimit == null && Number(c.c2?.subItems?.[sub.code] ?? 0) > 0,
  );
  /** Item 20837372 — the C2 boxes keyed ABOVE their statutory exemption limit. Shown, never enforced. */
  const overLimits = tp3ExemptionOverLimits(record?.payload);
  /**
   * C3's cap, from the SAME accessor `deriveAccumulatorSeed` uses (item 20837372). Never a literal:
   * a second copy of 4,000 here would disagree with the kernel the first time an agency moved it.
   */
  const epfCap = tp3EpfReliefCap();
  /** One right-aligned figure cell. Empty for null — never a dash, never 0.00. */
  const Fig = ({ v }: { v: number | null }) => (
    <span className="w-28 pt-2 text-right text-sm tabular-nums text-muted-foreground">
      {v == null ? '' : money(v)}
    </span>
  );

  // Twelve month NAMES for the deduction-month dropdown, in the request's own locale, paired with the
  // INTEGER that is stored. See the note beside the field for why the value may not become the name.
  const monthFmt = new Intl.DateTimeFormat(await getLocale(), { month: 'long' });
  const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: monthFmt.format(new Date(Date.UTC(2000, i, 1))),
  }));

  const money = (n: number | null) =>
    n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** One ruled money input. Empty when nothing was recorded — an empty box asserts nothing. */
  const MoneyInput = ({ name, value }: { name: string; value: number | undefined }) => (
    <input
      type="number"
      step="0.01"
      min="0"
      name={name}
      defaultValue={box(value)}
      className={`${inputCls} w-40 text-right tabular-nums`}
    />
  );

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('tp3.backToTransactions') }}
        title={t('tp3.title')}
        description={t('tp3.intro')}
      />

      <ErrorBanner message={sp.error} />

      {/* ⚠️ THE STAGE BANNER. BOTH SECTIONS NOW REACH THE PCB CALCULATION (item 20837372 finished what
          item 1bb09a73 started), and the banner had to change with them: it said in so many words that
          Section D was "not yet part of the PCB calculation", which from this round is false. An
          operator who keys seventeen relief lines under a banner telling them the lines change nothing
          is being actively misled about a figure that moves money. */}
      <Card className="border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
        {t('tp3.stageNote')}
      </Card>

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={TP3_PANEL_COOKIE}
        title={t('tp3.title')}
        detailHeader={
          selectedEmp ? (
            <>
              <div className="min-w-0 flex-1">
                <EmployeeName
                  code={selectedEmp.employeeCode}
                  name={selectedEmp.name}
                  className="text-sm font-semibold text-foreground"
                />
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {selectedEmp.company} · {selectedEmp.department ?? '—'}
                </p>
              </div>
              {record ? (
                <>
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={`/payroll/transactions/tp3/pdf?employmentId=${encodeURIComponent(
                        selectedEmploymentId ?? '',
                      )}&year=${selectedYear}&lang=en`}
                    >
                      {t('tp3.downloadPdf')}
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={`/payroll/transactions/tp3/pdf?employmentId=${encodeURIComponent(
                        selectedEmploymentId ?? '',
                      )}&year=${selectedYear}&lang=ms`}
                    >
                      {t('tp3.downloadPdfMs')}
                    </Link>
                  </Button>
                </>
              ) : null}
            </>
          ) : undefined
        }
        panel={
          <Card className="p-4">
            <h2 className="text-sm font-semibold">{t('tp3.title')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('tp3.selectEmployeePrompt')}</p>
            <div className="mt-3">
              <EmployeeScopePanel
                employees={panelEmployees}
                selectedId={selectedEmploymentId}
                basePath="/payroll/transactions/tp3"
                preserve={{ year: String(selectedYear) }}
              />
            </div>
          </Card>
        }
      >
        {selectedEmp && identity ? (
          <div className="space-y-6">
            {/* ── Year selector. A plain GET form, so the selection lives in the URL and the server
                   owns it — a value the browser owns is a value the browser can change. ── */}
            <Card className="p-4">
              <form method="GET" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="employmentId" value={selectedEmp.employmentId} />
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">{t('yearLabel')}</span>
                  <select name="year" defaultValue={String(selectedYear)} className={inputCls}>
                    {yearOptions.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className={btnGhost}>
                  {t('viewYear')}
                </button>
                {record ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t('tp3.lastSaved', { at: timeInKualaLumpur(record.updatedAt) })}
                  </span>
                ) : (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t('tp3.noRecordYet', { year: selectedYear })}
                  </span>
                )}
              </form>
            </Card>

            <form action={saveTp3Action} className="space-y-6">
              <input type="hidden" name="tp3Form" value={TP3_FORM_MARKER} />
              <input type="hidden" name="employmentId" value={selectedEmp.employmentId} />
              <input type="hidden" name="assessmentYear" value={selectedYear} />

              {/* ── The form's own DEDUCTION MONTH / DEDUCTION YEAR boxes ── */}
              <Card className="p-4">
                <div className="flex flex-wrap gap-6">
                  {/* ── DEDUCTION MONTH — A NAMED MONTH, STORING THE SAME INTEGER (item 20837372) ──
                      The reporter asked for a dropdown of month names instead of a number, and they are
                      right that "3" is a poor thing to ask somebody holding a paper form for. What the
                      value MUST stay is an integer: `core/tp3.ts` `validateMonth` parses 1–12 and
                      `app/payroll/transactions/tp1/[year]/[month]/page.tsx` matches on
                      `r.deductionMonth === month`. A named value here would match nothing there and the
                      declaration would silently stop opening on its own month, so the option VALUE is
                      the number and only the LABEL is the name.

                      Names come from Intl in the request's own locale, resolved on the SERVER — the
                      same decision `app/payroll/transactions/tp1/page.tsx` records: twelve names in six
                      locales would be six copies of the calendar in the message catalogue, and the
                      catalogue check cannot tell a wrong month name from a right one. */}
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">{t('deductionMonthLabel')}</span>
                    <select
                      name="deductionMonth"
                      defaultValue={record?.deductionMonth == null ? '' : String(record.deductionMonth)}
                      className={`${inputCls} w-44`}
                    >
                      {/* Blank stays reachable: `validateMonth` stores null for "left blank", which is
                          not the same fact as January and must not become it. */}
                      <option value="">{t('tp3.deductionMonthBlank')}</option>
                      {MONTH_OPTIONS.map((m) => (
                        <option key={m.value} value={String(m.value)}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="block text-sm">
                    <span className="mb-1 block font-medium">{t('deductionYearLabel')}</span>
                    <p className="flex h-9 items-center text-sm tabular-nums">{selectedYear}</p>
                  </div>
                </div>
              </Card>

              {/* ── SECTION A ─────────────────────────────────────────────────────────────────── */}
              <Card>
                <SectionHeader title={t('tp3.sectionA')} />
                <div className="space-y-3 p-4">
                  {/* EXACTLY the pairs the form is ruled for. The count comes from the pack, never from
                      a literal here — the form's own footnote sends the next employment to an
                      attachment, and the note below says so rather than the screen inventing a limit. */}
                  {Array.from({ length: TP3_MAX_EMPLOYERS }, (_, i) => {
                    const e = record?.previousEmployers[i];
                    return (
                      <div key={i} className="flex flex-wrap items-end gap-3">
                        <label className="block flex-1 text-sm">
                          <span className="mb-1 block font-medium">
                            A{i * 2 + 1} · {t('tp3.employerNameSlot', { n: i + 1 })}
                          </span>
                          <input name={employerNameField(i + 1)} defaultValue={e?.name ?? ''} className={inputCls} />
                        </label>
                        <label className="block w-64 text-sm">
                          <span className="mb-1 block font-medium">
                            A{i * 2 + 2} · {t('tp3.employerTinSlot')}
                          </span>
                          <input name={employerTinField(i + 1)} defaultValue={e?.tin ?? ''} className={inputCls} />
                        </label>
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground">{t('tp3.sectionAFootnote')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('tp3.maxEmployersNote', { max: TP3_MAX_EMPLOYERS })}
                  </p>
                </div>
              </Card>

              {/* ── SECTION B — read-only: this is the employee record, not a second copy of it ── */}
              <Card>
                <SectionHeader title={t('tp3.sectionB')} />
                <dl className="grid gap-3 p-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">B1 · {t('employeeName')}</dt>
                    <dd className="font-medium">{identity.employee.name}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">B2 · {t('employeeIdNumber')}</dt>
                    {/* An absent identity number prints an em dash and asserts nothing. */}
                    <dd className="font-medium">{identity.employee.idNumber ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">B3 · {t('employeeTin')}</dt>
                    <dd className="font-medium">{identity.employee.tin ?? '—'}</dd>
                  </div>
                </dl>
              </Card>

              {/* ── SECTION C — the boxes the old single column could not be taken apart into ── */}
              <Card>
                <SectionHeader title={t('tp3.sectionC')} subtitle={t('tp3.sectionCHelp')} />
                <div className="space-y-4 p-4">
                  {/* ── THE EXEMPTION-LIMIT COLUMN (item 20837372) ──────────────────────────────────
                      The reporter asked to see each C2 allowance's own exemption limit beside it, and
                      they were right that a screen showing five bare boxes says nothing about how much
                      of each one may be exempt at all.

                      ⚠️ IT IS HEADED DIFFERENTLY FROM SECTION D'S, ON PURPOSE. Section D's "Annual
                      limit" column is printed on the form itself (`HAD TAHUNAN (RM)`) and the service
                      REFUSES a figure above it. Section C has no limit column on the form at all — one
                      money column, `AMAUN TERKUMPUL (RM)` — so these figures come from the MTD
                      specification's own table (printed page 21) and are guidance for the person
                      keying, never a rule the save enforces. The note below says so in the operator's
                      own words rather than leaving them to infer it from a column heading. */}
                  <p className="text-xs text-muted-foreground">{t('tp3.exemptLimitNote')}</p>
                  <div className="flex flex-wrap justify-end gap-3 text-xs uppercase tracking-wide text-muted-foreground">
                    <span className="w-28 text-right">{t('tp3.colExemptionLimit')}</span>
                    <span className="w-28 text-right">{t('tp3.colTaxExempt')}</span>
                    <span className="w-28 text-right">{t('tp3.colExcess')}</span>
                    <span className="w-28 text-right">{t('tp3.colRemaining')}</span>
                    <span className="w-40 text-right">{t('colAccumulated')}</span>
                  </div>
                  {TP3_SECTION_C.map((line, i) => {
                    const stored = c[line.code];
                    const n = i + 1;
                    return (
                      <div key={line.code} className="border-b border-border pb-3 last:border-0 last:pb-0">
                        <div className="flex flex-wrap items-start gap-3">
                          <span className="w-8 shrink-0 pt-2 text-sm font-semibold">C{n}</span>
                          <p className="min-w-0 flex-1 pt-2 text-sm">{t(`tp3.money.${line.code}.label`)}</p>
                          {line.subItems.length === 0 ? (
                            <>
                              {/* C1 and C5 carry no limit — gross pay and PCB already paid are not
                                  exemptions, so every cell is EMPTY rather than a dash: an absent box
                                  asserts nothing, and a dash would read as "no limit applies".

                                  ⚠️ C3 IS DIFFERENT AND USED TO BE DRAWN HERE AS IF IT WERE NOT. It is
                                  held to the EPF relief cap by `deriveAccumulatorSeed` — the reporter's
                                  own row keyed 8,979 against a 4,000 cap — and until item 20837372 this
                                  branch printed an empty limit cell beside it, so the single largest
                                  capping on the form was the one thing the screen never mentioned. */}
                              {(() => {
                                const lim = line.code === 'c3' ? epfCap : null;
                                const r = tp3LineFigures(stored?.amount, lim);
                                return (
                                  <>
                                    <span className="w-28 pt-2 text-right text-sm tabular-nums text-muted-foreground">
                                      {lim == null ? '' : money(lim)}
                                    </span>
                                    <Fig v={lim == null ? null : r.exempt} />
                                    <Fig v={r.excess} />
                                    <Fig v={r.remaining} />
                                  </>
                                );
                              })()}
                              <MoneyInput name={amountField('c', line.code)} value={stored?.amount} />
                            </>
                          ) : null}
                        </div>
                        {line.subItems.map((sub) => {
                          const over = overLimits.find((o) => o.code === line.code && o.subCode === sub.code);
                          return (
                            <div key={sub.code} className="mt-2 flex flex-wrap items-start gap-3 pl-11">
                              <span className="w-8 shrink-0 pt-2 text-xs text-muted-foreground">{sub.code})</span>
                              <div className="min-w-0 flex-1 pt-2">
                                <p className="text-sm">{t(`tp3.money.${line.code}.sub.${sub.code}`)}</p>
                                {/* The restriction the form states in words. Captured and printed, never
                                    enforced — enforcing it needs a claim history LHDN holds and we do not. */}
                                {sub.frequency ? (
                                  <p className="text-xs text-muted-foreground">{t(`frequency.${sub.frequency}`)}</p>
                                ) : null}
                                {/* ⚠️ A WARNING, AND THE KEYED FIGURE IS STILL LEFT EXACTLY AS IT IS.
                                    Since r350 the part ABOVE this limit is ADDED to Accumulated Net
                                    Remuneration as taxable pay, which is what the specification's
                                    printed page 20 item 9 requires ("Any amount exceed the restricted
                                    amount shall be taxable"). C1 holds only the TAXABLE items — the
                                    form's own caption says so — so the excess was never in C1 and
                                    cannot be reached by subtracting less; see core/tp3.ts
                                    `deriveAccumulatorSeed` for the full evidence.
                                    THE MESSAGE CHANGED WITH THE RULE. It used to end by telling the
                                    operator the form was probably filled wrong. An over-limit box is
                                    not a keying error — the previous employer may pay more than the
                                    exempt limit — so `tp3.exemptOverLimit` now names the tax
                                    consequence instead, retired key and all, in six locales. The INPUT
                                    is still never refused (ADR-0008). */}
                                {over ? (
                                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                                    {t('tp3.exemptOverLimit', {
                                      limit: money(over.limit),
                                      excess: money(over.excess),
                                    })}
                                  </p>
                                ) : null}
                              </div>
                              <span className="w-28 pt-2 text-right text-sm tabular-nums text-muted-foreground">
                                {sub.exemptionLimit == null ? t('noLimit') : money(sub.exemptionLimit)}
                              </span>
                              {(() => {
                                const r = tp3LineFigures(stored?.subItems?.[sub.code], sub.exemptionLimit);
                                return (
                                  <>
                                    <Fig v={r.exempt} />
                                    <Fig v={r.excess} />
                                    <Fig v={r.remaining} />
                                  </>
                                );
                              })()}
                              <MoneyInput
                                name={subField('c', line.code, sub.code)}
                                value={stored?.subItems?.[sub.code]}
                              />
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}

                  {/* ── HOW ACCUMULATED NET REMUNERATION IS REACHED ──────────────────────────────
                      ⚠️ THIS BLOCK HAS NOW BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND BOTH ARE RECORDED.

                      r345 printed two rows labelled "counted" under a sentence saying the exempt amount
                      "counts towards" ANR, when it was being SUBTRACTED. r348 corrected the words and
                      drew the subtraction with explicit minus signs — and the subtraction itself was the
                      defect. C1 holds only the TAXABLE items ("…YANG DIKENAKAN CUKAI" on the agency's own
                      form), so the exempt allowances were never in C1 and taking them off removed money
                      that was not there. The reporter said so five times; see core/tp3.ts
                      `deriveAccumulatorSeed` for the five independent sources that settle it.

                      It is now the sum the form actually describes: gross, PLUS the part of C2 above its
                      statutory limit (taxable, and not in C1), LESS C3. The exempt total moves out of the
                      arithmetic and into a note, because it explains the figure without being part of it.

                      Every figure is still READ OFF THE SEED and never recomputed: `gross`, `excessTotal`
                      and `epfAllowable` are the same fields `core/tp3.ts` strikes `netRemuneration`
                      against, so these rows cannot drift from the arithmetic they report. Two call sites
                      each working the limits out is the duplicate source of truth §1 forbids.

                      Absent when nothing is keyed yet: a form with no figures has no total, and printing
                      0.00 would assert one. */}
                  {derived ? (
                    <div className="mt-4 space-y-1 border-t-2 border-border pt-3 text-sm" data-anr-working>
                      <div className="flex flex-wrap justify-between gap-2">
                        <span>{t('tp3.totalGross')}</span>
                        <span className="tabular-nums" data-anr-gross>{money(derived.gross)}</span>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-1">
                        <span className="text-muted-foreground">{t('tp3.totalPlusExcess')}</span>
                        <span className="tabular-nums text-muted-foreground" data-anr-plus-excess>
                          + {money(derived.excessTotal)}
                        </span>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-muted-foreground">{t('tp3.totalLessEpf')}</span>
                        <span className="tabular-nums text-muted-foreground" data-anr-less-epf>
                          &minus; {money(derived.epfAllowable)}
                        </span>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2 border-t-2 border-border pt-1 font-semibold">
                        <span>{t('tp3.totalNetRemuneration')}</span>
                        <span className="tabular-nums" data-anr-net>{money(derived.netRemuneration)}</span>
                      </div>
                      {/* THE EXEMPT TOTAL EXPLAINS THE SUM WITHOUT BEING PART OF IT. It is the money
                          that is genuinely exempt, so it is neither added nor subtracted — saying that
                          in words is the whole point, because for five contests running this screen
                          implied otherwise. Shown only when something is keyed in C2. */}
                      {derived.exemptTotal > 0 ? (
                        <p className="pt-1 text-xs text-muted-foreground" data-anr-exempt-note>
                          {t('tp3.totalExemptNote', {
                            entered: money(derived.exemptEntered),
                            exempt: money(derived.exemptTotal),
                            excess: money(derived.excessTotal),
                          })}
                        </p>
                      ) : null}
                      {/* C2(iii) and C2(v) have no sourced limit, so no excess can be PROVEN for them.
                          Named only when one of them actually carries a figure — CLAUDE.md §8: an absent
                          box asserts nothing, and a caption about a box nobody used asserts something. */}
                      {unlimitedC2Keyed ? (
                        <p className="pt-1 text-xs text-muted-foreground" data-anr-nolimit-note>
                          {t('tp3.totalNoLimitNote')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </Card>

              {/* ── SECTION D — THE SHARED RELIEF SCHEDULE. Labels and limits come from the SAME pack
                     catalogue and the SAME message keys the TP1 form uses; only the printed number
                     differs (C1–C17 there, D1–D17 here). ── */}
              <Card>
                <SectionHeader title={t('tp3.sectionD')} subtitle={t('tp3.sectionDHelp')} />
                <div className="space-y-4 p-4">
                  <div className="flex justify-end gap-6 text-xs uppercase tracking-wide text-muted-foreground">
                    <span className="w-40 text-right">{t('colAnnualLimit')}</span>
                    <span className="w-40 text-right">{t('colAccumulated')}</span>
                  </div>
                  {TP3_SECTION_D.map((item) => {
                    const stored = d[item.code];
                    const n = tp3LineNumber(item.code);
                    return (
                      <div key={item.code} className="border-b border-border pb-3 last:border-0 last:pb-0">
                        <div className="flex flex-wrap items-start gap-3">
                          <span className="w-8 shrink-0 pt-2 text-sm font-semibold">D{n}</span>
                          <div className="min-w-0 flex-1 pt-2">
                            <p className="text-sm">{t(`items.${item.code}.label`)}</p>
                            {item.frequency ? (
                              <p className="text-xs text-muted-foreground">{t(`frequency.${item.frequency}`)}</p>
                            ) : null}
                          </div>
                          {/* A perSubLimit item (D16) has NO group limit and NO group box: the form gives
                              each house-price band its own limit and its own accumulated row. */}
                          {item.perSubLimit ? null : (
                            <>
                              <span className="w-40 pt-2 text-right text-sm tabular-nums text-muted-foreground">
                                {item.limit == null ? t('noLimit') : money(item.limit)}
                              </span>
                              {item.subItems.length === 0 ? (
                                <MoneyInput name={amountField('d', item.code)} value={stored?.amount} />
                              ) : (
                                <span className="w-40 pt-2 text-right text-sm tabular-nums">
                                  {stored?.amount ? money(stored.amount) : ''}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                        {item.subItems.map((sub) => (
                          <div key={sub.code} className="mt-2 flex flex-wrap items-start gap-3 pl-11">
                            <span className="w-8 shrink-0 pt-2 text-xs text-muted-foreground">{sub.code})</span>
                            <p className="min-w-0 flex-1 pt-2 text-sm">{t(`items.${item.code}.sub.${sub.code}`)}</p>
                            <span className="w-40 pt-2 text-right text-sm tabular-nums text-muted-foreground">
                              {sub.limit == null ? '' : money(sub.limit)}
                            </span>
                            <MoneyInput
                              name={subField('d', item.code, sub.code)}
                              value={stored?.subItems?.[sub.code]}
                            />
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* ── SECTION E ──────────────────────────────────────────────────────────────────── */}
              <Card>
                <SectionHeader title={t('tp3.sectionE')} />
                <div className="space-y-3 p-4">
                  <p className="text-sm">{t('declarationText')}</p>
                  {/* RULE 17 — the hidden `no` goes FIRST and the checkbox contributes `yes`, so the
                      reader can ask whether 'yes' is among the values. A hidden input is always
                      submitted, so presence can never answer this. */}
                  <input type="hidden" name="declarationAccepted" value="no" />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="declarationAccepted"
                      value="yes"
                      defaultChecked={record?.declaredAt != null}
                      className="size-4"
                    />
                    {t('tp3.declarationTick')}
                  </label>
                  {record?.declaredAt ? (
                    <p className="text-xs text-muted-foreground">
                      {t('declaredOn', { at: timeInKualaLumpur(record.declaredAt) })}
                    </p>
                  ) : null}
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">{t('remarksLabel')}</span>
                    <textarea
                      name="remarks"
                      defaultValue={record?.remarks ?? ''}
                      rows={2}
                      className={`${inputCls} h-auto`}
                    />
                  </label>
                </div>
              </Card>

              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" className={btnPrimary}>
                  {t('tp3.save')}
                </button>
                {sp.toast === 'saved' ? <span className="text-sm text-emerald-600">{t('tp3.saved')}</span> : null}
                {/* Item 1bb09a73 — the save landed but the four payroll figures did NOT move, because a
                    LATER assessment year holds them. AMBER, not green, and it names the year: a "Saved"
                    that quietly did not reach the tax calculation is the defect this item removes. */}
                {sp.toast === 'savedFormOnly' ? (
                  <span className="text-sm text-amber-700 dark:text-amber-400">
                    {t('tp3.savedFormOnly', { year: Number(sp.heldBy) })}
                  </span>
                ) : null}
                {sp.toast === 'deleted' ? <span className="text-sm text-emerald-600">{t('tp3.deleted')}</span> : null}
              </div>
            </form>

            {/* ── The reconciliation strip. READ-ONLY, and outside the save form on purpose: nothing
                   here is a field, and nothing here is written. ── */}
            <Card>
              <SectionHeader title={t('tp3.reconcileHeading')} subtitle={t('tp3.reconcileNote')} />
              <div className="p-4">
                {identity.stored.tp3Year == null ? (
                  <p className="text-sm text-muted-foreground">{t('tp3.reconcileNoStored')}</p>
                ) : identity.stored.tp3Year !== selectedYear ? (
                  <p className="text-sm text-muted-foreground">
                    {t('tp3.reconcileStoredOtherYear', { year: identity.stored.tp3Year })}
                  </p>
                ) : null}
                <table className="mt-3 w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="py-1 font-medium"> </th>
                      <th className="py-1 text-right font-medium">{t('tp3.reconcileDerived')}</th>
                      <th className="py-1 text-right font-medium">{t('tp3.reconcileStored')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(
                      [
                        ['reconcileNet', derived?.netRemuneration ?? null, identity.stored.netRemuneration],
                        ['reconcileEpf', derived?.epfClaimed ?? null, identity.stored.epfClaimed],
                        ['reconcilePcb', derived?.pcbPaid ?? null, identity.stored.pcbPaid],
                        ['reconcileZakat', derived?.zakatPaid ?? null, identity.stored.zakatPaid],
                        // ∑LP — Section D (item 20837372). FIFTH ROW, because there are now five
                        // opening-balance figures, and this is the one an operator has never been able
                        // to see. The specification asks for it in as many words on printed page 28:
                        // "System must show cumulative and current month deduction amount for the
                        // purpose of audit" — the current month's LP₁ is on the PCB detail screen
                        // beside ΣLP; this is the previous employment's half of the cumulative one.
                        ['reconcileLp', derived?.lpDeclared ?? null, identity.stored.lp],
                      ] as const
                    ).map(([key, from, stored]) => (
                      <tr key={key}>
                        <td className="py-1.5">{t(`tp3.${key}`)}</td>
                        <td className="py-1.5 text-right tabular-nums">{money(from)}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {money(identity.stored.tp3Year === selectedYear ? stored : null)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {record ? (
              <Card>
                <div className="flex flex-wrap items-center gap-3 p-4">
                  {sp.confirmDelete === '1' ? (
                    <form action={deleteTp3Action} className="flex flex-wrap items-center gap-3">
                      <input type="hidden" name="employmentId" value={selectedEmp.employmentId} />
                      <input type="hidden" name="assessmentYear" value={selectedYear} />
                      <div>
                        <p className="text-sm font-medium">{t('tp3.confirmDeleteTitle')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('tp3.confirmDeleteBody', { year: selectedYear })}
                        </p>
                      </div>
                      <button type="submit" className={btnPrimary}>
                        {t('tp3.confirmDeleteYes')}
                      </button>
                      <Link
                        href={`/payroll/transactions/tp3?employmentId=${encodeURIComponent(
                          selectedEmp.employmentId,
                        )}&year=${selectedYear}`}
                        className={btnGhost}
                      >
                        {t('tp3.cancel')}
                      </Link>
                    </form>
                  ) : (
                    <Link
                      href={`/payroll/transactions/tp3?employmentId=${encodeURIComponent(
                        selectedEmp.employmentId,
                      )}&year=${selectedYear}&confirmDelete=1`}
                      className={btnGhost}
                    >
                      {t('tp3.deleteRecord')}
                    </Link>
                  )}
                </div>
              </Card>
            ) : null}
          </div>
        ) : (
          <Card className="p-6">
            <p className="text-sm text-muted-foreground">{t('tp3.selectEmployeePrompt')}</p>
          </Card>
        )}
      </CollapsibleEmployeePanel>
    </div>
  );
}
