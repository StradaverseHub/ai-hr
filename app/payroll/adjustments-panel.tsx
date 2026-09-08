import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, batchInputRows } from '@/core/payroll';
import { loanSummaryForBatch } from '@/core/loans';
import { listAllowancePolicies } from '@/core/read';
import { Button, Card, EmployeeCode, SectionHeader, inputCls } from '@/components/ui';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import {
  prefillClaimsAction,
  prefillFixedZakatAction,
  prefillLoansAction,
  prefillOvertimeAction,
  prefillShiftDifferentialAction,
  prefillTp1Action,
  transferAllowancesAction,
} from './actions';
import { OtInputRow } from './[batchId]/ot-input-row';

/**
 * The draft run's ADJUSTMENT panel — the seven consolidation bridges plus the per-employee input grid —
 * as a shared server component (7076f8af).
 *
 * WHY IT MOVED, AND WHY IT WAS NOT DELETED. The reporter asked for this panel to come off the screen a
 * reset lands on, and listed it among the functions to remove. It is not a small table: it is the ONLY
 * place in the product where approved overtime, approved claims, loan instalments, shift differential,
 * fixed zakat, declared TP1 relief and attendance allowances are carried into a payroll run. Deleting it
 * would leave those approved amounts with no path to anybody's pay and nothing would warn anyone — people
 * would simply be paid short while the approvals still read "approved". (The TP1 bridge is the sharpest
 * case: `prefillTp1Action` is the only route from tp1_relief into payroll_input.tp1_deduction, and it
 * already spent a release rendered by no screen at all.) So it is RELOCATED: onto the Review step of the
 * run flow, which is exactly where the reporter asked to review a run before processing it, and onto a
 * screen under Transactions.
 *
 * NO SERVICE CHANGE and no new action: the same seven server actions, the same batchId contract, the same
 * gates (draft-only, regular-only for loans/TP1, typed-components for allowances). The one thing that had
 * to change is WHERE those actions return to — they hard-redirected to `/payroll/<batchId>`, which on this
 * panel's new hosts would yank the operator onto the very screen the change removes from the path. Each
 * form now posts `returnTo`; the whitelist that keeps that honest is lib/return-to.ts.
 *
 * Renders NOTHING for a non-draft run: every bridge below refuses a processed batch in the service, and a
 * panel of buttons that can only fail is worse than no panel.
 */
