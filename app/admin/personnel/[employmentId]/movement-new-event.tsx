'use client';

// Movement tab redesign (78853b97), comparison redesign (08913328) — client half of "New Event".
//
// The event-type select still drives the form, but for the CHANGE kinds (Transfer, Promotion, Demotion,
// Increment, Salary Adjustment, Organisation Assignment Change, Employment Type Change, Reporting Line
// Change) it now renders a Current / After (New) comparison instead of a short list of type-specific
// pickers. The left column is the employee's current record, read-only; the right column is pre-filled
// with the same values, and HR edits only what moves. The dispatcher (core/movement.ts) diffs the two, so
// an untouched field writes nothing — no phantom assignment version, no history row that says nothing.
//
// The LIFECYCLE kinds (Confirmation, Probation Extension, Resignation, Termination, Blacklist, Secondment,
// Acting Position) keep their dedicated inputs: a before/after grid would be meaningless for them.
//
// Every option list is pre-loaded and pre-translated by the server page; this island owns only the form
// state. The tab shell injects the hidden `tab` field on submit, so the save lands back on the Movement tab.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { CurrencySelect } from '@/components/currency-select';
import { PAY_MODE_OPTIONS, PAYMENT_TERM_OPTIONS } from '@/components/pay-structure-fields';
import { createMovementEventAction, editMovementEventAction } from './actions';

export type MovementOption = { id: string; name: string };

/** The employee's current record, as the server read it — ids for pickers, text for the flat columns. */
export type MovementCurrentValues = {
  companyName: string | null;
  departmentId: string | null;
  positionId: string | null;
  businessUnitId: string | null;
  locationId: string | null;
  employmentType: string | null;
  gradeId: string | null;
  managerEmploymentId: string | null;
  basicSalary: string | null;
  currency: string | null;
  payMode: string | null;
  paymentTerm: string | null;
  orgDivision: string | null;
  employmentCategory: string | null;
  orgRegion: string | null;
  orgBranch: string | null;
  orgTeam: string | null;
  orgSection: string | null;
  orgLine: string | null;
  orgBase: string | null;
};

// Literal styling tokens (documents-manager precedent — never import a server module into this bundle).
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50';
const btnGhost =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium transition hover:bg-accent';

// Mirrors core/movement.ts MOVEMENT_KINDS (Rehire/Custom deferred).
const KINDS = [
  'transfer',
  'promotion',
  'demotion',
  'increment',
  'salaryAdjustment',
  'confirmation',
  'probationExtension',
  'secondment',
  'actingPosition',
  'resignation',
  'termination',
  'blacklist',
  'orgAssignmentChange',
  'reportingLineChange',
  'employmentTypeChange',
  // 89ea527b — the two employment-date movements. Neither is a comparison kind: each moves exactly one date,
  // and that date IS the effective date (the `confirmation` pattern), so a Current/After grid would just
  // restate the field above it.
  'joinDateChange',
  'groupJoinDateCorrection',
] as const;

/** 89ea527b — kinds whose Effective Date is the VALUE being set, not the day a separate change takes effect.
 *  They get an explicit hint, because "Effective Date" alone reads as "when does this apply" and here the
 *  answer is "this IS the new date". */
const DATE_VALUE_KINDS: readonly string[] = ['joinDateChange', 'groupJoinDateCorrection'];

// Mirrors core/movement.ts COMPARISON_KINDS — the kinds that render the Current / After grid.
const COMPARISON_KINDS: readonly string[] = [
  'transfer',
  'promotion',
  'demotion',
  'increment',
  'salaryAdjustment',
  'orgAssignmentChange',
  'employmentTypeChange',
  'reportingLineChange',
];

/** 66a63bd6 — the movement being corrected. Absent = the New Event form, unchanged. */
export type MovementEditTarget = {
  movementId: string;
  kind: string;
  effectiveDate: string;
  endDate: string | null;
  remarks: string | null;
  /** Event types this correction may switch to — the same family as the movement it replays. */
  allowedKinds: string[];
  /** A processed (not yet closed) payroll run covered this period; payslips are never reprocessed. */
  payrollWarning: boolean;
};

