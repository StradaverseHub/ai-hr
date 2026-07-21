'use client';

// Movement tab redesign (78853b97) — client half of "New Event": the event-type select drives
// progressive disclosure of the type-specific fields (precedent: documents-manager.tsx). Every option
// list is pre-loaded and pre-translated by the server page; this island owns only the disclosure state.
// The submit posts to createMovementEventAction (admin-gated + audited in core/movement.ts, which
// delegates to the existing writers). The tab shell injects the hidden `tab` field on submit, so the
// save lands back on the Movement tab.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { createMovementEventAction } from './actions';

export type MovementOption = { id: string; name: string };

// Literal styling tokens (documents-manager precedent — never import a server module into this bundle).
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50';
const btnGhost =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium transition hover:bg-accent';

// This round's creatable event set (mirrors core/movement.ts MOVEMENT_KINDS; Rehire/Custom deferred).
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
] as const;

export function MovementNewEvent({
  employmentId,
  today,
  isBlacklisted,
  defaultGradeId,
  departments,
  positions,
  businessUnits,
  grades,
  locations,
  managers,
  employmentTypes,
  terminationTypes,
  cancelHref,
}: {
  employmentId: string;
  today: string;
  isBlacklisted: boolean;
  defaultGradeId: string;
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
}) {
  const t = useTranslations('people.detail.movement');
  const [kind, setKind] = useState<string>('transfer');

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
      default: return k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    }
  };

  const showOrgPickers = ['transfer', 'promotion', 'demotion', 'orgAssignmentChange'].includes(kind);
  const showBusinessUnit = ['promotion', 'demotion', 'orgAssignmentChange'].includes(kind);
  const showLocation = kind === 'transfer';
  const showGrade = ['promotion', 'demotion'].includes(kind);
  const showEmploymentType = kind === 'employmentTypeChange';
  const showSalary = ['increment', 'salaryAdjustment'].includes(kind);
  const showManager = kind === 'reportingLineChange';
  const showTerminationType = kind === 'termination';
  const showBlacklist = kind === 'blacklist';
  const showEndDate = ['probationExtension', 'secondment', 'actingPosition', 'resignation'].includes(kind);
  const showEffectiveDate = kind !== 'blacklist';

  const optionSelect = (name: string, label: string, options: MovementOption[], emptyLabel: string, defaultValue = '') => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select name={name} defaultValue={defaultValue} className={inputCls}>
        <option value="">{emptyLabel}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form action={createMovementEventAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
      <input type="hidden" name="employmentId" value={employmentId} />

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t('form.eventType')}
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
      </label>

      {showEffectiveDate && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('form.effectiveDate')}
          <input name="effectiveDate" type="date" required defaultValue={today} className={inputCls} />
        </label>
      )}

      {showEndDate && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('form.endDate')}
          <input name="endDate" type="date" required={kind === 'probationExtension'} className={inputCls} />
        </label>
      )}

      {showOrgPickers && optionSelect('departmentId', t('form.department'), departments, t('form.keepCurrent'))}
      {showOrgPickers && optionSelect('positionId', t('form.position'), positions, t('form.keepCurrent'))}
      {showBusinessUnit && optionSelect('businessUnitId', t('form.businessUnit'), businessUnits, t('form.keepCurrent'))}
      {showLocation && optionSelect('locationId', t('form.location'), locations, t('form.keepCurrent'))}

      {showGrade && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('form.grade')}
          <select name="gradeId" defaultValue={defaultGradeId} className={inputCls}>
            <option value="">{t('form.none')}</option>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {showEmploymentType && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('form.employmentType')}
          <select name="employmentType" required className={inputCls}>
            {employmentTypes.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {showSalary && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('form.basicSalary')}
          <input name="basicSalary" type="number" min={0} step="0.01" required className={inputCls} />
        </label>
      )}

      {showManager && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('form.manager')}
          <select name="managerEmploymentId" required className={inputCls}>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
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
        <input name="remarks" maxLength={200} className={inputCls} />
      </label>

      <div className="flex items-center justify-end gap-2 sm:col-span-2">
        <a href={cancelHref} className={btnGhost}>
          {t('form.cancel')}
        </a>
        {kind === 'termination' ? (
          <ConfirmSubmit
            title={t('form.terminateConfirmTitle')}
            description={t('form.terminateConfirmDescription')}
            confirmLabel={t('form.save')}
            size="sm"
          >
            {t('form.save')}
          </ConfirmSubmit>
        ) : (
          <button className={btnPrimary}>{t('form.save')}</button>
        )}
      </div>
    </form>
  );
}