export async function PayrollAdjustmentsPanel({
  batchId,
  returnTo,
  pager,
}: {
  batchId: string;
  /** The screen this panel is rendered on, posted with every form so the actions come back here. */
  returnTo: string;
  /** Where the input grid's pager links point, and the page/size it reads. Its param NAMES stay
   *  `iPage`/`iSize` so a host page can page a second table independently, as the run screen does. */
  pager: { basePath: string; params: Record<string, string | undefined>; page?: string; size?: string };
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  const data = await batchDetail(s, batchId);
  if (!data || data.batch.status !== 'draft') return null;
  const { batch } = data;

  const rm = (n: unknown) =>
    `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const isRegular = batch.runType === 'regular';
  const scope = (batch.scope ?? null) as { departmentIds?: string[]; employmentIds?: string[] } | null;
  const isScoped = !!(scope?.departmentIds?.length || scope?.employmentIds?.length);
  const typedComponentsOn = isModuleEnabledOrFalse(s, 'typed_pay_components');
  const inputs = await batchInputRows(s, batchId);
  const inputPage = paginateRows(inputs, parsePageQuery({ page: pager.page, size: pager.size }));
  const loanSummary = isRegular ? await loanSummaryForBatch(s, batchId) : { loans: 0, total: 0 };
  const allowancePolicies = await listAllowancePolicies(s, { companyIds: [batch.companyId] }).then((rows) =>
    rows.filter((r) => r.status === 'active'),
  );

  return (
    <Card className="overflow-hidden">
      <SectionHeader title={t('inputsTitle')} count={inputs.length} />
      <p className="px-4 pt-3 text-xs text-muted-foreground">{t('inputsHint')}</p>
      <div className="mx-4 mt-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-foreground">{t('consolidateTitle')}</div>
        <p className="text-xs text-muted-foreground">
          {t.rich('prefillHint', {
            strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          })}
        </p>
        {isScoped && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t('scopedCaption')}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <form action={prefillOvertimeAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <Button type="submit" size="sm" variant="secondary">
              {t('prefillOt')}
            </Button>
          </form>
          <form action={prefillClaimsAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <Button type="submit" size="sm" variant="secondary">
              {t('prefillClaims')}
            </Button>
          </form>
          {/* 1.2.8 Loan deductions — reserve onto a regular draft run only (ADR-0060). */}
          {isRegular && (
            <form action={prefillLoansAction} className="flex items-center gap-2">
              <input type="hidden" name="batchId" value={batch.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Button type="submit" size="sm" variant="secondary">
                {t('prefillLoans')}
              </Button>
              {loanSummary.loans > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t('loanSummary', {
                    count: loanSummary.loans,
                    amount: loanSummary.total.toLocaleString('en-MY', { minimumFractionDigits: 2 }),
                  })}
                </span>
              )}
            </form>
          )}
          <form action={prefillShiftDifferentialAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <Button type="submit" size="sm" variant="secondary">
              {t('prefillShiftDiff')}
            </Button>
          </form>
          {/* 3a092cf0 — REGULAR RUNS ONLY, matching prefillLoans above and prefillTp1 below. A zakat
              election is a monthly amount; offering it on an additional run applied it twice in one
              month once zakat joined the deduction total. The service refuses it too. */}
          {isRegular && (
          <form action={prefillFixedZakatAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <Button type="submit" size="sm" variant="secondary">
              {t('prefillFixedZakat')}
            </Button>
          </form>
          )}
          {/* a1d82340 rev 3 — TP1 self-relief. This action has existed since the TP1 screen shipped and
              was rendered by NO screen: five of the six bridges had a button here and this one did not.
              An employee could submit their relief, HR could see it, and it could never reach a payslip.
              Regular runs only, like the loan reservation above: an additional/off-cycle run pays its
              bonus and does not carry the month's declared reliefs. */}
          {isRegular && (
            <form action={prefillTp1Action}>
              <input type="hidden" name="batchId" value={batch.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Button type="submit" size="sm" variant="secondary">
                {t('prefillTp1')}
              </Button>
            </form>
          )}
          {/* Attendance Allowance (ADR-0072) — pick an active policy and transfer its qualified
              allowances onto this draft. Gated by TYPED_PAY_COMPONENTS_ENABLED. */}
          {allowancePolicies.length > 0 && (
            <form action={transferAllowancesAction} className="flex items-center gap-2">
              <input type="hidden" name="batchId" value={batch.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <select name="policyId" className={inputCls} defaultValue={allowancePolicies[0]?.id}>
                {allowancePolicies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — RM {Number(p.amount).toFixed(2)}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" variant="secondary">
                {t('transferAllowance')}
              </Button>
            </form>
          )}
        </div>
        {allowancePolicies.length > 0 && !typedComponentsOn && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('allowanceGateWarning')}</p>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('colCode')}</th>
              <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('colBasic')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('colOtBonusTp1Zakat')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('colUnpaidDays')}</th>
              {/* e2632276 — the absent-day count, so it can be checked BEFORE the run is processed. */}
              <th className="px-4 py-2 text-right font-medium">{t('colAbsentDays')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {inputPage.rows.map((r) => (
              <tr key={r.employmentId}>
                <td className="px-4 py-2.5">
                  <EmployeeCode code={r.employeeCode} />
                </td>
                <td className="px-4 py-2.5 font-medium">{r.name}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(r.basic)}</td>
                <td className="px-4 py-2.5">
                  {/* Fix-5: manual OT (RM you enter) with the s.60I(1A) ORP/hourly basis surfaced, a
                      >RM4,000 eligibility note, and a clobber warning before overwriting an
                      attendance-prefilled row. See ot-input-row.tsx. */}
                  <OtInputRow
                    batchId={batch.id}
                    returnTo={returnTo}
                    row={{
                      employmentId: r.employmentId,
                      otBreakdown: r.otBreakdown,
                      otSource: r.otSource,
                      orp: r.orp,
                      hourly: r.hourly,
                      otEligible: r.otEligible,
                      otWageCeiling: r.otWageCeiling,
                      bonusAmount: r.bonusAmount,
                      tp1Deduction: r.tp1Deduction,
                      zakat: r.zakat,
                    }}
                  />
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                  {r.unpaidDays > 0 ? r.unpaidDays : '—'}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                  {r.absentDays > 0 ? r.absentDays : '—'}
                </td>
              </tr>
            ))}
            {inputPage.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t('noActiveEmployees')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager
        basePath={pager.basePath}
        params={pager.params}
        paramNames={{ page: 'iPage', size: 'iSize' }}
        state={inputPage.state}
      />
    </Card>
  );
}
