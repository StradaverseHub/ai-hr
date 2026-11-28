'use client';

import { ActionButton } from '@/components/ui/action-button';
import {useEffect,useMemo,useRef,useState,useTransition,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Field,inputCls,btnPrimary} from '@/components/ui';
import {AttendanceSettingsNavigation} from '@/components/attendance-settings-navigation';
import {OVERTIME_STARTERS,overtimeStarter,prepareOvertimeStarter,readOvertimeStarterSeed,type OvertimeStarterKey} from '@/lib/overtime-pattern-starters';
import {validateOvertimePatternDraft} from '@/lib/overtime-pattern-schema';
import {blankOvertimePattern,overtimeEditorCurrency} from '@/lib/overtime-pattern-editor-scope';
import {OvertimePatternError} from '@/lib/overtime-pattern-model';
import type {OvertimePattern,OvertimeAssignmentTarget} from '@/lib/overtime-pattern-model';
import {definitionToOvertimeSettings,type OvertimeSettings} from '@/lib/overtime-pattern-settings';
import {blankPlannedEligibility,parsePlannedEligibility,OVERTIME_ELIGIBILITY_FIELDS,type OvertimePlannedEligibility} from '@/lib/overtime-pattern-eligibility';
import type {OvertimeEligibilityPreview,OvertimePatternDetail,OvertimePatternSetup,OvertimePatternVersionView} from '@/packs/attendance/service';
import {saveOvertimeDraftAction,previewOvertimeEligibilityAction,activateOvertimePatternAction,editOvertimePatternAction,closeOvertimeAssignmentAction,cancelOvertimeAssignmentAction,type OvertimeActionFailure,type OvertimeEditorDraft} from '@/app/admin/attendance/settings/overtime-patterns/actions';
import {OvertimeEligibilitySection} from './definition-sections';
import {ConditionControl,type OvertimeChoices} from './rule-controls';
import {OvertimePreviewPanel} from './preview-panel';
import {overtimeDayTypes,withOvertimeDayTypes} from '@/lib/overtime-pattern-guided';
import {useOvertimeChoiceText} from './choice-label';
import {OvertimeSetupSummary} from './setup-summary';
import {OvertimeIssues} from './calculation-result';
import {OvertimeSettingsTable} from './overtime-settings';
import {OvertimeEligibilityStep,useEligibilitySummary,type OvertimeEmployeeOption} from './eligibility-step';
import {OvertimeEligibilityPreviewPanel} from './eligibility-preview';
import {todayInKualaLumpur} from '@/lib/hr-date';

/** Board 4197534a: General Settings, Eligibility and Preview can be opened in any order; nothing typed is lost when
 * switching. Save Draft needs only the Code and Name; everything else is checked when the pattern is switched on
 * ("Activate from [date]" on Preview) and again when overtime is worked out. */
export const OVERTIME_WORKSPACE_SECTIONS=['basic','eligibility','preview'] as const;
const STEPS=OVERTIME_WORKSPACE_SECTIONS.length;
type Section=typeof OVERTIME_WORKSPACE_SECTIONS[number];
const button='min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
const PAGE='/admin/attendance/settings/overtime-patterns';
/** Display-only fill for a blank currency so condition amounts show the company currency; the server re-derives it. */
const withCurrency=(definition:OvertimePattern,code:string|undefined):OvertimePattern=>definition.currency.code||!code?definition:{...definition,currency:overtimeEditorCurrency(code)};

/** newPatternCompany: the company a new pattern starts with (the single company in the company selection), or null. */
type WorkspaceProps={detail:OvertimePatternDetail|null;version?:OvertimePatternVersionView;setup:OvertimePatternSetup;starterKey?:OvertimeStarterKey;newPatternCompany?:{id:string;currency:string}|null;plannedEligibility?:unknown;readOnly?:boolean};
/** 2f803985: a legacy (Schedule Group) pattern shows its group's overtime bands as 1. General Settings. The page
 * renders that server editor (legacy-bands.tsx) and passes it in; without one, the old pointer remains. */
