'use client';
import {WorkflowCompanyContext} from './approver-picker';
import type {AnyAttendanceWorkflowInput} from '@/lib/attendance-workflow-config';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AttendanceResolvedRoutePreview } from '@/components/attendance-resolved-route-preview';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import {AttendanceStageEditorV4,AttendanceCcEditor,emptyAttendanceV4Level} from './stage-editor-v4';
import { AttendanceStageEditorV3, emptyAttendanceV3Level } from './stage-editor-v3';
import { attendanceLevelProblemMessageKey, type AttendanceLevelProblem, type AttendanceV3Level } from '@/lib/attendance-workflow-v3';
import { AttendanceStageEditor, emptyAttendanceStage } from './stage-editor';
import { companyWorkflowHref } from './navigation';
import { Button, Card, inputCls } from '@/components/ui';
import { attendanceWorkflowCriteriaFields, attendanceLevelName, type AttendanceWorkflowOptions, type AttendanceWorkflowInput, type AttendanceResolvedStage } from '@/lib/attendance-workflow';
import { previewAttendanceWorkflowAction, saveAttendanceWorkflowAction } from './actions';
export function WorkflowForm({ initial, lineageId, context, options, defaultPriority = 1 }: {
    initial: AnyAttendanceWorkflowInput | null;
    defaultPriority?: number;
    lineageId: string | null;
    context: Pick<AttendanceWorkflowInput, 'companyId' | 'applicationType'>;
    options: AttendanceWorkflowOptions;
}) {
    const employmentTypeLabel = useTranslations('people.wizard.employmentType');
    const v3 = useTranslations('attendanceWorkflow.v3');
    const t = useTranslations('attendanceWorkflow'), choices = useTranslations('admin.leave'), router = useRouter();
    const [input, setInput] = useState<AnyAttendanceWorkflowInput>(initial ?? { ...context, companyIds:options.canManageAllCompanies?options.companies.map(c=>c.id):[context.companyId], allCompanies:options.canManageAllCompanies===true, routingVersion: 4, cc:[], code: '', name: '', description: '', priority: defaultPriority, criteria: {}, stages: [emptyAttendanceV4Level(0)], active: true });
    const [levelProblems, setLevelProblems] = useState<AttendanceLevelProblem[]>([]);
    const [error, setError] = useState(''), [pending, start] = useTransition();
    const [savedRevision, setSavedRevision] = useState(0);
    const [savedDestination, setSavedDestination] = useState<string | null>(null);
    useEffect(() => {
        if (savedDestination) {
            router.push(savedDestination);
        }
    }, [savedDestination, router]);
    const [preview, setPreview] = useState<{
        total: number;
        rows: {
            employmentId: string;
            name: string;
            selectedCode: string;
            problem: string | null;
            routingVersion: 1 | 2 | 3 | 4;
            resolvedStages: AttendanceResolvedStage[];
            levelProblem: AttendanceLevelProblem | null;
        }[];
        truncated: boolean;
    } | null>(null);
    const baseline = JSON.stringify(initial ?? { ...context, companyIds:options.canManageAllCompanies?options.companies.map(c=>c.id):[context.companyId], allCompanies:options.canManageAllCompanies===true, routingVersion: 4, cc:[], code: '', name: '', description: '', priority: defaultPriority, criteria: {}, stages: [emptyAttendanceV4Level(0)], active: true });
    const dirty = JSON.stringify(input) !== baseline;
    const change = <K extends keyof AnyAttendanceWorkflowInput>(k: K, v: AnyAttendanceWorkflowInput[K]) => { setInput(p => ({ ...p, [k]: v } as AnyAttendanceWorkflowInput)); setPreview(null); };
    const inFlight = useRef(false);
    const priorityEdited = useRef(false);
    const saveAttempt = useRef<{intent:string;id:string} | null>(null);
    const run = (save: boolean) => {
      if (inFlight.current || savedDestination) return;
      inFlight.current = true;
      start(async () => {
       try {
        setError('');
        setLevelProblems([]);
        if (save) {
            const autoPriority = !lineageId && !priorityEdited.current;
            const intent = JSON.stringify({input,autoPriority,lineageId});
            if (saveAttempt.current?.intent !== intent) saveAttempt.current = {intent,id:crypto.randomUUID()};
            const result = await saveAttendanceWorkflowAction(lineageId, input, autoPriority, saveAttempt.current.id);
            if (result.ok) {
                setSavedRevision(revision => revision + 1);
                setSavedDestination(`/admin/attendance/approval-workflow/${result.lineageId}?notice=saved`);
            }
            else {
                setError(result.error);
                if ('levelProblem' in result && result.levelProblem) setLevelProblems([result.levelProblem]);
            }
        }
        else {
            const result = await previewAttendanceWorkflowAction(lineageId, input);
            if (result.ok) {
                setPreview(result.preview);
                setLevelProblems([]);
            }
            else {
                setError(result.error);
                if ('levelProblem' in result && result.levelProblem) setLevelProblems([result.levelProblem]);
            }
        }
       } catch { setError(t('requestFailed')); } finally { inFlight.current = false; }
      });
    };
    const fields = attendanceWorkflowCriteriaFields(options, employmentTypeLabel);
    return <WorkflowCompanyContext.Provider value={input.allCompanies?options.companies.map(c=>c.id):input.companyIds??[input.companyId]}><AttendanceSettingsNavigation formId="attendance-workflow-form" savedRevision={savedRevision}/><form id="attendance-workflow-form" className="space-y-5" onSubmit={e => { e.preventDefault(); run(true); }}><fieldset disabled={pending || !!savedDestination} className="min-w-0 space-y-5">
  <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('information')}</h2><div className="grid gap-4 sm:grid-cols-2">
   <div><label className="mb-3 flex min-h-11 items-center gap-2 text-sm"><input name="allCompanies" type="checkbox" checked={input.allCompanies===true} disabled={!options.canManageAllCompanies} onChange={event=>{const allCompanies=event.target.checked;setInput(old=>({...old,allCompanies,companyIds:allCompanies?options.companies.map(c=>c.id):[old.companyId]}));setPreview(null);}}/>{t('allCompany')}</label>
   {!input.allCompanies&&<ChipMultiSelect name="companyIds" label={t('company')} options={options.companies.map(c=>({value:c.id,label:c.name}))} defaultSelected={input.companyIds??[input.companyId]} addPlaceholder={t('chooseCompanies')} searchPlaceholder={t('searchCompanies')} removeLabelFor={value=>t('removeCompany',{value})} onSelectionChange={companyIds=>{setInput(old=>({...old,companyIds,companyId:companyIds.includes(old.companyId)?old.companyId:companyIds[0]??old.companyId}));setPreview(null);}}/>}<p className="mt-2 text-xs text-muted-foreground">{t(options.canManageAllCompanies?'allCompanyHelp':'allCompanyRestricted')}</p></div>
   <label>{t('applicationType')}<select name="applicationType" className={inputCls} value={input.applicationType} disabled onChange={e => change('applicationType', e.target.value as AttendanceWorkflowInput['applicationType'])}><option value="irregularity">{t('types.irregularity')}</option><option value="self_overtime">{t('types.self_overtime')}</option></select></label>
   <label>{t('code')}<input name="code" required maxLength={40} pattern="[A-Za-z0-9_-]+" className={inputCls} value={input.code} onChange={e => change('code', e.target.value)}/></label>
   <label>{t('name')}<input name="name" required maxLength={120} className={inputCls} value={input.name} onChange={e => change('name', e.target.value)}/></label>
  </div><label className="block">{t('description')}<textarea name="description" maxLength={1000} className={inputCls} value={input.description ?? ''} onChange={e => change('description', e.target.value)}/></label></Card>
  <div className="grid items-start gap-5 xl:grid-cols-2"><Card className="space-y-4 p-5"><h2 className="font-semibold">{t('assignment')}</h2><p className="text-sm text-muted-foreground">{t('assignmentHelp')}</p><label className="block max-w-xs">{t('priority')}<input name="priority" required type="number" min={0} max={9999} className={inputCls} value={input.priority} onChange={e => { priorityEdited.current = true; change('priority', Number(e.target.value)); }}/></label><div className="grid gap-4 sm:grid-cols-2">{fields.map(({ key, label, options: items }) => {
    const selected = input.criteria[key] ?? [];
    const unavailable = selected.filter(id => !items.some(item => item.id === id));
    return <ChipMultiSelect key={key} name={key} label={t(label)}
      options={[...items.map(item => ({ value: item.id, label: item.name })), ...unavailable.map(id => ({ value: id, label: t('unavailable', { value: id }) }))]}
      defaultSelected={selected} addPlaceholder={choices('eligibilityChipAddPlaceholder')} removeLabelFor={value => choices('chipRemoveAria', { name: value })}
      searchPlaceholder={choices('adjustmentsSearchPlaceholder')} selectAllLabel={choices('adjustmentsSelectAll')} clearAllLabel={choices('adjustmentsDeselectAll')}
      onSelectionChange={values => change('criteria', { ...input.criteria, [key]: values })}/>;
  })}</div></Card>
  <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('stages')}</h2>{input.routingVersion === 4
    ? <><AttendanceStageEditorV4 stages={input.stages} employees={options.approverEmployees ?? []} problems={levelProblems} onChange={stages=>change('stages',stages)}/><AttendanceCcEditor sources={input.cc} employees={options.approverEmployees ?? []} onChange={cc=>{setInput(old=>old.routingVersion===4?{...old,cc}:old);setPreview(null);}}/></>
    : input.routingVersion === 3
    ? <><AttendanceStageEditorV3 id="attendance-workflow-v3" stages={input.stages} employees={options.approverEmployees ?? []} problems={levelProblems} onChange={stages => change('stages', stages)}/><p className="text-xs text-muted-foreground">{t('v4.conversionHelp')}</p><Button type="button" variant="secondary" onClick={()=>{setInput(old=>old.routingVersion===3?{...old,routingVersion:4,cc:[],stages:old.stages.map(level=>({name:level.name,mode:level.mode,sources:[level.source],hrAlternative:level.hrAlternative}))}:old);setPreview(null);setLevelProblems([]);}}>{t('v4.convert')}</Button></>
    : <><p className="text-sm text-muted-foreground">{(input.routingVersion ?? 1) === 1 ? t('legacyLevelsHelp') : t('hierarchyLevelsHelp')}</p><AttendanceStageEditor routingVersion={input.routingVersion ?? 1} stages={input.stages} onChange={stages => change('stages', stages)}/>{(input.routingVersion ?? 1) === 1 && <Button type="button" variant="secondary" onClick={() => { setInput(previous => previous.routingVersion === 3 || previous.routingVersion === 4 ? previous : ({ ...previous, routingVersion: 2, stages: previous.stages.map((stage, index) => ({ ...stage, name: attendanceLevelName(index) })) })); setPreview(null); }}>{t('convertHierarchy')}</Button>}<p className="text-xs text-muted-foreground">{v3('conversionHelp')}</p><Button type="button" variant="secondary" onClick={() => { setInput(previous => ({ ...previous, routingVersion: 4, cc:[], stages: [emptyAttendanceV4Level(0)] })); setPreview(null); setLevelProblems([]); }}>{t('v4.convert')}</Button></>}</Card></div>
  <Card className="space-y-3 p-5"><p className="text-sm text-muted-foreground">{t('activationHelp')}</p>{savedDestination&&<p role="status">{t('savedSuccessfully')}</p>}{error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}<div className="flex flex-wrap gap-3"><Button aria-busy={pending} type="button" disabled={pending} onClick={() => run(false)}>{t('preview')}</Button><Button aria-busy={pending} type="submit" disabled={pending || !options.companies.length}>{pending ? t('saving') : t('save')}</Button><button type="button" onClick={() => {
            if (!dirty || window.confirm(t('discard')))
                router.push(companyWorkflowHref(input.companyId, input.applicationType));
        }}>{t('cancel')}</button></div></Card>
  {preview && <Card className="space-y-3 p-5"><h2 className="font-semibold">{t('previewTitle', { count: preview.total })}</h2>{preview.rows.some(row=>row.levelProblem||row.problem)&&<p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{t('hierarchyWarning')}</p>}<ul className="divide-y divide-border">{preview.rows.map(row => <li key={row.employmentId} className="py-2 text-sm">{'employeeCode' in row&&typeof row.employeeCode==='string'?row.employeeCode+' · ':''}{row.name} — {row.selectedCode}{row.problem && <p className="text-red-700">{row.problem}</p>}{row.levelProblem && <p className="text-amber-800">{row.levelProblem.levelIndex == null ? '' : `${t('stageNumber', { number: row.levelProblem.levelIndex + 1 })}: `}{v3(attendanceLevelProblemMessageKey(row.levelProblem))}</p>}<AttendanceResolvedRoutePreview stages={row.resolvedStages ?? []} routingVersion={row.routingVersion ?? 1} levelName={number => t('stageNumber', { number })} hrLabel={t('hr')} alternativeLabel={t('or')} sequentialLabel={t('v3.sequential')} anyOneLabel={t('v3.anyOne')} allRequiredLabel={t('v4.allRequired')} depthLabel={number => t('v3.depthOption', { number })}/></li>)}</ul>{preview.truncated && <p>{t('previewTruncated')}</p>}</Card>}
 </fieldset></form></WorkflowCompanyContext.Provider>;
}
