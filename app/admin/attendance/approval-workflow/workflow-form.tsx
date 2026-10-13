'use client';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { Button, Card, inputCls } from '@/components/ui';
import type { AttendanceWorkflowInput, AttendanceWorkflowCriteria } from '@/lib/attendance-workflow';
import { previewAttendanceWorkflowAction, saveAttendanceWorkflowAction } from './actions';
type Options = {
    companies: {
        id: string;
        name: string;
    }[];
    departments: {
        id: string;
        name: string;
    }[];
    businessUnits: {
        id: string;
        name: string;
    }[];
    grades: {
        id: string;
        name: string;
    }[];
    divisions: {
        id: string;
        name: string;
    }[];
};
const stage = (name: string) => ({ name, level: { kind: 'direct_manager' as const, employmentId: null, alternates: [] } });
export function WorkflowForm({ initial, lineageId, options }: {
    initial: AttendanceWorkflowInput | null;
    lineageId: string | null;
    options: Options;
}) {
    const t = useTranslations('attendanceWorkflow'), router = useRouter();
    const [input, setInput] = useState<AttendanceWorkflowInput>(initial ?? { companyId: options.companies[0]?.id ?? '', code: '', name: '', description: '', applicationType: 'irregularity', priority: 100, criteria: {}, stages: [stage('')], active: false });
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
        }[];
        truncated: boolean;
    } | null>(null);
    const baseline = JSON.stringify(initial ?? { companyId: options.companies[0]?.id ?? '', code: '', name: '', description: '', applicationType: 'irregularity', priority: 100, criteria: {}, stages: [stage('')], active: false });
    const dirty = JSON.stringify(input) !== baseline;
    const change = <K extends keyof AttendanceWorkflowInput>(k: K, v: AttendanceWorkflowInput[K]) => { setInput(p => ({ ...p, [k]: v })); setPreview(null); };
    const run = (save: boolean) => start(async () => {
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
    });
    const fields: [
        keyof AttendanceWorkflowCriteria,
        string,
        {
            id: string;
            name: string;
        }[]
    ][] = [['departmentIds', 'department', options.departments], ['businessUnitIds', 'businessUnit', options.businessUnits], ['gradeIds', 'grade', options.grades], ['orgDivision', 'division', options.divisions]];
    return <><AttendanceSettingsNavigation formId="attendance-workflow-form" savedRevision={savedRevision}/><form id="attendance-workflow-form" className="space-y-5" onSubmit={e => { e.preventDefault(); run(true); }}><fieldset disabled={pending} className="space-y-5">
  {error && <p role="alert" className="rounded-lg border border-red-300 p-3 text-sm text-red-700">{error}</p>}
  <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('information')}</h2><div className="grid gap-4 sm:grid-cols-2">
   <label>{t('company')}<select name="companyId" className={inputCls} value={input.companyId} disabled={!!lineageId || pending} onChange={e => change('companyId', e.target.value)}>{options.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   <label>{t('applicationType')}<select name="applicationType" className={inputCls} value={input.applicationType} disabled={!!lineageId || pending} onChange={e => change('applicationType', e.target.value as AttendanceWorkflowInput['applicationType'])}><option value="irregularity">{t('types.irregularity')}</option><option value="self_overtime">{t('types.self_overtime')}</option></select></label>
   <label>{t('code')}<input name="code" required maxLength={40} pattern="[A-Za-z0-9_-]+" className={inputCls} value={input.code} onChange={e => change('code', e.target.value)}/></label>
   <label>{t('name')}<input name="name" required maxLength={120} className={inputCls} value={input.name} onChange={e => change('name', e.target.value)}/></label>
  </div><label className="block">{t('description')}<textarea name="description" maxLength={1000} className={inputCls} value={input.description ?? ''} onChange={e => change('description', e.target.value)}/></label></Card>
  <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('assignment')}</h2><p className="text-sm text-muted-foreground">{t('assignmentHelp')}</p><label className="block max-w-xs">{t('priority')}<input name="priority" required type="number" min={0} max={9999} className={inputCls} value={input.priority} onChange={e => change('priority', Number(e.target.value))}/></label><div className="grid gap-4 sm:grid-cols-2">{fields.map(([key, label, items]) => <label key={key}>{t(label)}<select name={key} multiple size={Math.min(5, Math.max(2, items.length))} className={inputCls} value={input.criteria[key] ?? []} onChange={e => change('criteria', { ...input.criteria, [key]: Array.from(e.target.selectedOptions).map(o => o.value) })}>{items.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}</div></Card>
  <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('stages')}</h2><p className="text-sm text-muted-foreground">{t('supportedApprovers')}</p><p className="text-sm text-muted-foreground">{t('alternativeHelp')}</p><ol className="space-y-4">{input.stages.map((s, i) => <li key={i} className="space-y-3 rounded-lg border border-border p-4"><div className="flex items-center justify-between"><span className="font-medium">{t('stageNumber', { number: i + 1 })}</span><div className="flex gap-2"><button type="button" disabled={i === 0 || pending} onClick={() => { const stages = [...input.stages]; [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]]; change('stages', stages); }}>{t('moveUp')}</button><button type="button" disabled={input.stages.length === 1 || pending} onClick={() => change('stages', input.stages.filter((_, n) => n !== i))}>{t('remove')}</button></div></div><label className="block">{t('stageName')}<input name={`stages.${i}.name`} required maxLength={100} className={inputCls} value={s.name} onChange={e => change('stages', input.stages.map((row, n) => n === i ? { ...row, name: e.target.value } : row))}/></label><label className="block">{t('approver')}<select name={`stages.${i}.kind`} className={inputCls} value={s.level.kind} onChange={e => change('stages', input.stages.map((row, n) => n === i ? { ...row, level: { kind: e.target.value as 'direct_manager' | 'hr_admin', employmentId: null, alternates: [] } } : row))}><option value="direct_manager">{t('manager')}</option><option value="hr_admin">{t('hr')}</option></select></label><label className="flex gap-2 text-sm"><input name={`stages.${i}.anyOne`} type="checkbox" checked={s.level.alternates.length > 0} onChange={e => change('stages', input.stages.map((row, n) => n === i ? { ...row, level: { ...row.level, alternates: e.target.checked ? [{ kind: row.level.kind === 'direct_manager' ? 'hr_admin' : 'direct_manager', employmentId: null }] : [] } } : row))}/>{t('anyOne')}</label></li>)}</ol><Button type="button" disabled={pending || input.stages.length >= 10} onClick={() => change('stages', [...input.stages, stage('')])}>{t('addStage')}</Button></Card>
  <Card className="space-y-3 p-5"><label className="flex gap-2"><input name="active" type="checkbox" checked={input.active} onChange={e => change('active', e.target.checked)}/>{t('activate')}</label><p className="text-sm text-muted-foreground">{t('activationHelp')}</p><div className="flex flex-wrap gap-3"><Button type="button" disabled={pending} onClick={() => run(false)}>{t('preview')}</Button><Button type="submit" disabled={pending || !options.companies.length}>{pending ? t('saving') : t('save')}</Button><button type="button" onClick={() => {
            if (!dirty || window.confirm(t('discard')))
                router.push('/admin/attendance/approval-workflow');
        }}>{t('cancel')}</button></div></Card>
  {preview && <Card className="space-y-3 p-5"><h2 className="font-semibold">{t('previewTitle', { count: preview.total })}</h2><ul className="divide-y divide-border">{preview.rows.map(row => <li key={row.employmentId} className="py-2 text-sm">{row.name} — {row.selectedCode}{row.problem && <p className="text-red-700">{row.problem}</p>}</li>)}</ul>{preview.truncated && <p>{t('previewTruncated')}</p>}</Card>}
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
            const { setAttendanceWorkflowEnabledAction } = await import('./actions');
            const result = await setAttendanceWorkflowEnabledAction(companyId, type, !enabled);
            if (!result.ok)
                setError(result.error);
            else
                router.refresh();
        })}>{enabled ? t('disableRouting') : t('enableRouting')}</button>{error && <p role="alert" className="text-red-700">{error}</p>}</div>;
}