export function OvertimeWorkspace({legacyEditor,...props}:WorkspaceProps&{legacyEditor?:ReactNode}) {
  const t=useTranslations('overtimePatterns');
  if(props.detail?.pattern.kind==='legacy')return legacyEditor?<>{legacyEditor}</>:<p className="rounded-lg border border-border p-4 text-sm">{t('legacyHelp')} <a className="text-primary underline" href="/admin/attendance/schedule">{t('legacyLink')}</a></p>;
  if(!props.version)return <EditableOvertimeWorkspace {...props} initialDefinition={withCurrency(props.starterKey?prepareOvertimeStarter(props.starterKey,'day','earliest'):blankOvertimePattern(),props.newPatternCompany?.currency)}/>;
  const owningCurrency=props.setup.companies.find(company=>company.id===(props.version?.companyIds[0]??props.detail?.pattern.creationCompanyId))?.currency;
  const seed=readOvertimeStarterSeed(props.version.definition);
  if(seed&&!props.version.activatedAt)return <EditableOvertimeWorkspace {...props} starterKey={seed} initialDefinition={withCurrency(prepareOvertimeStarter(seed,'day','earliest'),owningCurrency)}/>;
  let initialDefinition:OvertimePattern;
  try {initialDefinition=validateOvertimePatternDraft(props.version.definition);}
  catch {return <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">{t('malformedDraft')}</p>;}
  return <EditableOvertimeWorkspace {...props} initialDefinition={props.version.activatedAt?initialDefinition:withCurrency(initialDefinition,owningCurrency)}/>;
}
function initialPlanned(raw:unknown):OvertimePlannedEligibility {
  if(raw===null||raw===undefined)return blankPlannedEligibility();
  try {return parsePlannedEligibility(raw);} catch {return blankPlannedEligibility();}
}
/** True when the saved definition eligibility holds more than the day-type choice (kept unchanged, shown read-only). */
function hasAdvancedEligibility(pattern:OvertimePattern):boolean {
  const e=pattern.eligibility;
  if(e.type==='constant'&&e.value)return false;
  if(e.type==='selection'&&e.field==='dayType'&&e.operator==='in')return false;
  if(e.type==='group'&&e.logic==='and')return e.children.some(child=>!(child.type==='selection'&&child.field==='dayType'&&child.operator==='in'));
  return true;
}
function EditableOvertimeWorkspace({detail,version,setup,starterKey,newPatternCompany=null,initialDefinition,plannedEligibility,readOnly=false}:WorkspaceProps&{initialDefinition:OvertimePattern}) {
  const t=useTranslations('overtimePatterns');
  const router=useRouter();
  const choiceText=useOvertimeChoiceText();
  const summary=useEligibilitySummary();
  const [pattern,setPattern]=useState<OvertimePattern>(()=>initialDefinition);
  const [settings,setSettings]=useState<OvertimeSettings|null>(()=>definitionToOvertimeSettings(initialDefinition));
  const [code,setCode]=useState(detail?.pattern.code??'');
  const [name,setName]=useState(version?.name??overtimeStarter(starterKey)?.name??'');
  const [description,setDescription]=useState(version?.description??'');
  const [companyIds,setCompanyIds]=useState<string[]>(()=>version?[...version.companyIds]:newPatternCompany?[newPatternCompany.id]:[]);
  // The page passes the Eligibility to show (an activated version's is rebuilt from its live assignments); otherwise the draft's own.
  const [planned,setPlanned]=useState<OvertimePlannedEligibility>(()=>initialPlanned(plannedEligibility!==undefined?plannedEligibility:version?.plannedEligibility));
  const [employeeOptions,setEmployeeOptions]=useState<OvertimeEmployeeOption[]>(()=>setup.employees.map(row=>({id:row.id,label:[row.employeeCode,row.name].filter(Boolean).join(' · ')})));
  const [section,setSection]=useState<Section>('basic');
  const [failure,setFailure]=useState<OvertimeActionFailure|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [savedRevision,setSavedRevision]=useState(0);
  const [preview,setPreview]=useState<OvertimeEligibilityPreview|null>(null);
  const [previewFailed,setPreviewFailed]=useState<string|null>(null);
  const [previewSearch,setPreviewSearch]=useState('');
  const [previewLoading,startPreview]=useTransition();
  const [closeDate,setCloseDate]=useState('');
  const [closeReason,setCloseReason]=useState('');
  const [pending,startTransition]=useTransition();
  const busy=useRef(false),mounted=useRef(true);
  const archived=Boolean(detail?.pattern.archivedAt);
  const editable=!readOnly&&(!detail||detail.writable)&&(!version||!version.activatedAt)&&!archived;
  const draft:OvertimeEditorDraft={code,name,description,definition:pattern,companyIds,...(settings?{settings}:{}),plannedEligibility:planned};
  const fingerprint=JSON.stringify(draft);
  const baseline=useRef(fingerprint);
  const dirty=fingerprint!==baseline.current;
  const choices:OvertimeChoices={...setup.choices,employmentId:employeeOptions};
  const criterionChoices=setup.choices as Partial<Record<string,{id:string;label:string}[]>>;
  const companyName=(id:string)=>setup.companies.find(company=>company.id===id)?.name??id;
  const criterionLabel=(field:string,id:string)=>{const option=criterionChoices[field]?.find(item=>item.id===id);return option?choiceText(field,option):id;};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function perform(work:()=>Promise<void>) {
    if(busy.current)return;
    busy.current=true;setFailure(null);setNotice(null);
    startTransition(async()=>{try{await work();}catch{if(mounted.current)setFailure({ok:false,code:'system'});}finally{busy.current=false;}});
  }
  function succeeded(result:{ok:true}|OvertimeActionFailure):boolean {if(!result.ok){if(mounted.current){setFailure(result);if(result.notice)setNotice(result.notice);}return false;}return mounted.current;}
  const plannedForPost=():OvertimePlannedEligibility|null=>Number.isInteger(planned.priority)&&planned.priority>=0&&planned.priority<=9999?planned:null;
  const save=()=>perform(async()=>{
    if(!code.trim()||!name.trim()){setFailure({ok:false,code:'invalid'});setNotice('editor.codeNameRequired');return;}
    const posted=plannedForPost();if(!posted){setFailure({ok:false,code:'invalid'});setNotice('editor.priorityInvalid');return;}
    try {validateOvertimePatternDraft(pattern);}catch(error){setFailure({ok:false,code:'invalid',issues:error instanceof OvertimePatternError?[error.issue]:undefined});return;}
    const result=await saveOvertimeDraftAction(detail?{patternId:detail.pattern.id,versionId:version?.id,expectedRevision:version?.revision,draft:{...draft,plannedEligibility:posted}}:{starterKey,draft:{...draft,plannedEligibility:posted}});
    if(!succeeded(result)||!result.ok)return;
    baseline.current=fingerprint;setSavedRevision(value=>value+1);setNotice('saved');
    router.replace(result.value.navigate);
  });
  const loadPreview=(cursor?:string)=>startPreview(async()=>{
    const posted=plannedForPost();if(!posted){setPreviewFailed(t('editor.priorityInvalid'));return;}
    const saved=Boolean(version&&!version.activatedAt&&!dirty);
    const result=await previewOvertimeEligibilityAction({patternId:detail?.pattern.id,versionId:saved?version!.id:undefined,expectedRevision:saved?version!.revision:undefined,companyIds,plannedEligibility:posted,search:previewSearch||undefined,cursor});
    if(!mounted.current)return;
    if(!result.ok){setPreviewFailed(refusalText(result));return;}
    setPreviewFailed(null);setPreview(previous=>cursor&&previous?{...result.value,rows:[...previous.rows,...result.value.rows]}:result.value);
  });
  // Preview reads when it is opened and when its search changes; edits elsewhere are read again on the next visit.
  useEffect(()=>{if(section!=='preview')return;const timer=setTimeout(()=>loadPreview(),previewSearch?300:0);return()=>clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[section,previewSearch]);
  const activate=()=>perform(async()=>{
    if(!version||!detail)return;
    const result=await activateOvertimePatternAction({patternId:detail.pattern.id,versionId:version.id,expectedRevision:version.revision});
    if(!succeeded(result)||!result.ok)return;
    router.push(result.value.navigate);
  });
  const editActive=()=>perform(async()=>{
    if(!version||!detail)return;
    const result=await editOvertimePatternAction({versionId:version.id,expectedPatternRevision:detail.pattern.revision});
    if(!succeeded(result)||!result.ok)return;
    router.push(result.value.navigate);
  });
  function refusalText(result:OvertimeActionFailure):string {
    const key=result.reason?`refusal.${result.reason}`:null;
    if(key&&t.has(key))return t(key,result.values??{});
    return t(`errors.${result.code}`);
  }
  function moveTab(next:Section) {setSection(next);}
  const settingsSummary=useMemo(()=>{
    if(!settings)return t('previewStep.customSettings');
    const rows=settings.rows.map(row=>t('previewStep.settingsRow',{from:row.from||'0:00',to:row.to||t('settingsTable.noLimit'),rate:row.rate||'—',rest:row.restRate||row.rate||'—',ph:row.phRate||row.rate||'—'}));
    return [...rows,settings.monthlyHours?t('previewStep.hourlyBasis',{hours:settings.monthlyHours}):null].filter(Boolean).join('; ');
  },[settings,t]);
  const localIssues=[
    ...(dirty&&editable?[t('previewStep.unsaved')]:[]),
    ...(!companyIds.length?[t('previewStep.noCompanies')]:[]),
    ...(!planned.from?[t('previewStep.noFrom')]:[]),
    ...((pattern.eligibility.type==='group'&&!pattern.eligibility.children.length)||overtimeDayTypes(pattern.eligibility)?.length===0?[t('previewStep.noDayTypes')]:[]),
  ];
  const criteriaText=OVERTIME_ELIGIBILITY_FIELDS.filter(field=>planned.criteria[field]?.length).map(field=>`${t(`fields.${field}`)}: ${planned.criteria[field]!.map(id=>criterionLabel(field,id)).join(', ')}`).join(' · ');
  const details=[
    {label:t('previewStep.pattern'),value:[code,name].filter(Boolean).join(' - ')||'—'},
    {label:t('previewStep.companies'),value:companyIds.length>3?t('previewStep.companyCount',{count:companyIds.length}):companyIds.map(companyName).join(', ')||'—'},
    {label:t('previewStep.eligibility'),value:[criteriaText||t('previewStep.everyone'),planned.employmentIds.length?t('previewStep.named',{count:planned.employmentIds.length}):null].filter(Boolean).join(' · ')},
    {label:t('previewStep.appliesFrom'),value:planned.from??'—'},
  ];
  const canActivate=editable&&Boolean(version)&&!dirty&&Boolean(preview?.ready)&&!previewLoading;
  const versionAssignments=detail?.assignments.filter(assignment=>assignment.versionId===version?.id&&!assignment.supersededAt)??[];
  const today=todayInKualaLumpur();
  return <div className="space-y-5">
    <AttendanceSettingsNavigation formId="overtime-definition" savedRevision={savedRevision}/>
    {failure?<div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm"><p>{refusalText(failure)}</p><OvertimeIssues issues={failure.issues??[]}/>{failure.reference?<p className="mt-1 text-xs">{t('reference',{reference:failure.reference})}</p>:null}{failure.code==='stale'?<button type="button" className={button} onClick={()=>{if(!dirty||window.confirm(t('leaveUnsaved')))router.refresh();}}>{t('reload')}</button>:null}</div>:null}
    {notice?<p role="status" className="text-sm">{t(notice)}</p>:null}
    {version?<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('versionHistory')} · {version.ordinal} · {t(`status.${version.status}`)}</summary><p className="mt-2 break-all text-xs text-muted-foreground">{t('versionId',{id:version.id})}</p><ol className="mt-3 space-y-2 text-sm">{version.states.map(state=><li key={state.id}>{state.effectiveFrom} · {t(`status.${state.state}`)} · {state.reason}</li>)}</ol></details>:null}
    {!editable&&version?.activatedAt&&detail?.writable&&!archived&&!readOnly?<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4 text-sm"><span>{t('editor.activeHelp')}</span><button type="button" className={btnPrimary} disabled={pending} onClick={editActive}>{t('editor.editActive')}</button></div>:null}
    {!detail?<p className="text-sm text-muted-foreground">{t('editor.startFrom')} <a className="text-primary hover:underline" href={`${PAGE}?new=1`}>{t('editor.blank')}</a>{OVERTIME_STARTERS.map(item=><span key={item.key}> · <a className="text-primary hover:underline" aria-current={starterKey===item.key?'page':undefined} href={`${PAGE}?new=1&starter=${item.key}`}>{item.name}</a></span>)}</p>:null}
    <p className="text-sm font-medium sm:hidden" aria-live="polite">{t('guided.stepOf',{current:OVERTIME_WORKSPACE_SECTIONS.indexOf(section)+1,total:STEPS})} · {t(`guided.${section==='basic'?'general':section}`)}</p>
    <div role="tablist" aria-label={t('sectionsLabel')} className="flex gap-1 overflow-x-auto border-b border-border" onKeyDown={event=>{
      const index=OVERTIME_WORKSPACE_SECTIONS.indexOf(section);
      const next=event.key==='ArrowRight'?(index+1)%STEPS:event.key==='ArrowLeft'?(index+STEPS-1)%STEPS:event.key==='Home'?0:event.key==='End'?STEPS-1:null;
      if(next===null)return;event.preventDefault();moveTab(OVERTIME_WORKSPACE_SECTIONS[next]);document.getElementById(`ot-tab-${OVERTIME_WORKSPACE_SECTIONS[next]}`)?.focus();
    }}>{OVERTIME_WORKSPACE_SECTIONS.map((key,index)=><button type="button" role="tab" aria-label={`${index+1}.${t(`guided.${key==='basic'?'general':key}`)}`} key={key} id={`ot-tab-${key}`} aria-controls={`ot-panel-${key}`} aria-selected={section===key} tabIndex={section===key?0:-1} className={`min-h-11 shrink-0 border-b-2 px-4 py-3 text-sm ${section===key?'border-primary font-medium text-primary':'border-transparent text-muted-foreground'}`} onClick={()=>moveTab(key)}><span className="mr-2 tabular-nums" aria-hidden="true">{index+1}.</span>{t(`guided.${key==='basic'?'general':key}`)}</button>)}</div>
    <form id="overtime-definition" method="post" onSubmit={event=>{event.preventDefault();if(editable)save();}}>
      <input type="hidden" name="overtimeDraft" value={fingerprint}/>
      <fieldset disabled={pending||!editable} className="min-w-0">
        <div role="tabpanel" id="ot-panel-basic" aria-labelledby="ot-tab-basic" hidden={section!=='basic'} className="space-y-4 rounded-xl border border-border bg-card p-5">
          <div className="grid gap-4 sm:grid-cols-2"><div><Field label={t('guided.patternLabel')}><input required className={inputCls} maxLength={64} value={code} readOnly={Boolean(detail)} onChange={event=>setCode(event.target.value)}/></Field><p className="mt-1 text-xs text-muted-foreground">{t('editor.codeHelp')}</p></div><Field label={t('guided.patternName')}><input required className={inputCls} maxLength={160} value={name} onChange={event=>setName(event.target.value)}/></Field></div>
          <Field label={t('description')}><textarea className={inputCls} rows={3} maxLength={2000} value={description} onChange={event=>setDescription(event.target.value)}/></Field>
          <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('guided.dayTypes')}</legend><div className="flex flex-wrap gap-4">{(setup.choices.dayType??[]).map(option=><label key={option.id} className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={overtimeDayTypes(pattern.eligibility)?.includes(option.id)??false} onChange={event=>{const selected=overtimeDayTypes(pattern.eligibility)??[];setPattern(withOvertimeDayTypes(pattern,event.target.checked?[...selected,option.id]:selected.filter(id=>id!==option.id)));}}/>{choiceText('dayType',option)}</label>)}</div>{overtimeDayTypes(pattern.eligibility)===null?<p className="text-xs text-muted-foreground">{t('guided.dayTypesAdvanced')}</p>:null}</fieldset>
          {settings?<OvertimeSettingsTable value={settings} onChange={setSettings} earningItems={setup.earningItems} disabled={!editable}/>:<div className="space-y-2 rounded-xl border border-border p-4"><h3 className="font-semibold">{t('settingsTable.title')}</h3><p className="text-sm text-muted-foreground">{t('settingsTable.custom')}</p><OvertimeSetupSummary name={name} code={code} description={description} pattern={pattern} choices={choices} assignments={[]} earningItems={setup.earningItems} onEdit={()=>{}}/></div>}
          {hasAdvancedEligibility(pattern)?<details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t('editor.advancedConditions')}</summary><p className="mt-2 text-xs text-muted-foreground">{t('editor.advancedConditionsHelp')}</p><fieldset disabled className="mt-3"><OvertimeEligibilitySection pattern={pattern} onChange={()=>{}} choices={choices}/></fieldset></details>:null}
        </div>
        <div role="tabpanel" id="ot-panel-eligibility" aria-labelledby="ot-tab-eligibility" hidden={section!=='eligibility'} className="space-y-4 rounded-xl border border-border bg-card p-5">
          <OvertimeEligibilityStep setup={setup} companyIds={companyIds} onCompanies={setCompanyIds} planned={planned} onPlanned={setPlanned} employeeOptions={employeeOptions} onEmployeeOptions={setEmployeeOptions} code={code} disabled={!editable}/>
        </div>
      </fieldset>
      {editable?<div className="mt-4 flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t(dirty?'unsaved':'savedState')}</span><ActionButton guardNavigation aria-busy={pending} type="submit" className={button} disabled={pending}>{t(pending?'working':'saveDraft')}</ActionButton></div>:<p className="mt-4 text-sm text-muted-foreground">{t(readOnly?'editor.viewOnly':'immutableHelp')}</p>}
    </form>
    {section==='eligibility'&&versionAssignments.length?<section className="space-y-3 rounded-xl border border-border bg-card p-5" aria-label={t('editor.currentEligibility')}>
      <h3 className="font-semibold">{t('editor.currentEligibility')}</h3>
      {versionAssignments.map(assignment=>{const target=assignment.target as unknown as OvertimeAssignmentTarget;const started=assignment.validFrom<=today;return <details key={assignment.id} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">{assignment.validFrom} → {assignment.validTo??t('noEnd')} · {t('priority')} {assignment.priority} · {t(target.type==='individual'?'individual':'group')}</summary><div className="space-y-3 pt-3">
        {target.type==='individual'?<ul className="text-sm">{target.employmentIds.map(id=><li key={id}>{employeeOptions.find(employee=>employee.id===id)?.label??t('unavailableReference',{id})}</li>)}</ul>:<fieldset disabled><ConditionControl value={target.condition} onChange={()=>{}} choices={choices} currency={pattern.currency.code} assignment/></fieldset>}
        {detail?.writable&&!readOnly?<div className="flex flex-wrap items-end gap-3">
          {started?<Field label={t('editor.endFrom')}><input type="date" className={inputCls} value={closeDate} onChange={event=>setCloseDate(event.target.value)}/></Field>:null}
          <Field label={t('reason')}><input className={inputCls} maxLength={500} value={closeReason} onChange={event=>setCloseReason(event.target.value)}/></Field>
          <ActionButton guardNavigation aria-busy={pending} type="button" className={button} disabled={pending||!closeReason.trim()||started&&!closeDate} onClick={()=>perform(async()=>{const result=started?await closeOvertimeAssignmentAction({assignmentId:assignment.id,expectedRevision:assignment.revision,effectiveTo:closeDate,reason:closeReason}):await cancelOvertimeAssignmentAction({assignmentId:assignment.id,expectedRevision:assignment.revision,reason:closeReason});if(succeeded(result)){setNotice(started?'assignmentClosed':'editor.assignmentCancelled');router.refresh();}})}>{t(started?'editor.endEligibility':'editor.cancelEligibility')}</ActionButton>
        </div>:null}
      </div></details>;})}
    </section>:null}
    <div role="tabpanel" id="ot-panel-preview" aria-labelledby="ot-tab-preview" hidden={section!=='preview'} className="space-y-5 rounded-xl border border-border bg-card p-5">
      {section==='preview'?<OvertimeEligibilityPreviewPanel preview={preview} loading={previewLoading} failed={previewFailed} onRefresh={()=>loadPreview()} search={previewSearch} onSearch={setPreviewSearch} onNextPage={()=>preview?.nextCursor&&loadPreview(preview.nextCursor)} settingsSummary={settingsSummary} localIssues={localIssues} details={details}/>:null}
      <p className="text-sm text-muted-foreground">{summary({code,companyNames:companyIds.map(companyName),planned,label:(field,id)=>criterionLabel(field,id),employees:planned.employmentIds.length})}</p>
      {editable?<div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t('editor.activateHelp')}</span><div className="flex flex-wrap gap-2"><ActionButton guardNavigation aria-busy={pending} type="button" className={button} disabled={pending} onClick={save}>{t('saveDraft')}</ActionButton><ActionButton guardNavigation aria-busy={pending} type="button" className={btnPrimary} disabled={pending||!canActivate} onClick={activate}>{planned.from?t('editor.activateFrom',{date:planned.from}):t('activate')}</ActionButton></div></div>:null}
    </div>
    <div className="flex items-center justify-between gap-3" aria-label={t('guided.stepNavigation')}><button type="button" className={button} disabled={section==='basic'} onClick={()=>moveTab(OVERTIME_WORKSPACE_SECTIONS[OVERTIME_WORKSPACE_SECTIONS.indexOf(section)-1])}>{t('guided.back')}</button><span className="text-xs text-muted-foreground">{t('guided.stepOf',{current:OVERTIME_WORKSPACE_SECTIONS.indexOf(section)+1,total:STEPS})}</span>{section!=='preview'?<button type="button" className={btnPrimary} onClick={()=>moveTab(OVERTIME_WORKSPACE_SECTIONS[OVERTIME_WORKSPACE_SECTIONS.indexOf(section)+1])}>{t('guided.next')}</button>:<span/>}</div>
    {version?<details className="rounded-xl border border-border p-5"><summary className="cursor-pointer text-sm font-medium">{t('guided.testCalculation')}</summary><div className="mt-4"><OvertimePreviewPanel patternId={detail?.pattern.id} versionId={version.id} pattern={pattern} employees={setup.employees} earningItems={setup.earningItems} choices={choices} disabled={dirty}/></div></details>:null}
  </div>;
}
