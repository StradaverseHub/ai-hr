'use client';
import { useRef, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { ATTENDANCE_CRITERIA_GROUP_LIMIT, ATTENDANCE_PROFILE_CRITERIA_KEYS, attendanceCriteriaFromGroups, attendanceCriteriaGroups, type AttendanceCriteriaGroup, type AttendanceWorkflowCriteria } from '@/lib/attendance-workflow';
import { EmployeeCriteriaPicker, criteriaEmployeeLabel, type CriteriaEmployee } from './employee-criteria-picker';
type Field = { key: keyof AttendanceCriteriaGroup; label: string; options: { id: string; name: string }[] };
const MORE = new Set<keyof AttendanceCriteriaGroup>(ATTENDANCE_PROFILE_CRITERIA_KEYS);

/** One group's "More conditions" (the eight organisation fields). Open by itself when any of them holds a value; after
 * that the person opening or closing it decides, so clearing the last value never collapses it under the cursor. */
function MoreConditions({ filled, fieldNames, children }: { filled: number; fieldNames: string; children: ReactNode }) {
  const g = useTranslations('attendanceWorkflow.groups');
  const [open, setOpen] = useState(filled > 0);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="border-t border-dashed border-border pt-3">
    <summary className="flex min-h-11 cursor-pointer items-center gap-1 text-sm font-medium text-primary">{g('more')}<span className="font-normal">{' – '}{filled ? g('moreSet', { count: filled }) : fieldNames}</span></summary>
    <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
  </details>;
}

/** Workflow Assignment as OR groups: inside a group every chosen field must match; any group assigns the employee. */
export function AssignmentGroupsEditor({ criteria, fields, employees = [], companyIds = [], onChange }: { criteria: AttendanceWorkflowCriteria; fields: Field[]; employees?: CriteriaEmployee[]; companyIds?: string[]; onChange: (criteria: AttendanceWorkflowCriteria) => void }) {
  const t = useTranslations('attendanceWorkflow'), g = useTranslations('attendanceWorkflow.groups'), choices = useTranslations('admin.leave'), format = useFormatter();
  const groups = attendanceCriteriaGroups(criteria);
  // Stable keys keep each uncontrolled chip selector bound to its own group after a removal.
  const next = useRef(groups.length), keys = useRef(groups.map((_, index) => index));
  // Labels of the chosen criteria employees: the saved ones from the page, the rest learnt from searches.
  const [known, setKnown] = useState(() => new Map(employees.map(person => [person.id, person] as const)));
  const learn = (rows: CriteriaEmployee[]) => setKnown(old => { if (rows.every(row => old.has(row.id))) return old; const map = new Map(old); for (const row of rows) map.set(row.id, row); return map; });
  const commit = (value: AttendanceCriteriaGroup[]) => onChange(attendanceCriteriaFromGroups(value));
  const valueName = (field: Field, id: string) => {
    if (field.key === 'employeeIds') { const person = known.get(id); return person ? criteriaEmployeeLabel(person) : t('unavailable', { value: id }); }
    return field.options.find(item => item.id === id)?.name ?? t('unavailable', { value: id });
  };
  // The one-line summary of what a group matches, built from the same field descriptors and labels.
  const summary = (group: AttendanceCriteriaGroup) => {
    const conditions = fields.filter(field => group[field.key]?.length).map(field => g('condition', { field: t(field.label), values: format.list(group[field.key]!.map(id => valueName(field, id)), { type: 'disjunction' }) }));
    return conditions.length ? g('summary', { conditions: format.list(conditions, { type: 'conjunction' }) }) : g('everyone');
  };
  const moreNames = format.list(fields.filter(field => MORE.has(field.key)).map(field => t(field.label)), { type: 'unit' });
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{g('help')}</p>
    {groups.map((group, groupIndex) => {
      const control = ({ key, label, options: items }: Field) => {
        const selected = group[key] ?? [];
        const name = groups.length > 1 ? `${key}-${groupIndex}` : key;
        const set = (values: string[]) => commit(groups.map((old, i) => i === groupIndex ? { ...old, [key]: values } : old));
        if (key === 'employeeIds') return <EmployeeCriteriaPicker key={key} name={name} label={t(label)} value={selected} known={known} companyIds={companyIds} onLearn={learn} onChange={set}/>;
        const unavailable = selected.filter(id => !items.some(item => item.id === id));
        return <ChipMultiSelect key={key} name={name} label={t(label)}
          options={[...items.map(item => ({ value: item.id, label: item.name })), ...unavailable.map(id => ({ value: id, label: t('unavailable', { value: id }) }))]}
          defaultSelected={selected} addPlaceholder={choices('eligibilityChipAddPlaceholder')} removeLabelFor={value => choices('chipRemoveAria', { name: value })}
          searchPlaceholder={choices('adjustmentsSearchPlaceholder')} selectAllLabel={choices('adjustmentsSelectAll')} clearAllLabel={choices('adjustmentsDeselectAll')}
          onSelectionChange={set}/>;
      };
      const main = fields.filter(field => !MORE.has(field.key)), more = fields.filter(field => MORE.has(field.key));
      return <div key={keys.current[groupIndex]} className="space-y-3">
        {groupIndex > 0 && <p className="flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-primary" aria-hidden="true"><span className="h-px flex-1 bg-border"/>{g('or')}<span className="h-px flex-1 bg-border"/></p>}
        <fieldset className="min-w-0 space-y-4 rounded-lg border border-border p-4" aria-label={g('groupNumber', { number: groupIndex + 1 })}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{g("groupNumber", { number: groupIndex + 1 })}</h3>
            {groups.length > 1 && <Button type="button" variant="ghost" className="text-primary" onClick={() => { keys.current = keys.current.filter((_, i) => i !== groupIndex); commit(groups.filter((_, i) => i !== groupIndex)); }}>{g('remove', { number: groupIndex + 1 })}</Button>}</div>
          <p className="rounded-md bg-muted px-3 py-2 text-sm" aria-live="polite">{summary(group)}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{main.map(control)}</div>
          {more.length > 0 && <MoreConditions filled={more.filter(field => group[field.key]?.length).length} fieldNames={moreNames}>{more.map(control)}</MoreConditions>}
        </fieldset>
      </div>;
    })}
    <Button type="button" variant="secondary" disabled={groups.length >= ATTENDANCE_CRITERIA_GROUP_LIMIT} onClick={() => { keys.current = [...keys.current, next.current++]; commit([...groups, {}]); }}>{g('add')}</Button>
  </div>;
}
