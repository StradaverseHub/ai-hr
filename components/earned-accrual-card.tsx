'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { toCsv } from '@/lib/csv';
import { Button, Field, inputCls } from './ui';
import { MultiSelectPopover } from './ui/multi-select-popover';
import { runEarnedAccrualAction } from '@/app/admin/actions';
// feedback cf9dcb98 — the preview comes from the screen's own action, which forwards the engine's named
// reason; the COMMIT is unchanged and still posts through app/admin/actions.ts. See that file's header.
import { previewEarnedAccrualWithReasonAction } from '@/app/admin/leave-config/earned-accrual/actions';
import type { ArchivedLeaveTypeHint, EarnedAccrualEmptyReason, EarnedAccrualGroup } from '@/core/leave';

export type EarnedScopeOption = { id: string; name: string };
/**
 * r293 — THE LEAVE-TYPE AXIS CARRIES ONE FACT THE OTHER TWO DO NOT, and it is REQUIRED rather than
 * optional on purpose: a picker that cannot answer "would a run ever look at this type" is the state
 * this round exists to remove, and an optional flag defaulting to `true` would quietly restore it on
 * the next call site.
 *
 * `swept` is decided on the SERVER against the engine's own `STANDING_LEAVE_CODES`
 * (app/admin/leave-config/earned-accrual/page.tsx) and crosses as a plain boolean. This card may not
 * import `core/leave` — it is a client island and that module opens the database connection — so it
 * neither knows nor re-derives which codes are swept; it only marks what it is handed.
 */
export type EarnedLeaveTypeOption = EarnedScopeOption & { swept: boolean };
export type EarnedLeaveYearOption = { year: number; status: string };

/**
 * feedback 2c7c6385 — "Run Earned Accrual" review card. Wraps the shipped, idempotent accrual engine with
 * the missing front-of-house: pick a SCOPE (Company / Leave Year / Leave Type / Grade), PREVIEW a grouped
 * summary table (a dry-run that writes nothing yet reports the exact numbers the commit will produce), then
 * Run / Cancel / Export. Mirrors the FestiveGrantCard client pattern (multi-select popovers + useTransition
 * + toast + router.refresh). Empty selection on any axis ⇒ "all" on that axis. Export is a client-side CSV
 * (toCsv guards CSV injection).
 *
 * 4b0e76ae — THE LEAVE-YEAR SELECTOR NO LONGER READS ANY TABLE. It used to be fed from the managed
 * leave_year_config records (9aa894a4); that module was removed, so the page now hands it the ONE shared
 * computed range (core/leave.ts `entitlementYearOptions`, currentYear − 3 .. currentYear + 6). The prop
 * SHAPE is unchanged and `status` is informational only — this card renders the year and nothing else —
 * so every computed year arrives as 'draft', exactly what the old empty-config fallback produced.
 */
