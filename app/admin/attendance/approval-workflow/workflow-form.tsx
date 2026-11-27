'use client';
import {WorkflowCompanyContext} from './approver-picker';
import type {AnyAttendanceWorkflowInput} from '@/lib/attendance-workflow-config';
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AttendanceResolvedRoutePreview } from '@/components/attendance-resolved-route-preview';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { typeHelpCls, typeLabelCls } from '@/components/ui/section-card';
import { AssignmentGroupsEditor } from './assignment-groups';
import {AttendanceStageEditorV4,AttendanceCcEditor,emptyAttendanceV4Level} from './stage-editor-v4';
import { AttendanceStageEditorV3 } from './stage-editor-v3';
import { attendanceLevelProblemMessageKey, type AttendanceLevelProblem } from '@/lib/attendance-workflow-v3';
import { AttendanceStageEditor } from './stage-editor';
import { companyWorkflowHref } from './navigation';
import { Button, Card, inputCls } from '@/components/ui';
import { attendanceCriteriaGroups, attendanceWorkflowCriteriaFields, attendanceLevelName, type AttendanceWorkflowOptions, type AttendanceWorkflowInput, type AttendanceResolvedStage } from '@/lib/attendance-workflow';
import { generateAttendanceWorkflowPreviewAction, previewAttendanceWorkflowAction, saveAttendanceWorkflowAction } from './actions';

/** One numbered section of the Create / Edit Workflow form (board 03cb9b74: presentation only). */
function FormSection({ id, number, title, help, children }: { id: string; number: number; title: string; help?: ReactNode; children: ReactNode }) {
    return <Card id={id} aria-labelledby={`${id}-title`} role="region" className="scroll-mt-4 space-y-4 p-5">
        <div className="space-y-1">
            <h2 id={`${id}-title`} className="flex items-center gap-3 text-base font-semibold"><span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm text-primary-foreground">{number}</span>{title}</h2>
            {help && <p className={`${typeHelpCls} pl-10`}>{help}</p>}
        </div>
        {children}
    </Card>;
}
type SectionLink = { id: string; title: string; count?: string };
/** The section list: a sticky column at xl, a row of links above the form on smaller screens. No list items, so the
 * level and source lists stay the form's only lists. */
