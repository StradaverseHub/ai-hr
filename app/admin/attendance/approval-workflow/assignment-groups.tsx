'use client';
import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { ATTENDANCE_CRITERIA_GROUP_LIMIT, attendanceCriteriaFromGroups, attendanceCriteriaGroups, type AttendanceCriteriaGroup, type AttendanceWorkflowCriteria } from '@/lib/attendance-workflow';
type Field = { key: keyof AttendanceCriteriaGroup; label: string; options: { id: string; name: string }[] };
/** Workflow Assignment as OR groups: inside a group every chosen field must match; any group assigns the employee. */
export function AssignmentGroupsEditor({ criteria, fields, onChange }: { criteria: AttendanceWorkflowCriteria; fields: Field[]; onChange: (criteria: AttendanceWorkflowCriteria) => void }) {
  const t = useTranslations('attendanceWorkflow'), g = useTranslations('attendanceWorkflow.groups'), choices = useTranslations('admin.leave');
  const groups = attendanceCriteriaGroups(criteria);
  // Stable keys keep each uncontrolled chip selector bound to its own group after a removal.
  const next = useRef(groups.length), keys = useRef(groups.map((_, index) => index));
  const commit = (value: AttendanceCriteriaGroup[]) => onChange(attendanceCriteriaFromGroups(value));
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{g('help')}</p>
    {groups.map((group, groupIndex) => <div key={keys.current[groupIndex]} className="space-y-3">
      {groupIndex > 0 && <p className="flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-primary" aria-hidden="true"><span className="h-px flex-1 bg-border"/>{g('or')}<span className="h-px flex-1 bg-border"/></p>}
      <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4" aria-label={g('groupNumber', { number: groupIndex + 1 })}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{g("groupNumber", { number: groupIndex + 1 })}</h3>
          {groups.length > 1 && <Button type="button" variant="ghost" onClick={() => { keys.current = keys.current.filter((_, i) => i !== groupIndex); commit(groups.filter((_, i) => i !== groupIndex)); }}>{g('remove', { number: groupIndex + 1 })}</Button>}</div>
        <div className="grid gap-4 sm:grid-cols-2">{fields.map(({ key, label, options: items }) => {
          const selected = group[key] ?? [];
          const unavailable = selected.filter(id => !items.some(item => item.id === id));
          return <ChipMultiSelect key={key} name={groups.length > 1 ? `${key}-${groupIndex}` : key} label={t(label)}
            options={[...items.map(item => ({ value: item.id, label: item.name })), ...unavailable.map(id => ({ value: id, label: t('unavailable', { value: id }) }))]}
            defaultSelected={selected} addPlaceholder={choices('eligibilityChipAddPlaceholder')} removeLabelFor={value => choices('chipRemoveAria', { name: value })}
            searchPlaceholder={choices('adjustmentsSearchPlaceholder')} selectAllLabel={choices('adjustmentsSelectAll')} clearAllLabel={choices('adjustmentsDeselectAll')}
            onSelectionChange={values => commit(groups.map((old, i) => i === groupIndex ? { ...old, [key]: values } : old))}/>;
        })}</div>
      </fieldset>
    </div>)}
    <Button type="button" variant="secondary" disabled={groups.length >= ATTENDANCE_CRITERIA_GROUP_LIMIT} onClick={() => { keys.current = [...keys.current, next.current++]; commit([...groups, {}]); }}>{g('add')}</Button>
  </div>;
}