export function MovementNewEvent({
  employmentId,
  today,
  isBlacklisted,
  current,
  departments,
  positions,
  businessUnits,
  grades,
  locations,
  managers,
  employmentTypes,
  terminationTypes,
  cancelHref,
  edit,
}: {
  employmentId: string;
  today: string;
  isBlacklisted: boolean;
  current: MovementCurrentValues;
  departments: MovementOption[];
  positions: MovementOption[];
  businessUnits: MovementOption[];
  grades: MovementOption[];
  locations: MovementOption[];
  managers: MovementOption[];
  /** Pre-translated by the server page (reuses the existing people.detail labels). */
  employmentTypes: { value: string; label: string }[];
  terminationTypes: { value: string; label: string }[];
  cancelHref: string;
  edit?: MovementEditTarget;
}) {
  const t = useTranslations('people.detail.movement');
  const tPay = useTranslations('people.detail');
  const [kind, setKind] = useState<string>(edit?.kind ?? 'transfer');

  // Static-key label map with a humanized fallback for future kinds — no dynamic t() keys, so a raw
  // key can never render in any locale.
  const kindLabel = (k: string): string => {
    switch (k) {
      case 'transfer': return t('eventType.transfer');
      case 'promotion': return t('eventType.promotion');
      case 'demotion': return t('eventType.demotion');
      case 'increment': return t('eventType.increment');
      case 'salaryAdjustment': return t('eventType.salaryAdjustment');
      case 'confirmation': return t('eventType.confirmation');
      case 'probationExtension': return t('eventType.probationExtension');
      case 'secondment': return t('eventType.secondment');
      case 'actingPosition': return t('eventType.actingPosition');
      case 'resignation': return t('eventType.resignation');
      case 'termination': return t('eventType.termination');
      case 'blacklist': return t('eventType.blacklist');
      case 'orgAssignmentChange': return t('eventType.orgAssignmentChange');
      case 'reportingLineChange': return t('eventType.reportingLineChange');
      case 'employmentTypeChange': return t('eventType.employmentTypeChange');
      case 'joinDateChange': return t('eventType.joinDateChange');
      case 'groupJoinDateCorrection': return t('eventType.groupJoinDateCorrection');
      default: return k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    }
  };

  const isComparison = COMPARISON_KINDS.includes(kind);
  const showTerminationType = kind === 'termination';
  const showBlacklist = kind === 'blacklist';
  const showEndDate = ['probationExtension', 'secondment', 'actingPosition', 'resignation'].includes(kind);
  const showEffectiveDate = kind !== 'blacklist';

  const payModeLabel = (v: string | null): string | null =>
    v == null ? null : PAY_MODE_OPTIONS.includes(v as 'monthly') ? tPay(`payMode_${v}` as 'payMode_monthly') : v;
  const paymentTermLabel = (v: string | null): string | null =>
    v == null ? null : PAYMENT_TERM_OPTIONS.includes(v as 'monthly') ? tPay(`paymentTerm_${v}` as 'paymentTerm_monthly') : v;

  const nameOf = (options: MovementOption[], id: string | null): string | null =>
    id ? (options.find((o) => o.id === id)?.name ?? null) : null;
  const dash = (v: string | null | undefined) => (v == null || v === '' ? '—' : v);

  /** One comparison row: the field label, the read-only current value, and the editable new value. */
  const row = (key: string, label: string, currentDisplay: string | null, control: React.ReactNode) => (
    <div
      key={key}
      className="grid grid-cols-1 gap-1 border-b border-border px-4 py-2.5 last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-4"
    >
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">{dash(currentDisplay)}</div>
      <div>{control}</div>
    </div>
  );

  const select = (
    name: string,
    value: string | null,
    options: MovementOption[],
    emptyLabel: string | null,
  ) => (
    <select name={name} defaultValue={value ?? ''} className={inputCls}>
      {emptyLabel != null && <option value="">{emptyLabel}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );

  const text = (name: string, value: string | null) => (
    <input name={name} defaultValue={value ?? ''} maxLength={120} className={inputCls} />
  );

  // The requested field order, top to bottom (feedback 08913328).
  const comparisonRows: React.ReactNode[] = [
    // Company is read-only here on purpose: moving an employee between legal entities is its own audited
    // flow on the Employment tab, with its own pre-transaction gate.
    row(
      'company',
      t('field.company'),
      current.companyName,
      <span className="text-sm text-muted-foreground">{t('form.companyReadOnly')}</span>,
    ),
    row('businessUnit', t('field.businessUnit'), nameOf(businessUnits, current.businessUnitId),
      select('businessUnitId', current.businessUnitId, businessUnits, t('form.none'))),
    row('orgDivision', t('field.orgDivision'), current.orgDivision, text('orgDivision', current.orgDivision)),
    row('department', t('field.department'), nameOf(departments, current.departmentId),
      select('departmentId', current.departmentId, departments, null)),
    row('position', t('field.position'), nameOf(positions, current.positionId),
      select('positionId', current.positionId, positions, t('form.none'))),
    row('grade', t('field.grade'), nameOf(grades, current.gradeId),
      select('gradeId', current.gradeId, grades, t('form.none'))),
    row('category', t('field.employmentCategory'), current.employmentCategory,
      text('employmentCategory', current.employmentCategory)),
    row('orgRegion', t('field.orgRegion'), current.orgRegion, text('orgRegion', current.orgRegion)),
    row('orgBranch', t('field.orgBranch'), current.orgBranch, text('orgBranch', current.orgBranch)),
    row('orgTeam', t('field.orgTeam'), current.orgTeam, text('orgTeam', current.orgTeam)),
    row('orgSection', t('field.orgSection'), current.orgSection, text('orgSection', current.orgSection)),
    row('orgLine', t('field.orgLine'), current.orgLine, text('orgLine', current.orgLine)),
    row('orgBase', t('field.orgBase'), current.orgBase, text('orgBase', current.orgBase)),
    row('location', t('form.location'), nameOf(locations, current.locationId),
      select('locationId', current.locationId, locations, t('form.none'))),
    row('employmentType', t('field.employmentType'),
      employmentTypes.find((o) => o.value === current.employmentType)?.label ?? null,
      <select name="employmentType" defaultValue={current.employmentType ?? ''} className={inputCls}>
        {employmentTypes.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>),
    row('manager', t('field.directSuperior'), nameOf(managers, current.managerEmploymentId),
      select('managerEmploymentId', current.managerEmploymentId, managers, t('form.none'))),
    row('basicSalary', t('field.basicSalary'), current.basicSalary,
      <input
        name="basicSalary"
        type="number"
        min={0}
        step="0.01"
        defaultValue={current.basicSalary ?? ''}
        className={inputCls}
      />),
    row('currency', t('field.currency'), current.currency,
      <CurrencySelect name="currency" value={current.currency} />),
    // Labels via the KNOWN option lists only — a stored value outside them falls back to itself rather
    // than rendering a raw i18n key (same rule as the event-type label map above).
    row('payMode', t('field.payMode'), payModeLabel(current.payMode),
      <select name="payMode" defaultValue={current.payMode ?? 'monthly'} className={inputCls}>
        {PAY_MODE_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {tPay(`payMode_${m}` as 'payMode_monthly')}
          </option>
        ))}
      </select>),
    row('paymentTerm', t('field.paymentTerm'), paymentTermLabel(current.paymentTerm),
      <select name="paymentTerm" defaultValue={current.paymentTerm ?? 'monthly'} className={inputCls}>
        {PAYMENT_TERM_OPTIONS.map((f) => (
          <option key={f} value={f}>
            {tPay(`paymentTerm_${f}` as 'paymentTerm_monthly')}
          </option>
        ))}
      </select>),
  ];

  const kindOptions: readonly string[] = edit ? edit.allowedKinds : KINDS;

  return (
    <form action={edit ? editMovementEventAction : createMovementEventAction}>
      <input type="hidden" name="employmentId" value={employmentId} />
      {edit && <input type="hidden" name="movementId" value={edit.movementId} />}

      {edit && (
        // The one thing HR must understand before saving: this does not quietly rewrite the old entry.
        <p className="border-b border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          {t('form.editHint')}
        </p>
      )}
      {edit?.payrollWarning && (
        <p className="border-b border-border bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          {t('form.payrollWarning')}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('form.eventType')}
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
            {kindOptions.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </label>

        {showEffectiveDate && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('form.effectiveDate')}
            <input
              name="effectiveDate"
              type="date"
              required
              defaultValue={edit?.effectiveDate ?? today}
              className={inputCls}
            />
            {DATE_VALUE_KINDS.includes(kind) && (
              <span className="text-xs text-muted-foreground">
                {kind === 'joinDateChange' ? t('form.joinDateChangeHint') : t('form.groupJoinDateCorrectionHint')}
              </span>
            )}
          </label>
        )}

        {showEndDate && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('form.endDate')}
            <input
              name="endDate"
              type="date"
              required={kind === 'probationExtension'}
              defaultValue={edit?.endDate ?? ''}
              className={inputCls}
            />
          </label>
        )}

        {showTerminationType && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('form.terminationType')}
            <select name="terminationType" defaultValue="" className={inputCls}>
              {terminationTypes.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {showBlacklist && (
          // The folded-in Blacklist box: Set / Clear map to the same audited service the old card used.
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('form.blacklistStatus')}
            <select name="blacklisted" defaultValue={isBlacklisted ? 'false' : 'true'} className={inputCls}>
              <option value="true">{t('form.blacklistSet')}</option>
              <option value="false">{t('form.blacklistClear')}</option>
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
          {t('form.remarks')}
          <input name="remarks" maxLength={200} defaultValue={edit?.remarks ?? ''} className={inputCls} />
        </label>

        {edit && (
          // Audit-trail requirement 4: WHY the record was corrected, alongside the who/what/when the
          // ledger already captures. Optional — a blank reason must never block a correction.
          <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
            {t('form.correctionReason')}
            <input name="reason" maxLength={200} className={inputCls} />
          </label>
        )}
      </div>

      {isComparison && (
        <div className="border-t border-border">
          <div className="hidden bg-muted/50 px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4">
            <div className="font-medium">{t('detail.field')}</div>
            <div className="font-medium">{t('form.currentInformation')}</div>
            <div className="font-medium">{t('form.afterInformation')}</div>
          </div>
          {comparisonRows}
          <p className="px-4 py-3 text-xs text-muted-foreground">{t('form.comparisonHint')}</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border p-4">
        <a href={cancelHref} className={btnGhost}>
          {t('form.cancel')}
        </a>
        {kind === 'termination' && !edit ? (
          <ConfirmSubmit
            title={t('form.terminateConfirmTitle')}
            description={t('form.terminateConfirmDescription')}
            confirmLabel={t('form.save')}
            size="sm"
          >
            {t('form.save')}
          </ConfirmSubmit>
        ) : (
          <button className={btnPrimary}>{edit ? t('form.saveCorrection') : t('form.save')}</button>
        )}
      </div>
    </form>
  );
}
