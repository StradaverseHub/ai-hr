import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listLeaveYearConfigs, leaveYearsWithRecords } from '@/core/leave';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { LeaveTabs } from '@/components/leave-tabs';
import {
  setLeaveHalfDayFullDeductionAction,
  upsertLeaveYearConfigAction,
  setLeaveYearStatusAction,
  saveFutureOpeningRuleAction,
  deleteLeaveYearAction,
} from '../../actions';

/**
 * Leave Settings — Application Rules tab (0d147b78 — Leave Settings Reorganization).
 *
 * How leave is APPLIED, at company level. Per-type application rules the ticket names
 * (supporting-document requirements, backdated-leave limits) stay on the Leave Types tab inside
 * `LeaveTypePanel`, because they are configured per leave type and rely on that panel's tri-state
 * markers (`document=1`, `backdating=1`) — moving them would risk silently wiping a column on save.
 * The per-company half-day-deduction toggle re-homes here. No action/service change; `requireAdmin()`
 * guard preserved verbatim.
 *
 * R45 cc816207 — the Leave Year card RELOCATED here from the Entitlements tab. A leave year controls WHEN
 * employees may apply for an upcoming year, not how much entitlement they earn, so HR expects it next to the
 * other application rules. Same fields, buttons, records and behaviour — only its home changed; the leave-year
 * actions now redirect back to THIS route after save/open/delete (app/admin/actions.ts). The earned-accrual
 * card stays under Entitlements (it genuinely belongs with entitlements).
 */
