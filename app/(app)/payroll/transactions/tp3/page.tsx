import { Tp3DeclarationFields } from '@/components/tp3-declaration-fields';
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
    department: e.departmentLabel ?? e.department,
    departmentCode: e.departmentCode,
    departmentId: e.departmentId,
    businessUnit: e.businessUnitLabel ?? e.businessUnit,
    businessUnitCode: e.businessUnitCode,
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
  const money = (n: number | null) =>
    n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });


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

              <Tp3DeclarationFields record={record} identity={identity} selectedYear={selectedYear} mode="admin"/>
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