export function EarnedAccrualCard({
  companies,
  grades,
  leaveTypes,
  sweptLeaveTypeNames,
  leaveYears,
  defaultYear,
}: {
  /** Already narrowed by the page to the companies this admin administers (RLS re-enforces server-side). */
  companies: EarnedScopeOption[];
  grades: EarnedScopeOption[];
  /** r293 — every ACTIVE leave type, each carrying whether this sweep can reach it. See the type. */
  leaveTypes: EarnedLeaveTypeOption[];
  /**
   * r293 — ⚠️ THE TENANT'S OWN NAMES for the swept types that are ACTIVE, A–Z: the same rows, the same
   * filter and the same order the engine's `type_not_swept` empty state reads, and the same list the
   * leave type editor's r288 warning is built from. NEVER the English defaults — the three standing
   * codes carry whatever name the tenant gave them, and the account that raised this holds two leave
   * types both called some variant of Annual Leave, so a hardcoded name would print a riddle on the
   * very account it was written for. EMPTY when the tenant has archived all three, which is that
   * account's actual state and why the empty case has a sentence of its own.
   */
  sweptLeaveTypeNames: string[];
  /** The entitlement-year list, oldest first — the shared computed range (see the header). */
  leaveYears: EarnedLeaveYearOption[];
  defaultYear: number;
}) {
  const t = useTranslations('admin.leave');
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number>(defaultYear);
  const [companyIds, setCompanyIds] = useState<Set<string>>(new Set());
  const [gradeIds, setGradeIds] = useState<Set<string>>(new Set());
  const [leaveTypeIds, setLeaveTypeIds] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<EarnedAccrualGroup[] | null>(null);
  const [previewAsOf, setPreviewAsOf] = useState<string | null>(null);
  // feedback cf9dcb98 — the engine's own account of an empty preview. Held exactly as it arrived: this
  // component derives nothing from it beyond choosing which sentence to render, because the moment a
  // screen starts recomputing "why was this empty" it is free to disagree with the engine that decided it.
  const [emptyReason, setEmptyReason] = useState<EarnedAccrualEmptyReason | null>(null);
  const [archivedHint, setArchivedHint] = useState<ArchivedLeaveTypeHint[]>([]);
  const [earnedToDateTotal, setEarnedToDateTotal] = useState(0);
  // Once a real run commits, flip the table's Status column from Pending → Done (until the next preview).
  const [committed, setCommitted] = useState(false);

  const scope = useMemo(
    () => ({ year, companyIds: [...companyIds], gradeIds: [...gradeIds], leaveTypeIds: [...leaveTypeIds] }),
    [year, companyIds, gradeIds, leaveTypeIds],
  );

  // bc36c768 — three branches, because the else-was-monthly fallback this replaces would have labelled
  // every earned_daily row "Monthly accrual" on the Accrual Process preview: a table that tells HR the
  // wrong cadence for the run they are about to commit.
  const methodLabel = (m: string) =>
    m === 'earned_quarterly'
      ? t('earnedMethodQuarterly')
      : m === 'earned_daily'
        ? t('earnedMethodDaily')
        : t('earnedMethodMonthly');

  const onPreview = () =>
    start(async () => {
      setError(null);
      setCommitted(false);
      const res = await previewEarnedAccrualWithReasonAction(scope);
      if (res.error) {
        setError(res.error);
        setRows(null);
        return;
      }
      setRows(res.rows ?? []);
      setPreviewAsOf(res.asOf ?? null);
      setEmptyReason(res.emptyReason ?? null);
      setArchivedHint(res.archivedHint ?? []);
      setEarnedToDateTotal(res.earnedToDateTotal ?? 0);
    });

  const onRun = () =>
    start(async () => {
      setError(null);
      const res = await runEarnedAccrualAction(scope);
      if (res.error) {
        setError(res.error);
        return;
      }
      toast.success(t('earnedRunToast', { granted: res.granted ?? 0, forfeits: res.forfeits ?? 0 }));
      setCommitted(true);
      router.refresh();
    });

  const onCancel = () => {
    setRows(null);
    setError(null);
    setCommitted(false);
    setPreviewAsOf(null);
    setEmptyReason(null);
    setArchivedHint([]);
    setEarnedToDateTotal(0);
  };

  const onExport = () => {
    if (!rows) return;
    const statusLabel = committed ? t('earnedStatusDone') : t('earnedStatusPending');
    const header = [
      t('earnedColCompany'),
      t('earnedColGrade'),
      t('earnedColCount'),
      t('earnedColType'),
      t('earnedColPeriod'),
      t('earnedColMethod'),
      t('earnedColEntitlement'),
      t('earnedColStatus'),
    ];
    // toCsv runs every cell through csvSafeCell → a leading =/+/-/@ value can never execute on open.
    const body = rows.map((r) => [
      r.companyName,
      r.gradeName ?? t('earnedGradeUngraded'),
      r.employeeCount,
      r.leaveTypeName,
      r.accrualPeriod,
      methodLabel(r.method),
      r.entitlementGenerated,
      statusLabel,
    ]);
    const csv = toCsv([header, ...body]);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `earned-accrual-preview-${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalEntitlement = useMemo(
    () => (rows ? Math.round(rows.reduce((s, r) => s + r.entitlementGenerated, 0) * 100) / 100 : 0),
    [rows],
  );

  /**
   * r293 — THE TYPES THIS SCREEN IS OFFERING BUT CAN NEVER ACCRUE.
   *
   * The page hands over every ACTIVE leave type, swept or not (`listLeaveTypes(s, { includeArchived:
   * false })`), because the scope filter is legitimately over all of them. `accrueEarnedLeave` then
   * filters `code IN STANDING_LEAVE_CODES` BEFORE it reads a single employment, so picking one of the
   * others has always produced an empty preview — the r285 `type_not_swept` sentence — only AFTER the
   * operator spent a run finding out. This is that same fact, moved to where the choice is made.
   *
   * NOTHING IS RE-DERIVED HERE: `swept` was decided on the server against the engine's own constant, and
   * this is a partition of the list it arrived in, in the order it arrived in. A client-side rule about
   * which codes accrue would be a second answer to a question the engine already owns.
   */
  const notSweptNames = useMemo(
    () => leaveTypes.filter((o) => !o.swept).map((o) => o.name),
    [leaveTypes],
  );
  const notSweptIds = useMemo(
    () => new Set(leaveTypes.filter((o) => !o.swept).map((o) => o.id)),
    [leaveTypes],
  );

  /**
   * feedback cf9dcb98 — names, joined the way the reader's language joins a list ("A, B and C"), not with
   * a hardcoded comma. Every reason below names leave types, grades, companies or countries, and a list of
   * names is the whole point of the change: a count would leave the administrator exactly where the old
   * flat sentence left them.
   */
  const nameList = (names: string[]) =>
    new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);

  /**
   * feedback cf9dcb98 — THE EMPTY PREVIEW, EXPLAINED. One `switch` over the engine's own discriminant, and
   * NOTHING is recomputed here: each branch only chooses the sentence and hands the engine's values to it.
   * `null` — a scope pointing at leave types this tenant does not have — falls back to the flat sentence
   * this whole item exists to replace, which is the one case where it is still the honest answer.
   */
  const emptyMessage = (): string => {
    const r = emptyReason;
    if (!r) return t('earnedPreviewEmpty');
    switch (r.kind) {
      case 'type_not_swept':
        return r.sweptLeaveTypeNames.length
          ? t('earnedEmptyNotSwept', {
              types: nameList(r.leaveTypeNames),
              swept: nameList(r.sweptLeaveTypeNames),
            })
          : t('earnedEmptyNotSweptNoneActive', { types: nameList(r.leaveTypeNames) });
      case 'type_archived':
        return t('earnedEmptyTypeArchived', { types: nameList(r.leaveTypeNames) });
      case 'table_not_yet_in_force':
        return t('earnedEmptyTableNotYetInForce', {
          type: r.leaveTypeName,
          validFrom: r.validFrom,
          asOf: r.asOf,
        });
      case 'no_entitlement_table':
        return t('earnedEmptyNoTable', { types: nameList(r.leaveTypeNames), asOf: r.asOf });
      case 'type_not_earned':
        return t('earnedEmptyNotEarned', { types: nameList(r.leaveTypeNames) });
      case 'no_employment_in_scope':
        return r.scopeNames.length
          ? t('earnedEmptyNoEmployment', { scope: nameList(r.scopeNames), asOf: r.asOf })
          : t('earnedEmptyNoEmploymentAll', { asOf: r.asOf });
      case 'no_eligibility_match':
        return t('earnedEmptyNoEligibilityMatch', { types: nameList(r.leaveTypeNames) });
      case 'country_pack_inactive':
        return t('earnedEmptyPackInactive', { countries: nameList(r.countries) });
      case 'balance_frozen':
        return t('earnedEmptyFrozen', { types: nameList(r.leaveTypeNames) });
    }
  };

  return (
    <div className="space-y-4 px-4 py-3">
      <p className="max-w-2xl text-xs text-muted-foreground">{t('earnedAccrualHelp')}</p>
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}

      {/* Step 1 — Select Scope. */}
      <div className="flex flex-wrap items-end gap-3">
        <MultiSelectPopover
          label={t('earnedScopeCompany')}
          allLabel={t('earnedAllCompanies')}
          options={companies}
          selected={companyIds}
          onChange={setCompanyIds}
          searchPlaceholder={t('earnedSearchPlaceholder')}
          selectAllLabel={t('multiSelectSelectAll')}
          clearAllLabel={t('multiSelectClearAll')}
          selectedCount={(n) => t('multiSelectSelectedCount', { count: n })}
        />
        <Field label={t('earnedScopeLeaveYear')}>
          <select
            value={String(year)}
            onChange={(e) => setYear(Number(e.target.value))}
            className={`${inputCls} w-28`}
          >
            {leaveYears.map((y) => (
              <option key={y.year} value={y.year}>
                {y.year}
              </option>
            ))}
          </select>
        </Field>
        <MultiSelectPopover
          label={t('earnedScopeLeaveType')}
          allLabel={t('earnedAllTypes')}
          options={leaveTypes}
          selected={leaveTypeIds}
          onChange={setLeaveTypeIds}
          searchPlaceholder={t('earnedSearchPlaceholder')}
          selectAllLabel={t('multiSelectSelectAll')}
          clearAllLabel={t('multiSelectClearAll')}
          selectedCount={(n) => t('multiSelectSelectedCount', { count: n })}
          /* r293 — ⚠️ MARK, DO NOT REMOVE AND DO NOT DISABLE. The row stays selectable and the scope it
             posts is byte-identical, so the engine's typed empty reason remains the authority on why a
             run found nothing; dropping the row would replace one silence with another and would also
             hide the very type the reporter came looking for. This is the LEAVE-TYPE picker only — the
             company and grade pickers above and below pass no note. */
          optionNote={(o) => (notSweptIds.has(o.id) ? t('earnedTypeNotCoveredTag') : null)}
        />
        <MultiSelectPopover
          label={t('earnedScopeGrade')}
          allLabel={t('earnedAllGrades')}
          options={grades}
          selected={gradeIds}
          onChange={setGradeIds}
          searchPlaceholder={t('earnedSearchPlaceholder')}
          selectAllLabel={t('multiSelectSelectAll')}
          clearAllLabel={t('multiSelectClearAll')}
          selectedCount={(n) => t('multiSelectSelectedCount', { count: n })}
        />
        <Button type="button" size="sm" onClick={onPreview} disabled={pending}>
          {pending && rows === null ? t('earnedPreviewingButton') : t('earnedPreviewButton')}
        </Button>
      </div>

      {/* r293 — the marker in the closed picker is two words; this is what those two words mean, and it is
          deliberately the SAME SENTENCE the leave type editor shows while the administrator is setting the
          earning method (r288, admin.leave.subStep.earningNotSwept). Two screens describing one boundary
          in two different sets of words is how the reporter came to be told the wrong reason twice.
          Rendered only when there is something to name — a permanent banner is furniture. */}
      {notSweptNames.length > 0 && (
        <p data-testid="earned-types-not-swept" className="max-w-2xl text-xs text-amber-600 dark:text-amber-400">
          {sweptLeaveTypeNames.length
            ? t('earnedTypesNotSwept', {
                types: nameList(notSweptNames),
                swept: nameList(sweptLeaveTypeNames),
              })
            : t('earnedTypesNotSweptNoneActive', { types: nameList(notSweptNames) })}
        </p>
      )}

      {/* Step 2 — Preview table. */}
      {rows !== null && (
        <div className="space-y-3">
          {rows.length === 0 ? (
            <div className="space-y-2 rounded-lg bg-background px-3 py-4 text-center text-xs text-muted-foreground">
              <p data-testid="earned-empty-reason">{emptyMessage()}</p>
              {/* feedback cf9dcb98 reason (d) — the archived twin rides ALONGSIDE the reason rather than
                  replacing it, because on the reporting account both are true at once: the type they could
                  pick is not one this sweep covers, AND the type holding their 163 ledger rows is archived.
                  Showing only one of the two would send them down the wrong half of the problem. */}
              {archivedHint.length > 0 && (
                <p data-testid="earned-archived-hint">
                  {t('earnedArchivedHint', { types: nameList(archivedHint.map((a) => a.name)) })}
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('earnedColCompany')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColGrade')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('earnedColCount')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColType')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColPeriod')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColMethod')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('earnedColEntitlement')}</th>
                    <th className="px-3 py-2 font-medium">{t('earnedColStatus')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r, i) => (
                    <tr key={`${r.companyId}|${r.gradeId ?? ''}|${r.leaveTypeId}|${i}`}>
                      <td className="px-3 py-2 text-foreground">{r.companyName}</td>
                      <td className="px-3 py-2 text-foreground">{r.gradeName ?? t('earnedGradeUngraded')}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">{r.employeeCount}</td>
                      <td className="px-3 py-2 text-foreground">{r.leaveTypeName}</td>
                      <td className="px-3 py-2 tabular-nums text-foreground">{r.accrualPeriod}</td>
                      <td className="px-3 py-2 text-foreground">{methodLabel(r.method)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">
                        {t('earnedDaysValue', { days: r.entitlementGenerated })}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium',
                            committed
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                          )}
                        >
                          {committed ? t('earnedStatusDone') : t('earnedStatusPending')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-border bg-muted/30 text-foreground">
                  <tr>
                    <td className="px-3 py-2 font-medium" colSpan={6}>
                      {t('earnedTotalRow')}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {t('earnedDaysValue', { days: totalEntitlement })}
                    </td>
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {/* feedback cf9dcb98 reason (c) — IDEMPOTENCY, AND IT IS NOT AN EMPTY PREVIEW. This was the one
              reason in the plan that cannot reach the block above: the engine counts an eligible employee
              into their group BEFORE it works out the top-up, so an accrual that is already posted returns
              a FULL table of rows reading 0.00 days. What HR saw was a grid of zeros with a live Run
              button and nothing saying why — and "already posted" and "nothing earned yet at this date"
              look identical in that grid while wanting opposite actions. `earnedToDateTotal` is the
              engine's Σ of what HAS been earned to the as-at date, so the two are told apart on the
              engine's figure rather than on a guess made here. */}
          {rows.length > 0 && totalEntitlement === 0 && previewAsOf && (
            <p
              data-testid="earned-nothing-outstanding"
              className="rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
            >
              {earnedToDateTotal > 0
                ? t('earnedNothingOutstanding', { days: earnedToDateTotal, date: previewAsOf })
                : t('earnedNothingEarnedYet', { date: previewAsOf })}
            </p>
          )}
          {previewAsOf && (
            <p className="text-[11px] text-muted-foreground">{t('earnedAsOfNote', { date: previewAsOf })}</p>
          )}

          {/* Step 3 — Confirm / Cancel / Export. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={onRun} disabled={pending || committed || rows.length === 0}>
              {pending && rows !== null ? t('earnedRunningButton') : t('earnedRunButton')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
              {t('earnedCancelButton')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onExport}
              disabled={rows.length === 0}
            >
              {t('earnedExportButton')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
