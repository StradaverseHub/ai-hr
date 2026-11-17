'use client';
import {WorkforcePicker} from '@/components/workforce-picker';
// Board 511aa74a — New Event → Rehired. The previous period's values start the form; HR changes only what is
// different. Saving starts a NEW employment for the same person (core/rehire.ts); the previous period is not
// changed. Every option list is pre-loaded and pre-translated by the server page; the service re-checks all.
import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ActionButton } from '@/components/ui/action-button';
import { DateField } from '@/components/ui/date-field';
import { CurrencySelect } from '@/components/currency-select';
import { formatDmy } from '@/lib/date-display';
import { personnelFormLabel, personnelInput, personnelWorkflowCarry, personnelWorkflowControl, personnelWorkflowInput } from '@/lib/personnel-form-contract';
import { MOVEMENT_FORM_IDS } from '@/lib/movement-form-contract';
import type { EmployeeIdRule } from '@/lib/employee-id-mode';
import { rehireEmploymentAction } from './rehire-actions';

type Option = { id: string; name: string };
type OrgScope = { departments: Option[]; positions: Option[]; businessUnits: Option[] };

export type RehireFormValues = {
  companyId: string;
  departmentId: string | null;
  positionId: string | null;
  businessUnitId: string | null;
  employmentType: string;
  gradeId: string | null;
  basicSalary: string | null;
  currency: string | null;
  managerEmploymentId: string | null;
};

export type RehireFormProps = {
  /** The previous (resigned) period this event is recorded on. */
  employmentId: string;
  /** The Rehired catalogue code posted as the event type. */
  kindCode: string;
  personName: string;
  previousEmployeeCode: string | null;
  previousStart: string;
  previousEnd: string | null;
  /** The effective date must be after this date. */
  notOnOrBefore: string | null;
  defaults: RehireFormValues;
  companies: Option[];
  orgByCompany: Record<string, OrgScope>;
  grades: Option[];
  managers: (Option & { companyId: string })[];
  remoteManagers?:boolean;
  employmentTypes: { value: string; label: string }[];
  employeeIdRules: Record<string, EmployeeIdRule>;
  cancelHref: string;
};

const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 read-only:bg-muted/40';
const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50';
const btnGhost =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium transition hover:bg-accent';
const movementField = (name: keyof typeof MOVEMENT_FORM_IDS) => MOVEMENT_FORM_IDS[name];
const EMPLOYEE_CODE_FIELD = 'profile.personal_details.employeecode';
const GROUP_JOIN_DATE_FIELD = 'employment.employment_dates_and_service.hiredon';