function SectionIndex({ label, sections }: { label: string; sections: SectionLink[] }) {
    const [active, setActive] = useState(sections[0]?.id);
    const ids = sections.map(section => section.id).join(',');
    useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(entries => {
            const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
            if (visible) setActive(visible.target.id);
        }, { rootMargin: '0px 0px -60% 0px' });
        for (const id of ids.split(',')) { const element = document.getElementById(id); if (element) observer.observe(element); }
        return () => observer.disconnect();
    }, [ids]);
    return <nav aria-label={label} className="min-w-0 xl:sticky xl:top-4 xl:self-start">
        <div className="flex gap-2 overflow-x-auto rounded-xl border border-border bg-card p-2 xl:flex-col xl:gap-1">{sections.map((section, index) =>
            <a key={section.id} href={`#${section.id}`} aria-current={active === section.id ? 'true' : undefined} onClick={() => setActive(section.id)}
                className={'flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm no-underline hover:bg-muted ' + (active === section.id ? 'bg-primary/10 font-medium text-primary' : 'text-foreground')}>
                <span aria-hidden="true" className={'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs ' + (active === section.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{index + 1}</span>
                <span className="whitespace-nowrap xl:whitespace-normal">{section.title}</span>
                {section.count && <span className="ml-auto whitespace-nowrap pl-2 text-xs text-muted-foreground">{section.count}</span>}
            </a>)}</div>
    </nav>;
}

export function WorkflowForm({ initial, lineageId, context, options, defaultPriority = 1, copiedFrom }: {
    initial: AnyAttendanceWorkflowInput | null;
    /** Create Workflow opened by Copy Workflow: provenance only; the source is never written. */
    copiedFrom?: { lineageId: string; version: number; code: string };
    defaultPriority?: number;
    lineageId: string | null;
    context: Pick<AttendanceWorkflowInput, 'companyId' | 'applicationType'>;
    options: AttendanceWorkflowOptions;
}) {
    const employmentTypeLabel = useTranslations('people.wizard.employmentType');
    const v3 = useTranslations('attendanceWorkflow.v3'), v4 = useTranslations('attendanceWorkflow.v4');
    const t = useTranslations('attendanceWorkflow'), router = useRouter();
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
    const savedVersion = initial?.expectedVersion;
    const change = <K extends keyof AnyAttendanceWorkflowInput>(k: K, v: AnyAttendanceWorkflowInput[K]) => { setInput(p => ({ ...p, [k]: v } as AnyAttendanceWorkflowInput)); setPreview(null); };
    const inFlight = useRef(false);
    const priorityEdited = useRef(!!copiedFrom);
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
            const result = copiedFrom
                ? await saveAttendanceWorkflowAction(lineageId, input, autoPriority, saveAttempt.current.id, { lineageId: copiedFrom.lineageId, version: copiedFrom.version })
                : await saveAttendanceWorkflowAction(lineageId, input, autoPriority, saveAttempt.current.id);
            if (result.ok) {
                setSavedRevision(revision => revision + 1);
                setSavedDestination(`/admin/attendance/approval-workflow/${result.lineageId}?notice=saved`);
            }
            else {
                setError(result.error);
                if ('levelProblem' in result && result.levelProblem) setLevelProblems([result.levelProblem]);
            }
        }
        else if (lineageId && !dirty && savedVersion) {
            // The saved version is previewed once and stored, so it can be reviewed later without recalculating.
            const result = await generateAttendanceWorkflowPreviewAction(lineageId, savedVersion);
            if (result.ok) setSavedDestination(`/admin/attendance/approval-workflow/${lineageId}/previews?id=${result.previewId}`);
            else setError(result.error);
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
    const companyIds = input.allCompanies?options.companies.map(c=>c.id):input.companyIds??[input.companyId];
    const typeId = 'attendance-workflow-type';
    const sections: SectionLink[] = [
        { id: 'workflow-details', title: t('form.details') },
        { id: 'workflow-assignment', title: t('form.appliesTo'), count: t('form.groupCount', { count: attendanceCriteriaGroups(input.criteria).length }) },
        { id: 'workflow-levels', title: t('stages'), count: t('form.levelCount', { count: input.stages.length }) },
        ...(input.routingVersion === 4 ? [{ id: 'workflow-cc', title: v4('cc'), count: String(input.cc.length) }] : []),
        { id: 'workflow-save', title: t('form.save') },
    ];
    const number = (id: string) => sections.findIndex(section => section.id === id) + 1;
    return <WorkflowCompanyContext.Provider value={companyIds}><AttendanceSettingsNavigation formId="attendance-workflow-form" savedRevision={savedRevision}/><form id="attendance-workflow-form" className="space-y-5" onSubmit={e => { e.preventDefault(); run(true); }}><fieldset disabled={pending || !!savedDestination} className="min-w-0 space-y-5">
  {copiedFrom&&<p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">{t('copy.banner',{code:copiedFrom.code,version:copiedFrom.version})}</p>}
  <div className="grid items-start gap-5 xl:grid-cols-[15rem_minmax(0,1fr)]">
  <SectionIndex label={t('form.sections')} sections={sections}/>
  <div className="min-w-0 space-y-5">
  <FormSection id="workflow-details" number={number('workflow-details')} title={t('form.details')} help={t('form.detailsHelp')}>
   <div className="grid gap-4 sm:grid-cols-2">
    <label className="block"><span className={typeLabelCls}>{t('code')}</span><input name="code" required maxLength={40} pattern="[A-Za-z0-9_-]+" className={inputCls} value={input.code} placeholder={copiedFrom ? t('copy.codePlaceholder') : undefined} onChange={e => change('code', e.target.value)}/></label>
    <label className="block"><span className={typeLabelCls}>{t('name')}</span><input name="name" required maxLength={120} className={inputCls} value={input.name} placeholder={copiedFrom ? t('copy.namePlaceholder') : undefined} onChange={e => change('name', e.target.value)}/></label>
    <div><span id={typeId} className={typeLabelCls}>{t('applicationType')}</span><p aria-labelledby={typeId} className="mt-1"><span className="inline-flex rounded-full bg-muted px-3 py-1 text-sm">{t(`types.${input.applicationType}`)}</span></p></div>
    <div className="space-y-2"><label className="flex min-h-11 items-center gap-2 text-sm"><input name="allCompanies" type="checkbox" className="size-4" checked={input.allCompanies===true} disabled={!options.canManageAllCompanies} onChange={event=>{const allCompanies=event.target.checked;setInput(old=>({...old,allCompanies,companyIds:allCompanies?options.companies.map(c=>c.id):[old.companyId]}));setPreview(null);}}/>{t('allCompany')}</label>
    {!input.allCompanies&&<ChipMultiSelect name="companyIds" label={t('company')} options={options.companies.map(c=>({value:c.id,label:c.name}))} defaultSelected={input.companyIds??[input.companyId]} addPlaceholder={t('chooseCompanies')} searchPlaceholder={t('searchCompanies')} removeLabelFor={value=>t('removeCompany',{value})} onSelectionChange={companyIds=>{setInput(old=>({...old,companyIds,companyId:companyIds.includes(old.companyId)?old.companyId:companyIds[0]??old.companyId}));setPreview(null);}}/>}<p className={typeHelpCls}>{t(options.canManageAllCompanies?'allCompanyHelp':'allCompanyRestricted')}</p></div>
   </div>
   <label className="block"><span className={typeLabelCls}>{t('description')}</span><textarea name="description" maxLength={1000} className={inputCls} value={input.description ?? ''} onChange={e => change('description', e.target.value)}/></label>
  </FormSection>
  <FormSection id="workflow-assignment" number={number('workflow-assignment')} title={t('form.appliesTo')} help={t('assignmentHelp')}>
   <label className="block max-w-xs"><span className={typeLabelCls}>{t('priority')}</span><input name="priority" required type="number" min={0} max={9999} className={inputCls} value={input.priority} onChange={e => { priorityEdited.current = true; change('priority', Number(e.target.value)); }}/></label>
   <AssignmentGroupsEditor criteria={input.criteria} fields={fields} employees={options.employees ?? []} companyIds={options.companies.map(c => c.id)} onChange={criteria => change('criteria', criteria)}/>
  </FormSection>
  <FormSection id="workflow-levels" number={number('workflow-levels')} title={t('stages')} help={t('form.levelsHelp')}>{input.routingVersion === 4
    ? <AttendanceStageEditorV4 stages={input.stages} employees={options.approverEmployees ?? []} problems={levelProblems} onChange={stages=>change('stages',stages)}/>
    : input.routingVersion === 3
    ? <><AttendanceStageEditorV3 id="attendance-workflow-v3" stages={input.stages} employees={options.approverEmployees ?? []} problems={levelProblems} onChange={stages => change('stages', stages)}/><p className="text-xs text-muted-foreground">{t('v4.conversionHelp')}</p><Button type="button" variant="secondary" onClick={()=>{setInput(old=>old.routingVersion===3?{...old,routingVersion:4,cc:[],stages:old.stages.map(level=>({name:level.name,mode:level.mode,sources:[level.source],hrAlternative:level.hrAlternative}))}:old);setPreview(null);setLevelProblems([]);}}>{t('v4.convert')}</Button></>
    : <><p className="text-sm text-muted-foreground">{(input.routingVersion ?? 1) === 1 ? t('legacyLevelsHelp') : t('hierarchyLevelsHelp')}</p><AttendanceStageEditor routingVersion={input.routingVersion ?? 1} stages={input.stages} onChange={stages => change('stages', stages)}/>{(input.routingVersion ?? 1) === 1 && <Button type="button" variant="secondary" onClick={() => { setInput(previous => previous.routingVersion === 3 || previous.routingVersion === 4 ? previous : ({ ...previous, routingVersion: 2, stages: previous.stages.map((stage, index) => ({ ...stage, name: attendanceLevelName(index) })) })); setPreview(null); }}>{t('convertHierarchy')}</Button>}<p className="text-xs text-muted-foreground">{v3('conversionHelp')}</p><Button type="button" variant="secondary" onClick={() => { setInput(previous => ({ ...previous, routingVersion: 4, cc:[], stages: [emptyAttendanceV4Level(0)] })); setPreview(null); setLevelProblems([]); }}>{t('v4.convert')}</Button></>}</FormSection>
  {input.routingVersion === 4 && <FormSection id="workflow-cc" number={number('workflow-cc')} title={v4('cc')} help={v4('ccHelp')}>
   <AttendanceCcEditor sources={input.cc} employees={options.approverEmployees ?? []} onChange={cc=>{setInput(old=>old.routingVersion===4?{...old,cc}:old);setPreview(null);}}/>
  </FormSection>}
  <FormSection id="workflow-save" number={number('workflow-save')} title={t('form.save')} help={t('activationHelp')}>
   <p className="text-sm text-muted-foreground">{t('form.previewHelp')}</p>
   {preview && <div className="space-y-3 rounded-lg border border-border p-4"><h3 className="font-semibold">{t('previewTitle', { count: preview.total })}</h3><p className="text-sm text-muted-foreground">{t('previewHistory.draftNotStored')}</p>{preview.rows.some(row=>row.levelProblem||row.problem)&&<p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{t('hierarchyWarning')}</p>}<ul className="divide-y divide-border">{preview.rows.map(row => <li key={row.employmentId} className="py-2 text-sm">{'employeeCode' in row&&typeof row.employeeCode==='string'?row.employeeCode+' · ':''}{row.name} — {row.selectedCode}{row.problem && <p className="text-red-700">{row.problem}</p>}{row.levelProblem && <p className="text-amber-800">{row.levelProblem.levelIndex == null ? '' : `${t('stageNumber', { number: row.levelProblem.levelIndex + 1 })}: `}{v3(attendanceLevelProblemMessageKey(row.levelProblem))}</p>}<AttendanceResolvedRoutePreview stages={row.resolvedStages ?? []} routingVersion={row.routingVersion ?? 1} levelName={number => t('stageNumber', { number })} hrLabel={t('hr')} alternativeLabel={t('or')} sequentialLabel={t('v3.sequential')} anyOneLabel={t('v3.anyOne')} allRequiredLabel={t('v4.allRequired')} depthLabel={number => t('v3.depthOption', { number })}/></li>)}</ul>{preview.truncated && <p>{t('previewTruncated')}</p>}</div>}
  </FormSection>
  </div>
  </div>
  <div className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
   {error && <p role="alert" className="w-full rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
   <p className="text-sm" aria-live="polite">{savedDestination ? <span role="status">{t('savedSuccessfully')}</span> : dirty ? <span className="text-amber-800 dark:text-amber-300">{t('form.unsaved')}</span> : null}</p>
   <div className="flex flex-wrap items-center gap-3"><button type="button" className="min-h-11 px-2 text-sm text-primary underline-offset-4 hover:underline" onClick={() => {
            if (!dirty || window.confirm(t('discard')))
                router.push(companyWorkflowHref(input.companyId, input.applicationType));
        }}>{t('cancel')}</button><Button aria-busy={pending} type="button" variant="secondary" disabled={pending} onClick={() => run(false)}>{lineageId && !dirty && savedVersion ? t('previewHistory.generate') : t('preview')}</Button><Button aria-busy={pending} type="submit" disabled={pending || !options.companies.length}>{pending ? t('saving') : t('save')}</Button></div>
  </div>
 </fieldset></form></WorkflowCompanyContext.Provider>;
}
