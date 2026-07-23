import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listLeaveYearConfigs, leaveYearsWithRecords } from '@/core/leave';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { LeaveTabs } from '@/components/leave-tabs';
import { LeaveYearRuleDialog } from '@/components/leave/leave-year-rule-dialog';
import { LeaveYearEditDialog } from '@/components/leave/leave-year-edit-dialog';
import {
  setCompanyLeaveCycleAction,
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
 * No action/service change; `requireAdmin()` guard preserved verbatim.
 *
 * R64 08bc6841 — the per-company half-day-deduction toggle (which 0d147b78 re-homed HERE) RELOCATED again,
 * into the Condition step's Leave Application Rules grid on the Entitlements tab (one card among the
 * per-type rule groups, marked applies-company-wide). Single home: the card is GONE from this page; the
 * setLeaveHalfDayFullDeduction write is unchanged, the action now redirects back to the Entitlements route
 * (the R45 cc816207 / R61 d778d2d3 relocation precedent).
 *
 * R45 cc816207 — the Leave Year card RELOCATED here from the Entitlements tab. A leave year controls WHEN
 * employees may apply for an upcoming year, not how much entitlement they earn, so HR expects it next to the
 * other application rules. Same fields, buttons, records and behaviour — only its home changed; the leave-year
 * actions now redirect back to THIS route after save/open/delete (app/admin/actions.ts).
 *
 * R61 d778d2d3 — the per-company Leave Cycle card (ADR-0040 2D-2: calendar vs hire anniversary) RELOCATED here
 * from the Entitlements tab, joining the Leave Year card: both are company-level calendar rules, so they belong
 * together. Same options, same per-company rows, same setCompanyLeaveCycleAction — only the rendering moved
 * (the action now redirects back to THIS route, mirroring the R45 leave-year precedent). The earned-accrual
 * tool stays under Entitlements as a header "Run Accrual" dialog button.
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
  const leaveYearStatusVariant = (status: string) =>
    status === 'open' ? ('success' as const) : status === 'closed' ? ('default' as const) : ('warning' as const);
  // R45 fd71fa38 — a leave year is deletable only when it is still a DRAFT AND no leave records reference it
  // (the service guard is authoritative; this drives the pre-emptive enabled/disabled state + the visible
  // inline reason beside the row — dcd8e32f replaced the hover-only tooltip, which touch devices and screen
  // readers never saw).
  const leaveYearRecordYearSet = new Set(leaveYearRecordYears);

  return (
    <div className="space-y-6">
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
              {/* The two control dates, read-only (7903c197). Editing moved into LeaveYearEditDialog:
                  the old inline form saved IMMEDIATELY on clicking its Edit-labelled submit button
                  ("Leave year saved." with no review step). Edit now opens a prefilled pop-up; the save
                  + toast only fire from the Save button inside it. Feedback 4f4d9cff's row order is
                  kept: dates, then "Advance Rules" right beside the Employee-application-start-date
                  value, then (after the justify-between gap) Start / Edit / Delete. */}
              <div className="flex flex-wrap items-end gap-4">
                <div className="w-40">
                  <span className="block text-xs font-medium text-muted-foreground">
                    {t('openLeaveYearDateLabel')}
                  </span>
                  <span className="text-sm text-foreground">{cfg.openLeaveYearDate ?? '—'}</span>
                </div>
                <div className="w-40">
                  <span className="block text-xs font-medium text-muted-foreground">
                    {t('employeeApplicationStartDateLabel')}
                  </span>
                  <span className="text-sm text-foreground">{cfg.employeeApplicationStartDate ?? '—'}</span>
                </div>
                {cfg.status === 'draft' && (
                  /* 37088a65 — per-row "Advance Rules" dialog (replaces the old shared bottom-of-page
                     panel). Draft-only, matching the lifecycle Start button: an ungated trigger would let
                     HR stamp open_leave_year_date onto an open/closed year. The trigger Button is
                     type="button", so it can never submit an adjacent row form. Feedback 4f4d9cff placed
                     it here, immediately after the Employee-application-start-date value. */
                  <LeaveYearRuleDialog
                    year={cfg.year}
                    current={{
                      openingRuleEnabled: cfg.openingRuleEnabled,
                      openBeforeAmount: cfg.openBeforeAmount,
                      openBeforeUnit: cfg.openBeforeUnit,
                      openLeaveYearDate: cfg.openLeaveYearDate,
                    }}
                    saveAction={saveFutureOpeningRuleAction}
                  />
                )}
              </div>
              {/* Action group, ordered per feedback 4f4d9cff: lifecycle (Start on a draft; Close / Reopen
                  keep that slot on open / closed years), then Edit, then Delete last. Draft → Open runs
                  the grant sweep; Open → Closed is an informational badge flip (v1); Closed → Draft
                  reopens for corrections. */}
              <div className="flex items-end gap-2">
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
                {/* dcd8e32f — the row edit is a recognisable EDIT action (pencil + "Edit"), sitting
                    between Start and Delete per feedback 4f4d9cff. 7903c197 — it now opens a prefilled
                    pop-up (LeaveYearEditDialog) instead of submitting an inline form; available on EVERY
                    row whatever its status — HR must stay able to correct dates on an open or closed
                    year. Nothing is saved until Save is pressed inside the dialog. */}
                <LeaveYearEditDialog
                  year={cfg.year}
                  current={{
                    openLeaveYearDate: cfg.openLeaveYearDate,
                    employeeApplicationStartDate: cfg.employeeApplicationStartDate,
                  }}
                  saveAction={upsertLeaveYearConfigAction}
                />
                {/* R45 fd71fa38 / f1701466 — Delete is ALWAYS clickable. A blocked row (not draft, or leave
                    records reference the year) renders a plain submit button — clicking posts and the
                    SERVICE guard refuses, its localized message landing in the ErrorBanner + error toast
                    (the message can never drift from the real guard); the inline text stays as a pre-click
                    hint. A deletable row opens the two-step confirm (Yes/No → mandatory deletion reason
                    checkboxes → Confirm Delete). leaveYearsWithRecords is purely the UX pre-check for which
                    button to render; the service stays authoritative — a stale render (year opened / an
                    application filed mid-flow) lands on the ErrorBanner with the exact service message. */}
                {(() => {
                  const referenced = leaveYearRecordYearSet.has(cfg.year);
                  const deletable = cfg.status === 'draft' && !referenced;
                  if (!deletable) {
                    return (
                      <div className="flex items-center gap-2">
                        <form action={deleteLeaveYearAction}>
                          <input type="hidden" name="year" value={cfg.year} />
                          <Button type="submit" variant="ghost" size="sm">
                            {t('deleteLeaveYear')}
                          </Button>
                        </form>
                        <span className="max-w-56 text-xs text-muted-foreground">
                          {cfg.status !== 'draft' ? t('deleteLeaveYearBlockedOpened') : t('deleteLeaveYearBlockedRecords')}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <form action={deleteLeaveYearAction}>
                      <input type="hidden" name="year" value={cfg.year} />
                      <ConfirmSubmit
                        size="sm"
                        variant="ghost"
                        title={t('deleteLeaveYearConfirmTitle')}
                        subtitle={t('deleteLeaveYearTarget', { year: cfg.year })}
                        description={t('deleteLeaveYearConfirmBody')}
                        confirmLabel={t('deleteLeaveYearConfirmButton')}
                        twoStep={{
                          warning: t('deleteLeaveYearWarning'),
                          reasonLegend: t('deleteLeaveYearReasonLegend'),
                          reasonOptions: [
                            { value: 'wrongly_created', label: t('deleteLeaveYearReasonWronglyCreated') },
                            { value: 'duplicate', label: t('deleteLeaveYearReasonDuplicate') },
                          ],
                          name: 'reasons',
                          yesLabel: t('deleteLeaveYearYes'),
                          noLabel: t('deleteLeaveYearNo'),
                        }}
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

        {/* 37088a65 — the Future Leave Year Opening Rule (d9e41725) moved OUT of this page. It used to be a
            shared "Advanced leave year rules" disclosure down here, with its own Effective-Leave-Year
            dropdown — picking the wrong year silently wrote the rule onto the wrong record. Each DRAFT row
            above now opens its own LeaveYearRuleDialog, pinned to that row's year. One deliberate loss: the
            old dropdown could target a not-yet-configured future year (the save upserted it as draft); HR now
            clicks "Add leave year" first, then sets the rules on the new row. */}
      </Card>

      {/* ADR-0040 2D-2: per-company earned-accrual cycle (calendar vs hire anniversary). R61 d778d2d3 —
          relocated here from the Entitlements tab beside the Leave Year card (kindred company-level
          calendar rules). Rendering only: same rows, same options, same setCompanyLeaveCycleAction. */}
      <Card>
        <SectionHeader title={t('leaveCycleTitle')} count={companies.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('leaveCycleHelp')}</p>
        <ul className="divide-y divide-border">
          {companies.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <form
                action={setCompanyLeaveCycleAction}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <input type="hidden" name="companyId" value={c.id} />
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{c.name}</span>
                <div className="flex items-center gap-2">
                  <select name="cycle" defaultValue={c.leaveCycle ?? 'calendar'} className={`${inputCls} w-44`}>
                    <option value="calendar">{t('cycleCalendar')}</option>
                    <option value="anniversary">{t('cycleAnniversary')}</option>
                  </select>
                  <Button type="submit" variant="outline" size="sm">
                    {t('save')}
                  </Button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      </Card>

      {/* R64 08bc6841 — the per-company half-day-deduction Card (feedback 31474452) moved to the
          Entitlements tab's Condition step (Leave Application Rules grid) — its single home now. */}
    </div>
  );
}