/** The day after a 'YYYY-MM-DD' date (pure UTC arithmetic). */
function dayAfter(d: string): string {
  const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

export function RehireEventForm(props: RehireFormProps) {
  const t = useTranslations('people.detail.movement.rehire');
  const tPay = useTranslations('people.detail');
  const label = (id: string) => personnelFormLabel(id, (key, fallback) => key.startsWith('people.detail.') && tPay.has(key.slice(14)) ? tPay(key.slice(14)) : fallback);
  const [error, action, pending] = useActionState(rehireEmploymentAction, null);
  const firstDay = props.notOnOrBefore ? dayAfter(props.notOnOrBefore) : '';
  const [effectiveDate, setEffectiveDate] = useState(firstDay);
  const [companyId, setCompanyId] = useState(props.defaults.companyId);
  const scope: OrgScope = props.orgByCompany[companyId] ?? { departments: [], positions: [], businessUnits: [] };
  const rule = props.employeeIdRules[companyId];
  const suggested = rule?.hasConfig ? rule.sampleCode : '';
  const codeEditable = !rule?.hasConfig || rule.allowManualOverride;
  const [employeeCode, setEmployeeCode] = useState(suggested);
  // Changing the company changes whose numbering applies: show that company's suggestion again.
  const [codeCompany, setCodeCompany] = useState(companyId);
  if (codeCompany !== companyId) { setCodeCompany(companyId); setEmployeeCode(suggested); }
  const employeeIdMode = rule?.hasConfig && (!codeEditable || employeeCode.trim() === suggested) ? 'auto' : 'manual';
  const keep = (options: Option[], value: string | null) => (value && options.some((o) => o.id === value) ? value : '');
  const managers = props.managers.filter((m) => m.companyId === companyId || companyId === props.defaults.companyId);

  return (
    <form action={action} aria-busy={pending} className="space-y-0">
      <input type="hidden" name="employmentId" value={props.employmentId} />
      <input {...personnelWorkflowCarry(movementField('kind'), 'movement')} value={props.kindCode} />
      <input type="hidden" name="employeeIdMode" value={employeeIdMode} />
      {error && <p role="alert" className="border-b border-border bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
      <p data-testid="rehire-intro" className="m-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground">
        {t('intro', {
          name: props.personName,
          code: props.previousEmployeeCode ?? '—',
          start: formatDmy(props.previousStart),
          end: props.previousEnd ? formatDmy(props.previousEnd) : '—',
        })}
      </p>
      <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('effectiveDate')}
          <DateField
            {...personnelWorkflowControl(movementField('effectiveDate'), 'movement', 'record')}
            defaultValue={firstDay}
            onChange={(event) => setEffectiveDate(event.target.value)}
            className={inputCls}
            label={t('effectiveDate')}
          />
          {props.notOnOrBefore && <span>{t('effectiveDateHint', { date: formatDmy(props.notOnOrBefore) })}</span>}
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('employeeCode')}
          <input
            {...personnelInput(EMPLOYEE_CODE_FIELD, 'record', { manualEmployeeCode: !rule?.hasConfig })}
            value={employeeCode}
            readOnly={!codeEditable}
            onChange={(event) => setEmployeeCode(event.target.value)}
            className={inputCls}
          />
          <span>{!rule?.hasConfig ? t('employeeCodeManualHint') : codeEditable ? t('employeeCodeHint') : t('employeeCodeAutoHint')}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('groupJoinDate')}
          <input
            {...personnelInput(GROUP_JOIN_DATE_FIELD, 'edit')}
            key={effectiveDate}
            defaultValue={effectiveDate}
            className={inputCls}
          />
          <span>{t('groupJoinDateHint')}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('companyId'))}
          <select {...personnelWorkflowControl(movementField('companyId'), 'movement', 'edit')} value={companyId} onChange={(event) => setCompanyId(event.target.value)} className={inputCls}>
            {props.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('businessUnitId'))}
          <select key={`bu-${companyId}`} {...personnelWorkflowControl(movementField('businessUnitId'), 'movement', 'edit')} defaultValue={keep(scope.businessUnits, props.defaults.businessUnitId)} className={inputCls}>
            <option value="">{t('none')}</option>
            {scope.businessUnits.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('departmentId'))}
          <select key={`dept-${companyId}`} {...personnelWorkflowControl(movementField('departmentId'), 'movement', 'edit')} defaultValue={keep(scope.departments, props.defaults.departmentId)} className={inputCls}>
            <option value="">{t('selectPlaceholder')}</option>
            {scope.departments.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('positionId'))}
          <select key={`pos-${companyId}`} {...personnelWorkflowControl(movementField('positionId'), 'movement', 'edit')} defaultValue={keep(scope.positions, props.defaults.positionId)} className={inputCls}>
            <option value="">{t('none')}</option>
            {scope.positions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('gradeId'))}
          <select {...personnelWorkflowControl(movementField('gradeId'), 'movement', 'edit')} defaultValue={keep(props.grades, props.defaults.gradeId)} className={inputCls}>
            <option value="">{t('none')}</option>
            {props.grades.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('employmentType'))}
          <select {...personnelWorkflowControl(movementField('employmentType'), 'movement', 'edit')} defaultValue={props.defaults.employmentType} className={inputCls}>
            {props.employmentTypes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('basicSalary'))}
          <input {...personnelWorkflowInput(movementField('basicSalary'), 'movement', 'edit')} defaultValue={props.defaults.basicSalary ?? ''} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('currency'))}
          <CurrencySelect name={personnelWorkflowControl(movementField('currency'), 'movement', 'edit').name} value={props.defaults.currency} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {label(movementField('managerEmploymentId'))}
          {props.remoteManagers?<WorkforcePicker {...personnelWorkflowControl(movementField('managerEmploymentId'),'movement','edit')}
            subjectId={props.employmentId} companyId={companyId===props.defaults.companyId?undefined:companyId}
            value={keep(managers,props.defaults.managerEmploymentId)} namesOnly
            retained={managers.map(m=>({employmentId:m.id,name:m.name,companyId:m.companyId,employeeCode:null}))}/>:(          <select key={`mgr-${companyId}`} {...personnelWorkflowControl(movementField('managerEmploymentId'), 'movement', 'edit')} defaultValue={keep(managers, props.defaults.managerEmploymentId)} className={inputCls}>
            <option value="">{t('none')}</option>
            {managers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>)}

        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-3">
          {label(movementField('remarks'))}
          <input {...personnelWorkflowInput(movementField('remarks'), 'movement', 'edit')} maxLength={200} className={inputCls} />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border p-4">
        <a href={props.cancelHref} className={btnGhost}>{t('cancel')}</a>
        <ActionButton actionKind="saving" className={btnPrimary}>{t('save')}</ActionButton>
      </div>
    </form>
  );
}