export default async function LeaveApplicationRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const [companies, leaveYearConfigs, leaveYearRecordYears] = await Promise.all([
    listCompanies(s),
    // Leave Year Configuration (9aa894a4): the managed Draft/Open/Closed records driving the Leave-Year table.
    listLeaveYearConfigs(s),
    // R45 fd71fa38: years that already have leave records — used to disable the row Delete button.
    leaveYearsWithRecords(s),
  ]);

  // Leave Year Configuration (9aa894a4): offer the current year through +6 in the create dropdown; default to
  // the first year that does not yet have a managed record (so repeated "Add" naturally walks forward).
  const nextYear = new Date().getUTCFullYear() + 1;
  const configuredYears = new Set(leaveYearConfigs.map((c) => c.year));
  const yearOptions = Array.from({ length: 7 }, (_, i) => new Date().getUTCFullYear() + i);
  const defaultNewYear = yearOptions.find((y) => !configuredYears.has(y)) ?? nextYear;
  // Future Leave Year Opening Rule (d9e41725): prefill the rule sub-form from the default year's existing rule.
  const defaultRule = leaveYearConfigs.find((c) => c.year === defaultNewYear) ?? null;
  const leaveYearStatusVariant = (status: string) =>
    status === 'open' ? ('success' as const) : status === 'closed' ? ('default' as const) : ('warning' as const);
  // R45 fd71fa38 — a leave year is deletable only when it is still a DRAFT AND no leave records reference it
  // (the service guard is authoritative; this drives the pre-emptive enabled/disabled + tooltip in the row).
  const leaveYearRecordYearSet = new Set(leaveYearRecordYears);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="application-rules" />
      <ErrorBanner message={error} />

      {/* Leave Year Configuration (9aa894a4): the managed Draft → Open → Closed leave-year records. Each row
          carries a status badge, the two control dates (editable), and the lifecycle action. Opening a year
          runs the same grant sweep as before (via setLeaveYearStatusAction → openLeaveYear), so the record
          and the ledger stay in lockstep. Employees can only apply for a FUTURE leave year once it is open
          and past its Employee-Application-Start-Date (enforced in requestLeave).

          R45 cc816207 — relocated here from the Entitlements tab (the earned-accrual card stayed behind). */}
      <Card>
        <SectionHeader title={t('leaveYearTitle')} count={leaveYearConfigs.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {t.rich('leaveYearHelp', {
            strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          })}
        </p>
        <ul className="divide-y divide-border">
          {leaveYearConfigs.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noLeaveYears')}</li>
          )}
          {leaveYearConfigs.map((cfg) => (
            <li key={cfg.id} className="flex flex-wrap items-end justify-between gap-4 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="w-14 text-sm font-semibold text-foreground">{cfg.year}</span>
                <Badge variant={leaveYearStatusVariant(cfg.status)}>{t(`leaveYearStatus_${cfg.status}`)}</Badge>
              </div>
              {/* Edit the two control dates (status unchanged here — the lifecycle action does that). */}
              <form action={upsertLeaveYearConfigAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="year" value={cfg.year} />
                <Field label={t('openLeaveYearDateLabel')}>
                  <input
                    type="date"
                    name="openLeaveYearDate"
                    defaultValue={cfg.openLeaveYearDate ?? ''}
                    className={`${inputCls} w-40`}
                  />
                </Field>
                <Field label={t('employeeApplicationStartDateLabel')}>
                  <input
                    type="date"
                    name="employeeApplicationStartDate"
                    defaultValue={cfg.employeeApplicationStartDate ?? ''}
                    className={`${inputCls} w-40`}
                  />
                </Field>
                <Button type="submit" variant="outline" size="sm">
                  {t('save')}
                </Button>
              </form>
              {/* Lifecycle action. Draft → Open runs the grant sweep; Open → Closed is an informational badge
                  flip (v1); Closed → Draft reopens for corrections. */}
              <div className="flex items-end">
                {cfg.status === 'draft' && (
                  <form action={setLeaveYearStatusAction}>
                    <input type="hidden" name="year" value={cfg.year} />
                    <input type="hidden" name="status" value="open" />
                    <Button type="submit" size="sm">
                      {t('openLeaveYear')}
                    </Button>
                  </form>
                )}
                {cfg.status === 'open' && (
                  <form action={setLeaveYearStatusAction}>
                    <input type="hidden" name="year" value={cfg.year} />
                    <input type="hidden" name="status" value="closed" />
                    <Button type="submit" variant="outline" size="sm">
                      {t('closeLeaveYear')}
                    </Button>
                  </form>
                )}
                {cfg.status === 'closed' && (
                  <form action={setLeaveYearStatusAction}>
                    <input type="hidden" name="year" value={cfg.year} />
                    <input type="hidden" name="status" value="draft" />
                    <Button type="submit" variant="ghost" size="sm">
                      {t('reopenLeaveYear')}
                    </Button>
                  </form>
                )}
                {/* R45 fd71fa38 — Delete. Enabled only for a DRAFT year with no leave records referencing it;
                    otherwise a disabled button with an explanatory tooltip. The confirm dialog guards the
                    click, and the service re-checks the guard (authoritative) before removing the row. */}
                {(() => {
                  const referenced = leaveYearRecordYearSet.has(cfg.year);
                  const deletable = cfg.status === 'draft' && !referenced;
                  if (!deletable) {
                    return (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled
                        title={cfg.status !== 'draft' ? t('deleteLeaveYearBlockedOpened') : t('deleteLeaveYearBlockedRecords')}
                      >
                        {t('deleteLeaveYear')}
                      </Button>
                    );
                  }
                  return (
                    <form action={deleteLeaveYearAction}>
                      <input type="hidden" name="year" value={cfg.year} />
                      <ConfirmSubmit
                        size="sm"
                        variant="ghost"
                        title={t('deleteLeaveYearConfirmTitle', { year: cfg.year })}
                        description={t('deleteLeaveYearConfirmBody', { year: cfg.year })}
                        confirmLabel={t('deleteLeaveYear')}
                      >
                        {t('deleteLeaveYear')}
                      </ConfirmSubmit>
                    </form>
                  );
                })()}
              </div>
            </li>
          ))}
        </ul>
        {/* Create / configure an upcoming leave year (year dropdown + two control dates). */}
        <form
          action={upsertLeaveYearConfigAction}
          className="flex flex-wrap items-end gap-3 border-t border-border p-4"
        >
          <Field label={t('yearLabel')}>
            <select name="year" defaultValue={String(defaultNewYear)} className={`${inputCls} w-28`}>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('openLeaveYearDateLabel')}>
            <input type="date" name="openLeaveYearDate" className={`${inputCls} w-44`} />
          </Field>
          <Field label={t('employeeApplicationStartDateLabel')}>
            <input type="date" name="employeeApplicationStartDate" className={`${inputCls} w-44`} />
          </Field>
          <button className={btnPrimary}>{t('addLeaveYear')}</button>
        </form>

        {/* R45 4822de27 — Separate leave-year creation from the future auto-opening RULE. Everything above
            (records list + the create form with the two control dates + the lifecycle Open/Close actions) is
            the everyday, primary flow. The auto-opening rule below is OPTIONAL automation that HR often
            mistook for mandatory, so it now lives in a collapsed-by-default "Advanced" disclosure. Purely a
            layout split — fields, actions and behaviour are unchanged.

            Future Leave Year Opening Rule (d9e41725). HR Admin defines an advance-opening window ("open the
            year N Days/Weeks/Months before it starts") for a chosen Effective Leave Year; on save the system
            COMPUTES open_leave_year_date = 1-Jan-of-year minus that window (UTC-correct calendar math) and
            stamps it on that year's record. v1 is compute-only — enabling the rule sets the date; an automatic
            open-the-year cron is deferred. The hidden `ruleSubmitted` marker + checkbox `enable` follow the
            tri-state sub-form convention so an unchecked box reliably disables the rule. Prefilled from the
            default (next uncofigured) year's existing rule, if any. */}
        <details className="group border-t border-border">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 [&::-webkit-details-marker]:hidden">
            <span>
              <span className="text-sm font-semibold text-foreground">{t('leaveYearAdvancedTitle')}</span>
              <span className="block text-xs text-muted-foreground">{t('leaveYearAdvancedHelp')}</span>
            </span>
            <span className="text-xs text-muted-foreground group-open:rotate-180">▾</span>
          </summary>
          <div className="px-4 pb-3">
          <h3 className="text-sm font-semibold text-foreground">{t('openingRuleTitle')}</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t('openingRuleHelp')}</p>
          <form action={saveFutureOpeningRuleAction} className="mt-3 flex flex-wrap items-end gap-3">
            {/* tri-state marker: this sub-form owns the rule columns; its presence means "apply the rule state
                below" (checkbox absent ⇒ disable, not "leave untouched"). */}
            <input type="hidden" name="ruleSubmitted" value="1" />
            <label className="flex items-center gap-2 self-center pt-5 text-sm">
              <input
                type="checkbox"
                name="enable"
                defaultChecked={defaultRule?.openingRuleEnabled ?? false}
                className="size-4 rounded"
              />
              {t('openingRuleEnableLabel')}
            </label>
            <Field label={t('openBeforeAmountLabel')}>
              <input
                type="number"
                name="openBeforeAmount"
                min={1}
                step={1}
                defaultValue={defaultRule?.openBeforeAmount ?? ''}
                placeholder="14"
                className={`${inputCls} w-24`}
              />
            </Field>
            <Field label={t('openBeforeUnitLabel')}>
              <select
                name="openBeforeUnit"
                defaultValue={defaultRule?.openBeforeUnit ?? 'days'}
                className={`${inputCls} w-32`}
              >
                <option value="days">{t('openingUnitDays')}</option>
                <option value="weeks">{t('openingUnitWeeks')}</option>
                <option value="months">{t('openingUnitMonths')}</option>
              </select>
            </Field>
            <Field label={t('effectiveLeaveYearLabel')}>
              <select name="year" defaultValue={String(defaultNewYear)} className={`${inputCls} w-28`}>
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="outline" size="sm">
              {t('save')}
            </Button>
          </form>
          {/* Show the currently-persisted rules so HR sees the computed opening dates at a glance. */}
          {leaveYearConfigs.some((c) => c.openingRuleEnabled) && (
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
              {leaveYearConfigs
                .filter((c) => c.openingRuleEnabled)
                .map((c) => (
                  <li key={`rule-${c.id}`}>
                    {t('openingRuleSummary', {
                      year: c.year,
                      amount: c.openBeforeAmount ?? 0,
                      unit: t(
                        c.openBeforeUnit === 'weeks'
                          ? 'openingUnitWeeks'
                          : c.openBeforeUnit === 'months'
                            ? 'openingUnitMonths'
                            : 'openingUnitDays',
                      ),
                      date: c.openLeaveYearDate ?? '—',
                    })}
                  </li>
                ))}
            </ul>
          )}
          </div>
        </details>
      </Card>

      {/* Feedback request 31474452: per-company half-day leave-deduction toggle. */}
      <Card>
        <SectionHeader title={t('halfDayDeductionTitle')} count={companies.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('halfDayDeductionHelp')}</p>
        <p className="px-4 pb-1 text-xs text-muted-foreground">{t('halfDayDeductionFrozenNote')}</p>
        <ul className="divide-y divide-border">
          {companies.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <form
                action={setLeaveHalfDayFullDeductionAction}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <input type="hidden" name="companyId" value={c.id} />
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.leaveHalfDayFullDeduction ? t('halfDayDeductionOn') : t('halfDayDeductionOff')}
                  </span>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={!!c.leaveHalfDayFullDeduction}
                    className="size-4 rounded"
                  />
                  {t('halfDayDeductionToggleLabel')}
                </label>
                <Button type="submit" variant="outline" size="sm">
                  {t('save')}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
