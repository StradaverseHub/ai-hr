'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AttendanceResolvedRoutePreview } from '@/components/attendance-resolved-route-preview';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { AttendanceStageEditor, emptyAttendanceStage } from './stage-editor';
import { companyWorkflowHref } from './navigation';
import { Button, Card, inputCls } from '@/components/ui';
import { attendanceWorkflowCriteriaFields, attendanceLevelName, type AttendanceWorkflowOptions, type AttendanceWorkflowInput, type AttendanceResolvedStage } from '@/lib/attendance-workflow';
import { previewAttendanceWorkflowAction, saveAttendanceWorkflowAction } from './actions';
export function WorkflowForm({ initial, lineageId, context, options }: {
    initial: AttendanceWorkflowInput | null;
    lineageId: string | null;
    context: Pick<AttendanceWorkflowInput, 'companyId' | 'applicationType'>;
    options: AttendanceWorkflowOptions;
}) {
    const employmentTypeLabel = useTranslations('people.wizard.employmentType');
    const t = useTranslations('attendanceWorkflow'), choices = useTranslations('admin.leave'), router = useRouter();
    const [input, setInput] = useState<AttendanceWorkflowInput>(initial ?? { ...context, routingVersion: 2, code: '', name: '', description: '', priority: 100, criteria: {}, stages: [emptyAttendanceStage(0, 2)], active: false });
    const [error, setError] = useState(''), [pending, start] = useTransition();
    const [savedRevision, setSavedRevision] = useState(0);
    const [savedDestination, setSavedDestination] = useState<string | null>(null);
    useEffect(() => {
        if (savedDestination) {
            router.push(savedDestination);
            router.refresh();
        }
    }, [savedDestination, router]);
    const [preview, setPreview] = useState<{
        total: number;
        rows: {
            employmentId: string;
            name: string;
            selectedCode: string;
            problem: string | null;
            routingVersion: 1 | 2;
            resolvedStages: AttendanceResolvedStage[];
        }[];
        truncated: boolean;
    } | null>(null);
    const baseline = JSON.stringify(initial ?? { ...context, routingVersion: 2, code: '', name: '', description: '', priority: 100, criteria: {}, stages: [emptyAttendanceStage(0, 2)], active: false });
    const dirty = JSON.stringify(input) !== baseline;
    const change = <K extends keyof AttendanceWorkflowInput>(k: K, v: AttendanceWorkflowInput[K]) => { setInput(p => ({ ...p, [k]: v })); setPreview(null); };
    const inFlight = useRef(false);
    const run = (save: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      start(async () => {
       try {
        setError('');
        if (save) {
            const result = await saveAttendanceWorkflowAction(lineageId, input);
            if (result.ok) {
                setSavedRevision(revision => revision + 1);
                setSavedDestination(`/admin/attendance/approval-workflow/${result.lineageId}`);
            }
            else
                setError(result.error);
        }
        else {
            const result = await previewAttendanceWorkflowAction(lineageId, input);
            if (result.ok)
                setPreview(result.preview);
            else
                setError(result.error);
        }
       } catch { setError(t('requestFailed')); } finally { inFlight.current = false; }
      });
    };
    const fields = attendanceWorkflowCriteriaFields(options, employmentTypeLabel);
    return <><AttendanceSettingsNavigation formId="attendance-workflow-form" savedRevision={savedRevision}/><form id="attendance-workflow-form" className="space-y-5" onSubmit={e => { e.preventDefault(); run(true); }}><fieldset disabled={pending} className="space-y-5">
  <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('information')}</h2><div className="grid gap-4 sm:grid-cols-2">
   <label>{t('company')}<select name="companyId" className={inputCls} value={input.companyId} disabled onChange={e => change('companyId', e.target.value)}>{options.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   <label>{t('applicationType')}<select name="applicationType" className={inputCls} value={input.applicationType} disabled onChange={e => change('applicationType', e.target.value as AttendanceWorkflowInput['applicationType'])}><option value="irregularity">{t('types.irregularity')}</option><option value="self_overtime">{t('types.self_overtime')}</option></select></label>
   <label>{t('code')}<input name="code" required maxLength={40} pattern="[A-Za-z0-9_-]+" className={inputCls} value={input.code} onChange={e => change('code', e.target.value)}/></label>
   <label>{t('name')}<input name="name" required maxLength={120} className={inputCls} value={input.name} onChange={e => change('name', e.target.value)}/></label>
  </div><label className="block">{t('description')}<textarea name="description" maxLength={1000} className={inputCls} value={input.description ?? ''} onChange={e => change('description', e.target.value)}/></label></Card>
  <div className="grid items-start gap-5 xl:grid-cols-2"><Card className="space-y-4 p-5"><h2 className="font-semibold">{t('assignment')}</h2><p className="text-sm text-muted-foreground">{t('assignmentHelp')}</p><label className="block max-w-xs">{t('priority')}<input name="priority" required type="number" min={0} max={9999} className={inputCls} value={input.priority} onChange={e => change('priority', Number(e.target.value))}/></label><div className="grid gap-4 sm:grid-cols-2">{fields.map(({ key, label, options: items }) => {
    const selected = input.criteria[key] ?? [];
    const unavailable = selected.filter(id => !items.some(item => item.id === id));
    return <ChipMultiSelect key={key} name={key} label={t(label)}
      options={[...items.map(item => ({ value: item.id, label: item.name })), ...unavailable.map(id => ({ value: id, label: t('unavailable', { value: id }) }))]}
      defaultSelected={selected} addPlaceholder={choices('eligibilityChipAddPlaceholder')} removeLabelFor={value => choices('chipRemoveAria', { name: value })}
      searchPlaceholder={choices('adjustmentsSearchPlaceholder')} selectAllLabel={choices('adjustmentsSelectAll')} clearAllLabel={choices('adjustmentsDeselectAll')}
      onSelectionChange={values => change('criteria', { ...input.criteria, [key]: values })}/>;
  })}</div></Card>
  <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('stages')}</h2>{(input.routingVersion ?? 1) === 1 ? <div className="space-y-2 rounded-md border border-border bg-background p-3"><p>{t('legacyLevelsHelp')}</p><Button type="button" variant="secondary" onClick={() => { setInput(p => ({ ...p, routingVersion: 2, stages: p.stages.map((stage, index) => ({ ...stage, name: attendanceLevelName(index) })) })); setPreview(null); }}>{t('convertHierarchy')}</Button></div> : <p className="text-sm text-muted-foreground">{t('hierarchyLevelsHelp')}</p>}<AttendanceStageEditor routingVersion={input.routingVersion ?? 1} stages={input.stages} onChange={stages => change('stages', stages)}/></Card></div>
  <Card className="space-y-3 p-5"><label className="flex gap-2"><input name="active" type="checkbox" checked={input.active} onChange={e => change('active', e.target.checked)}/>{t('activate')}</label><p className="text-sm text-muted-foreground">{t('activationHelp')}</p>{error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}<div className="flex flex-wrap gap-3"><Button type="button" disabled={pending} onClick={() => run(false)}>{t('preview')}</Button><Button type="submit" disabled={pending || !options.companies.length}>{pending ? t('saving') : t('save')}</Button><button type="button" onClick={() => {
            if (!dirty || window.confirm(t('discard')))
                router.push(companyWorkflowHref(input.companyId, input.applicationType));
        }}>{t('cancel')}</button></div></Card>
  {preview && <Card className="space-y-3 p-5"><h2 className="font-semibold">{t('previewTitle', { count: preview.total })}</h2><ul className="divide-y divide-border">{preview.rows.map(row => <li key={row.employmentId} className="py-2 text-sm">{row.name} — {row.selectedCode}{row.problem && <p className="text-red-700">{row.problem}</p>}<AttendanceResolvedRoutePreview stages={row.resolvedStages ?? []} routingVersion={row.routingVersion ?? 1} levelName={number => t('stageNumber', { number })} hrLabel={t('hr')} alternativeLabel={t('or')}/></li>)}</ul>{preview.truncated && <p>{t('previewTruncated')}</p>}</Card>}
 </fieldset></form></>;
}
export function RoutingSwitch({ companyId, type, enabled }: {
    companyId: string;
    type: AttendanceWorkflowInput['applicationType'];
    enabled: boolean;
}) {
    const t = useTranslations('attendanceWorkflow'), router = useRouter();
    const [pending, start] = useTransition(), [error, setError] = useState('');
    return <div><button type="button" disabled={pending} className="text-primary underline underline-offset-2" onClick={() => start(async () => {
            setError('');
            try {
                const { setAttendanceWorkflowEnabledAction } = await import('./actions');
                const result = await setAttendanceWorkflowEnabledAction(companyId, type, !enabled);
                if (!result.ok) setError(result.error);
                else router.refresh();
            } catch { setError(t('requestFailed')); }
        })}>{enabled ? t('disableRouting') : t('enableRouting')}</button>{error && <p role="alert" className="text-red-700">{error}</p>}</div>;
}
