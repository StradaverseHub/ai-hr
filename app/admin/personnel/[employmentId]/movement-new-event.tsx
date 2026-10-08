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
import { DateField } from '@/components/ui/date-field';
import { CurrencySelect } from '@/components/currency-select';
import { PAY_MODE_OPTIONS, PAYMENT_TERM_OPTIONS } from '@/components/pay-structure-fields';
import { createMovementEventAction, editMovementEventAction } from './actions';

export type MovementOption = { id: string; name: string };
/** b7b22514 — a Direct Superior candidate, carrying the company that decides whether an Entity Transfer
 *  may leave the employee reporting to them. */
export type MovementManagerOption = MovementOption & { companyId: string };
/** b7b22514 — one destination company's org pickers, so the grid can re-scope without a round trip. */
export type MovementOrgScope = {
  departments: MovementOption[];
  positions: MovementOption[];
  businessUnits: MovementOption[];
  locations: MovementOption[];
};

/** The employee's current record, as the server read it — ids for pickers, text for the flat columns. */
export type MovementCurrentValues = {
  companyName: string | null;
  /** b7b22514 — the raw id, because Entity Transfer makes Company an editable field and a select needs a
   *  value, not a label. Every other kind still renders `companyName` read-only. */
  companyId: string;
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

/**
 * 476f23ed — the FALLBACK order of the built-in kinds. The list the form actually offers now comes from
 * the server as `types` (the tenant's Movement Settings catalogue, already filtered to the active ones and
 * already labelled). This constant remains only as the ordering the catalogue follows and as the safety
 * net for a render with no types at all — it mirrors core/movement-kinds.ts MOVEMENT_KINDS.
 */
const KINDS = [
  'transfer',
  // b7b22514 — Entity Transfer sits next to Transfer because that is what it is: the same form, the same
  // validations, plus the one field no other event may move.
  'entityTransfer',
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
 *  answer is "this IS the new date".
 *  3ced1040 — Confirmation belongs here too, and now needs the hint more than either of the others: it is
 *  the only one that ALSO shows the comparison grid, so without a word the date reads as "when the pay
 *  rise applies" rather than "the day this person is confirmed". It is both. */
const DATE_VALUE_KINDS: readonly string[] = [
  'joinDateChange',
  'groupJoinDateCorrection',
  'confirmation',
  // b7b22514 — an Entity Transfer's effective date is BOTH: the day the move takes effect AND the
  // employee's new Join Date with the company they are moving to. It needs the hint more than Confirmation
  // does, because the date it silently writes is one HR used to have to type on a second screen.
  'entityTransfer',
];

// Mirrors core/movement.ts COMPARISON_KINDS — the kinds that render the Current / After grid.
// 3ced1040 added `confirmation` to both; the two lists must move together or the grid does not render.
const COMPARISON_KINDS: readonly string[] = [
  'transfer',
  'entityTransfer',
  'promotion',
  'demotion',
  'increment',
  'salaryAdjustment',
  'orgAssignmentChange',
  'employmentTypeChange',
  'reportingLineChange',
  'confirmation',
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
  terminationReasons,
  types,
  companies,
  orgByCompany,
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
  managers: MovementManagerOption[];
  /** Pre-translated by the server page (reuses the existing people.detail labels). */
  employmentTypes: { value: string; label: string }[];
  /**
   * ae9350f2 — the built-in exit-reason catalogue (core/termination-reason.ts), pre-translated and grouped
   * by category on the server. `typeLabel` is the turnover classification the code derives, shown read-only
   * beside the picker so HR can see what the exit will be reported as without being able to contradict it.
   */
  terminationReasons: { code: string; category: string; categoryLabel: string; label: string; typeLabel: string }[];
  /**
   * 476f23ed — the event types this organisation offers, from Movement Settings. `code` is what the ledger
   * records; `label` is the organisation's own name (null = use the shipped translation); `behaviourKind`
   * is the built-in kind whose behaviour it carries, and it — not the code — decides which fields this form
   * asks for. That is how a tenant's own "Redeployment" gets the Transfer form without the form knowing
   * anything about Redeployment.
   */
  types?: { code: string; label: string | null; behaviourKind: string }[];
  /**
   * b7b22514 — the legal entities an Entity Transfer may move this employee to: the current one (always
   * first, it is the select's initial value) followed by every company the actor ADMINISTERS. That set is
   * the same one the writer accepts, so what the form offers and what the service permits cannot drift.
   */
  companies?: MovementOption[];
  /**
   * b7b22514 — each of those companies' org pickers, keyed by company id. Picking a destination re-scopes
   * the Department / Position / Business Unit / Location selects to it IN THE BROWSER, so an incoherent
   * cross-company placement is never offered — rather than offered and then refused on save.
   */
  orgByCompany?: Record<string, MovementOrgScope>;
  cancelHref: string;
  edit?: MovementEditTarget;
}) {
  const t = useTranslations('people.detail.movement');
  const tPay = useTranslations('people.detail');
  // 476f23ed — the catalogue, with the built-in list as the fallback for a render that was given none.
  const catalog = types?.length ? types : KINDS.map((k) => ({ code: k, label: null, behaviourKind: k }));
  const byCode = new Map(catalog.map((c) => [c.code, c]));
  /** What a code DOES. Every branch below asks this, never the code itself. */
  const behaviourOf = (k: string): string => byCode.get(k)?.behaviourKind ?? k;
  const [kind, setKind] = useState<string>(edit?.kind ?? catalog[0]?.code ?? 'transfer');
  const behaviour = behaviourOf(kind);

  // Static-key label map with a humanized fallback for future kinds — no dynamic t() keys, so a raw
  // key can never render in any locale.
  const kindLabel = (k: string): string => {
    // 476f23ed — the organisation's own name wins; null means they never renamed it.
    const configured = byCode.get(k)?.label;
    if (configured) return configured;
    switch (k) {
      case 'transfer': return t('eventType.transfer');
      case 'entityTransfer': return t('eventType.entityTransfer');
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

  const isComparison = COMPARISON_KINDS.includes(behaviour);
  /**
   * b7b22514 — ENTITY TRANSFER. The destination company is form STATE, not just a submitted value, because
   * picking it has to re-scope the org pickers below it: the department list of the company they are
   * LEAVING is exactly the list they must not choose from.
   *
   * `scopeCompanyId` is therefore the company whose labels the grid offers — the chosen destination on an
   * Entity Transfer, the employee's own company on every other kind. When the destination has no entry in
   * `orgByCompany` (an actor who does not administer it, so it was never loaded) the fall-back is the
   * props the page already passes, which are the current company's: the same lists the form has always
   * shown, never a wider set.
   */
  const isEntityTransfer = behaviour === 'entityTransfer';
  const [destCompanyId, setDestCompanyId] = useState<string>(current.companyId);
  const scopeCompanyId = isEntityTransfer ? destCompanyId : current.companyId;
  const scopeChanged = scopeCompanyId !== current.companyId;
  const scoped: MovementOrgScope = orgByCompany?.[scopeCompanyId] ?? {
    departments,
    positions,
    businessUnits,
    locations,
  };
  // The Direct Superior must belong to the company the employee lands in — the service refuses anything
  // else, so the picker must not offer it.
  const scopedManagers = managers.filter((m) => !scopeChanged || m.companyId === scopeCompanyId);
  // ae9350f2 — Termination now has a structured exit block. The old free `terminationType` picker is GONE:
  // the reason is the single thing HR picks and the classification is derived from it server-side, so the
  // two can never be saved in contradiction (a Misconduct exit filed as "voluntary" is a real data fault,
  // and nothing in the record says which of the two the user meant).
  const isTermination = behaviour === 'termination';
  const showBlacklist = behaviour === 'blacklist';
  const showEndDate = ['probationExtension', 'secondment', 'actingPosition', 'resignation', 'termination'].includes(behaviour);
  const showEffectiveDate = behaviour !== 'blacklist';
  const [terminationReason, setTerminationReason] = useState<string>('');
  // "Resignation Date — mandatory for resignation cases" (the reporter's rule). Shown only for that reason,
  // because for a dismissal or a contract expiry there is no resignation to date.
  const showResignationDate = isTermination && terminationReason === 'resignation';
  const terminationTypeLabel =
    terminationReasons.find((r) => r.code === terminationReason)?.typeLabel ?? null;

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

  /**
   * b7b22514 — two things were added here, and both exist only because the option list can now CHANGE
   * while the form is open (an Entity Transfer re-scoping to the destination company).
   *
   * `key` forces a REMOUNT when the scope changes. These are uncontrolled selects: without it React keeps
   * the DOM node and `defaultValue` is ignored on re-render, so the browser would silently keep whatever
   * was selected — or, if that option no longer exists, fall back to the first one in the new list. Either
   * way HR would submit a value they never chose.
   *
   * `preselect` refuses to pre-fill an id the new list does not contain, and the placeholder option below
   * is what that empties INTO. A required picker (emptyLabel null — Department) normally has no empty
   * option, which is right when the stored value is always in the list; on a company move it is not, and
   * without somewhere valid to sit the browser would auto-select the destination's first department. An
   * empty submission is refused by name ("Department is required"), which is the honest outcome.
   */
  const select = (
    name: string,
    value: string | null,
    options: MovementOption[],
    emptyLabel: string | null,
  ) => {
    const preselect = options.some((o) => o.id === value) ? (value ?? '') : '';
    return (
      <select key={`${name}-${scopeCompanyId}`} name={name} defaultValue={preselect} className={inputCls}>
        {(emptyLabel != null || preselect === '') && (
          <option value="">{emptyLabel ?? t('form.selectPlaceholder')}</option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  };

  const text = (name: string, value: string | null) => (
    <input name={name} defaultValue={value ?? ''} maxLength={120} className={inputCls} />
  );

  // The requested field order, top to bottom (feedback 08913328).
  const comparisonRows: React.ReactNode[] = [
    /**
     * b7b22514 — THE ONE PLACE COMPANY IS EDITABLE, and only on this one event type. Everywhere else it
     * stays the read-only note it has always been: moving an employee between legal entities re-homes
     * their statutory registration, payroll policy, approval routing and every company-scoped org label,
     * so it is a movement HR records deliberately, never a field they can nudge while doing something
     * else. The service ignores a submitted companyId on every other kind, so this is a rule and not
     * merely an absent control.
     */
    row(
      'company',
      t('field.company'),
      current.companyName,
      isEntityTransfer ? (
        <select
          name="companyId"
          value={destCompanyId}
          onChange={(e) => setDestCompanyId(e.target.value)}
          className={inputCls}
        >
          {(companies?.length ? companies : [{ id: current.companyId, name: current.companyName ?? '' }]).map(
            (c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ),
          )}
        </select>
      ) : (
        <span className="text-sm text-muted-foreground">{t('form.companyReadOnly')}</span>
      ),
    ),
    row('businessUnit', t('field.businessUnit'), nameOf(businessUnits, current.businessUnitId),
      select('businessUnitId', current.businessUnitId, scoped.businessUnits, t('form.none'))),
    row('orgDivision', t('field.orgDivision'), current.orgDivision, text('orgDivision', current.orgDivision)),
    row('department', t('field.department'), nameOf(departments, current.departmentId),
      select('departmentId', current.departmentId, scoped.departments, null)),
    row('position', t('field.position'), nameOf(positions, current.positionId),
      select('positionId', current.positionId, scoped.positions, t('form.none'))),
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
      select('locationId', current.locationId, scoped.locations, t('form.none'))),
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
      select('managerEmploymentId', current.managerEmploymentId, scopedManagers, t('form.none'))),
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

  const kindOptions: readonly string[] = edit ? edit.allowedKinds : catalog.map((c) => c.code);

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
            <DateField
              name="effectiveDate"
              required
              defaultValue={edit?.effectiveDate ?? today}
              className={inputCls}
              label={t('form.effectiveDate')}
            />
            {DATE_VALUE_KINDS.includes(behaviour) && (
              <span className="text-xs text-muted-foreground">
                {behaviour === 'joinDateChange'
                  ? t('form.joinDateChangeHint')
                  : behaviour === 'confirmation'
                    ? t('form.confirmationHint')
                    : isEntityTransfer
                      ? t('form.entityTransferDateHint')
                      : t('form.groupJoinDateCorrectionHint')}
              </span>
            )}
          </label>
        )}

        {showEndDate && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {/* ae9350f2 — for a Termination this slot IS the Last Working Day, and it is mandatory. Same
                column, same meaning as on a Resignation; only the label differs so it reads as what it is. */}
            {isTermination ? t('form.lastWorkingDay') : t('form.endDate')}
            <DateField
              name="endDate"
              required={behaviour === 'probationExtension' || isTermination}
              defaultValue={edit?.endDate ?? ''}
              className={inputCls}
              label={isTermination ? t('form.lastWorkingDay') : t('form.endDate')}
            />
          </label>
        )}

        {isTermination && (
          <>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('form.terminationReason')}
              <select
                name="terminationReasonCode"
                required
                value={terminationReason}
                onChange={(e) => setTerminationReason(e.target.value)}
                className={inputCls}
              >
                <option value="">{t('form.terminationReasonPlaceholder')}</option>
                {/* One optgroup per category — the Voluntary / Involuntary split the reporter asked for.
                    Deduped on the fly so the grouping comes from the catalogue's own order, not a second list. */}
                {[...new Set(terminationReasons.map((r) => r.category))].map((cat) => (
                  <optgroup key={cat} label={terminationReasons.find((r) => r.category === cat)!.categoryLabel}>
                    {terminationReasons
                      .filter((r) => r.category === cat)
                      .map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              {/* Read-only, not a second control: the classification is DERIVED from the reason server-side. */}
              {terminationTypeLabel && (
                <span className="text-xs text-muted-foreground">
                  {t('form.terminationTypeDerived', { type: terminationTypeLabel })}
                </span>
              )}
            </label>

            {showResignationDate && (
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('form.resignationDate')}
                <DateField name="resignationDate" required className={inputCls} label={t('form.resignationDate')} />
              </label>
            )}

            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('form.terminationNoticeDays')}
              <input
                name="terminationNoticeDays"
                type="number"
                min={0}
                step={1}
                className={inputCls}
              />
            </label>
          </>
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
          // ledger already captures.
          // bd89ccd8 — MANDATORY now. A correction rolls the movement back before replaying it, so it
          // leaves the same `employment.movement.reversed` entry a plain rollback does; ten of the eleven
          // reversals on production carried no reason, and that is the audit gap. `required` here only
          // spares the round trip — editMovementEvent refuses a blank reason on its own.
          <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
            {t('form.correctionReason')}
            <input name="reason" required maxLength={200} className={inputCls} />
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
          <p className="px-4 py-3 text-xs text-muted-foreground">
            {/* b7b22514 — an Entity Transfer needs to say what the other kinds do not: that the org
                choices above it now belong to the DESTINATION company, and that group service is not
                affected. Both are things HR would otherwise have to find out by trying it. */}
            {isEntityTransfer ? t('form.entityTransferHint') : t('form.comparisonHint')}
          </p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border p-4">
        <a href={cancelHref} className={btnGhost}>
          {t('form.cancel')}
        </a>
        {behaviour === 'termination' && !edit ? (
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
