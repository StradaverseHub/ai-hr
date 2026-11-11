'use client';

import { ActionButton } from '@/components/ui/action-button';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Field,inputCls,btnPrimary} from '@/components/ui';
import {AttendanceSettingsNavigation} from '@/components/attendance-settings-navigation';
import {overtimeStarter,prepareOvertimeStarter,readOvertimeStarterSeed,type OvertimeStarterKey} from '@/lib/overtime-pattern-starters';
import {validateOvertimePatternDraft} from '@/lib/overtime-pattern-schema';
import {blankOvertimePattern,overtimeEditorCurrency} from '@/lib/overtime-pattern-editor-scope';
import {OvertimePatternError} from '@/lib/overtime-pattern-model';
import type {OvertimePattern,OvertimeAssignmentTarget} from '@/lib/overtime-pattern-model';
import type {OvertimePatternDetail,OvertimePatternSetup,OvertimePatternVersionView} from '@/packs/attendance/service';
import {saveOvertimeDraftAction,saveOvertimeAssignmentAction,closeOvertimeAssignmentAction,overtimeChoicesAction,type OvertimeActionFailure,type OvertimeEditorDraft} from '@/app/admin/attendance/settings/overtime-patterns/actions';
import {OvertimeEligibilitySection} from './definition-sections';
import {ConditionControl,blankCondition,type OvertimeChoices} from './rule-controls';
import {OvertimePreviewPanel} from './preview-panel';
import {overtimeDayTypes,withOvertimeDayTypes} from '@/lib/overtime-pattern-guided';
import {useOvertimeChoiceText} from './choice-label';
import {OvertimeSetupSummary} from './setup-summary';
import {OvertimeIssues} from './calculation-result';

/** b31981c0: the Overtime Rates step and the configuration-only General Settings controls are hidden for this
 * phase. Their saved values stay untouched; the save action derives them server-side and never from this form. */
export const OVERTIME_WORKSPACE_SECTIONS=['basic','eligibility','preview'] as const;
const STEPS=OVERTIME_WORKSPACE_SECTIONS.length;
type Section=typeof OVERTIME_WORKSPACE_SECTIONS[number];
const PAGE='/admin/attendance/settings/overtime-patterns';
const button='min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
/** Display-only fill for a blank currency so condition amounts show the company currency; the server re-derives it. */
const withCurrency=(definition:OvertimePattern,code:string|undefined):OvertimePattern=>definition.currency.code||!code?definition:{...definition,currency:overtimeEditorCurrency(code)};

/** newPatternCompany is the single company in the server-side company selection, or null when a new pattern
 * cannot be filed under exactly one company. */
type WorkspaceProps={detail:OvertimePatternDetail|null;version?:OvertimePatternVersionView;setup:OvertimePatternSetup;starterKey?:OvertimeStarterKey;newPatternCompany?:{id:string;currency:string}|null};
export function OvertimeWorkspace(props:WorkspaceProps) {
  const t=useTranslations('overtimePatterns');
  if(props.detail?.pattern.kind==='legacy')return <p className="rounded-lg border border-border p-4 text-sm">{t('legacyHelp')} <a className="text-primary underline" href="/admin/attendance/schedule">{t('legacyLink')}</a></p>;
  if(!props.version)return <EditableOvertimeWorkspace {...props} initialDefinition={withCurrency(props.starterKey?prepareOvertimeStarter(props.starterKey,'day','earliest'):blankOvertimePattern(),props.newPatternCompany?.currency)} needsPreparation/>;
  const owningCurrency=props.setup.companies.find(company=>company.id===props.detail?.pattern.creationCompanyId)?.currency;
  const seed=readOvertimeStarterSeed(props.version.definition);
  if(seed&&!props.version.activatedAt)return <EditableOvertimeWorkspace {...props} starterKey={seed} initialDefinition={withCurrency(prepareOvertimeStarter(seed,'day','earliest'),owningCurrency)} needsPreparation/>;
  let initialDefinition:OvertimePattern;
  try {initialDefinition=validateOvertimePatternDraft(props.version.definition);}
  catch {return <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">{t('malformedDraft')}</p>;}
  return <EditableOvertimeWorkspace {...props} initialDefinition={props.version.activatedAt?initialDefinition:withCurrency(initialDefinition,owningCurrency)}/>;
}
function EditableOvertimeWorkspace({detail,version,setup,starterKey,newPatternCompany=null,initialDefinition,needsPreparation=false}:WorkspaceProps&{initialDefinition:OvertimePattern;needsPreparation?:boolean}) {
  const t=useTranslations('overtimePatterns');
  const router=useRouter();
  const choiceText=useOvertimeChoiceText();
  const initial=initialDefinition;
  const [pattern,setPattern]=useState<OvertimePattern>(()=>initial);
  const [code,setCode]=useState(detail?.pattern.code??'');
  const [name,setName]=useState(version?.name??overtimeStarter(starterKey)?.name??'');
  const [description,setDescription]=useState(version?.description??'');
  const [section,setSection]=useState<Section>('basic');
  const [failure,setFailure]=useState<OvertimeActionFailure|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [reason,setReason]=useState('');
  const [savedRevision,setSavedRevision]=useState(0);
  const [target,setTarget]=useState<OvertimeAssignmentTarget>({type:'individual',employmentIds:[]});
  const [priority,setPriority]=useState('');
  const [assignmentFrom,setAssignmentFrom]=useState('');
  const [assignmentTo,setAssignmentTo]=useState('');
  const [closeDate,setCloseDate]=useState('');
  const [assignmentReceipt,setAssignmentReceipt]=useState('');
  const [employeeSearch,setEmployeeSearch]=useState('');
  const [employeeOptions,setEmployeeOptions]=useState(setup.employees);
  const [employeeCursor,setEmployeeCursor]=useState(setup.employeeNextCursor);
  const [pending,startTransition]=useTransition();
  const busy=useRef(false),mounted=useRef(true);
  const editable=(!detail||detail.writable)&&(!version||!version.activatedAt)&&detail?.pattern.kind!=='legacy'&&!detail?.pattern.archivedAt;
  const needsCompany=!detail&&!newPatternCompany;
  const draft:OvertimeEditorDraft={code,name,description,definition:pattern};
  const fingerprint=JSON.stringify(draft);
  const baseline=useRef(fingerprint);
  const dirty=fingerprint!==baseline.current;
  const choices:OvertimeChoices={...setup.choices,employmentId:employeeOptions.map(employee=>({id:employee.id,label:`${employee.employeeCode??''} ${employee.name}`.trim()}))};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{document.getElementById(`ot-tab-${section}`)?.scrollIntoView?.({block:'nearest',inline:'nearest'});},[section]);
  function update(next:OvertimePattern) {setPattern(next);setNotice(null);}
  function perform(work:()=>Promise<void>) {
    if(busy.current)return;
    busy.current=true;setFailure(null);setNotice(null);
    startTransition(async()=>{try{await work();}catch{if(mounted.current)setFailure({ok:false,code:'system'});}finally{busy.current=false;}});
  }
  function succeeded(result:{ok:true}|OvertimeActionFailure) {if(!result.ok){if(mounted.current){setFailure(result as OvertimeActionFailure);if((result as OvertimeActionFailure).notice)setNotice((result as OvertimeActionFailure).notice!);}return false;}return mounted.current;}
  function checkStep(step:Section):boolean {
    if(step==='basic'&&(!code.trim()||!name.trim()||needsPreparation&&!(overtimeDayTypes(pattern.eligibility)?.length))){
      setFailure({ok:false,code:'invalid'});setNotice('guided.completeGeneral');return false;
    }
    if(step==='eligibility'){
      try {validateOvertimePatternDraft(pattern);}
      catch(error){setFailure({ok:false,code:'invalid',issues:error instanceof OvertimePatternError?[error.issue]:undefined});return false;}
    }
    setFailure(null);setNotice(null);return true;
  }
  function moveTab(next:Section):boolean {
    const destination=OVERTIME_WORKSPACE_SECTIONS.indexOf(next),current=OVERTIME_WORKSPACE_SECTIONS.indexOf(section);
    if(destination>current)for(let i=current;i<destination;i++)if(!checkStep(OVERTIME_WORKSPACE_SECTIONS[i]))return false;
    setSection(next);return true;
  }
  const save=(complete=false)=>perform(async()=>{
    if(complete&&!checkStep('eligibility'))return;
    if(needsCompany){setFailure({ok:false,code:'invalid'});setNotice('chooseOneCompany');return;}
    try {validateOvertimePatternDraft(pattern);}catch(error){setFailure({ok:false,code:'invalid',issues:error instanceof OvertimePatternError?[error.issue]:undefined});return;}
    const result=await saveOvertimeDraftAction(detail?{patternId:detail.pattern.id,versionId:version?.id,expectedRevision:version?.revision,draft}:{starterKey,draft});
    if(!succeeded(result)||!result.ok)return;
    baseline.current=fingerprint;setSavedRevision(value=>value+1);setNotice('saved');
    router.replace(`${PAGE}?pattern=${result.value.patternId}&version=${result.value.versionId}`);router.refresh();
  });
  function checkSaved() {if(!version||dirty){setFailure({ok:false,code:'invalid'});setNotice('saveBeforeAction');return false;}return true;}
  const assign=()=>perform(async()=>{
    if(!checkSaved()||!Number.isSafeInteger(Number(priority))||Number(priority)<0||Number(priority)>9999||priority.trim()===''){setFailure({ok:false,code:'invalid'});return;}
    const result=await saveOvertimeAssignmentAction({versionId:version!.id,target,priority:Number(priority),from:assignmentFrom,to:assignmentTo||null});
    if(succeeded(result)){const nonce=document.querySelector<HTMLInputElement>('#overtime-assignment input[name=__attendanceSaveNonce]')?.value;if(nonce)setAssignmentReceipt(nonce);setNotice('assignmentSaved');router.refresh();}
  });
  function searchEmployees(more=false) {perform(async()=>{
    const result=await overtimeChoicesAction({employeeSearch,employeeCursor:more?employeeCursor??undefined:undefined});
    if(!succeeded(result)||!result.ok)return;
    setEmployeeOptions(previous=>[...new Map([...(more?previous:previous.filter(item=>target.type==='individual'&&target.employmentIds.includes(item.id))),...result.value.employees].map(item=>[item.id,item])).values()]);
    setEmployeeCursor(result.value.employeeNextCursor);
  });}
  const isLegacy=detail?.pattern.kind==='legacy';
  return <div className="space-y-5">
    <AttendanceSettingsNavigation formId="overtime-definition" savedRevision={savedRevision}/>
    {failure?<div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm"><p>{t(`errors.${failure.code}`)}</p><OvertimeIssues issues={failure.issues??[]}/>{failure.reference?<p className="mt-1 text-xs">{t('reference',{reference:failure.reference})}</p>:null}{failure.code==='stale'?<button type="button" className={button} onClick={()=>{if(!dirty||window.confirm(t('leaveUnsaved')))router.refresh();}}>{t('reload')}</button>:null}</div>:null}
    {notice?<p role="status" className="text-sm">{t(notice)}</p>:null}
    {setup.readerLimitations.length?<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('readerLimitations')}</summary><ul className="mt-2 space-y-2 text-sm text-muted-foreground">{setup.readerLimitations.map((field,index)=><li key={index}>{t.has(`limitations.${field}`)?t(`limitations.${field}`):t('unknownHelp')}</li>)}</ul><p className="mt-2 text-sm text-muted-foreground">{t('unknownHelp')}</p></details>:null}
    {version?<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('versionHistory')} · {version.ordinal} · {t(`status.${version.status}`)}</summary><p className="mt-2 break-all text-xs text-muted-foreground">{t('versionId',{id:version.id})}</p><ol className="mt-3 space-y-2 text-sm">{version.states.map(state=><li key={state.id}>{state.effectiveFrom} · {t(`status.${state.state}`)} · {state.reason}</li>)}</ol></details>:null}
    {isLegacy?<p className="rounded-lg border border-border p-4 text-sm">{t('legacyHelp')} <a className="text-primary underline" href="/admin/attendance/schedule">{t('legacyLink')}</a></p>:<>
      {needsCompany&&notice!=='chooseOneCompany'?<p role="status" className="rounded-lg border border-border p-4 text-sm">{t('chooseOneCompany')}</p>:null}
      <p className="text-sm font-medium sm:hidden" aria-live="polite">{t('guided.stepOf',{current:OVERTIME_WORKSPACE_SECTIONS.indexOf(section)+1,total:STEPS})} · {t(`guided.${section==='basic'?'general':section}`)}</p>
      <div role="tablist" aria-label={t('sectionsLabel')} className="flex gap-1 overflow-x-auto border-b border-border" onKeyDown={event=>{
        const index=OVERTIME_WORKSPACE_SECTIONS.indexOf(section);
        const next=event.key==='ArrowRight'?(index+1)%STEPS:event.key==='ArrowLeft'?(index+STEPS-1)%STEPS:event.key==='Home'?0:event.key==='End'?STEPS-1:null;
        if(next===null)return;event.preventDefault();if(moveTab(OVERTIME_WORKSPACE_SECTIONS[next]))document.getElementById(`ot-tab-${OVERTIME_WORKSPACE_SECTIONS[next]}`)?.focus();
      }}>{OVERTIME_WORKSPACE_SECTIONS.map(key=><button type="button" role="tab" aria-label={`${OVERTIME_WORKSPACE_SECTIONS.indexOf(key)+1}.${t(`guided.${key==='basic'?'general':key}`)}`} key={key} id={`ot-tab-${key}`} aria-controls={`ot-panel-${key}`} aria-selected={section===key} tabIndex={section===key?0:-1} className={`min-h-11 shrink-0 border-b-2 px-4 py-3 text-sm ${section===key?'border-primary font-medium text-primary':'border-transparent text-muted-foreground'}`} onClick={()=>moveTab(key)}><span className="mr-2 tabular-nums" aria-hidden="true">{OVERTIME_WORKSPACE_SECTIONS.indexOf(key)<OVERTIME_WORKSPACE_SECTIONS.indexOf(section)?<svg viewBox="0 0 16 16" className="inline h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 8 3 3 7-7"/></svg>:`${OVERTIME_WORKSPACE_SECTIONS.indexOf(key)+1}.`}</span>{t(`guided.${key==='basic'?'general':key}`)}</button>)}</div>
      <form id="overtime-definition" method="post" onSubmit={event=>{event.preventDefault();if(editable)save();}}>
        <input type="hidden" name="overtimeDraft" value={fingerprint}/>
        <fieldset disabled={pending||!editable} className="min-w-0">
          <div role="tabpanel" id="ot-panel-basic" aria-labelledby="ot-tab-basic" hidden={section!=='basic'} className="space-y-4 rounded-xl border border-border bg-card p-5">
            <div className="grid gap-4 sm:grid-cols-2"><Field label={t('guided.patternLabel')}><input required className={inputCls} maxLength={64} value={code} readOnly={Boolean(detail)} onChange={event=>setCode(event.target.value)}/></Field><Field label={t('guided.patternName')}><input required className={inputCls} maxLength={160} value={name} onChange={event=>setName(event.target.value)}/></Field></div>
            <Field label={t('description')}><textarea className={inputCls} rows={3} maxLength={2000} value={description} onChange={event=>setDescription(event.target.value)}/></Field>
            <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('guided.dayTypes')}</legend><div className="flex flex-wrap gap-4">{(setup.choices.dayType??[]).map(option=><label key={option.id} className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={overtimeDayTypes(pattern.eligibility)?.includes(option.id)??false} onChange={event=>{const selected=overtimeDayTypes(pattern.eligibility)??[];update(withOvertimeDayTypes(pattern,event.target.checked?[...selected,option.id]:selected.filter(id=>id!==option.id)));}}/>{choiceText('dayType',option)}</label>)}</div>{overtimeDayTypes(pattern.eligibility)===null?<p className="text-xs text-muted-foreground">{t('guided.dayTypesAdvanced')}</p>:null}</fieldset>
          </div>
          <div role="tabpanel" id="ot-panel-eligibility" aria-labelledby="ot-tab-eligibility" hidden={section!=='eligibility'} className="rounded-xl border border-border bg-card p-5"><OvertimeEligibilitySection pattern={pattern} onChange={update} choices={choices}/></div>
        </fieldset>
        {editable?<div className="mt-4 flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t(dirty?'unsaved':'savedState')}</span><ActionButton guardNavigation aria-busy={pending} type="submit" className={button} disabled={pending||needsCompany}>{t(pending?'working':'saveDraft')}</ActionButton></div>:<p className="mt-4 text-sm text-muted-foreground">{t('immutableHelp')}</p>}
      </form>
      <div role="region" aria-label={t('guided.employeeEligibility')} hidden={section!=='eligibility'} className="space-y-4 rounded-xl border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground">{t('assignmentHelp')}</p>
        <form id="overtime-assignment" method="post" data-attendance-save-scope aria-busy={pending} data-attendance-saved-receipt={assignmentReceipt} onSubmit={event=>{event.preventDefault();assign();}}><input type="hidden" name="overtimeAssignment" value={JSON.stringify({target,priority,assignmentFrom,assignmentTo})}/><fieldset disabled={pending||!detail?.writable||!version} className="space-y-4">
          <div className="flex flex-wrap items-end gap-3"><Field label={t('employeeSearch')}><input className={inputCls} value={employeeSearch} onChange={event=>setEmployeeSearch(event.target.value)}/></Field><button type="button" className={button} onClick={()=>searchEmployees()}>{t('search')}</button>{employeeCursor?<button type="button" className={button} onClick={()=>searchEmployees(true)}>{t('loadMore')}</button>:null}</div>
          <Field label={t('assignmentType')}><select className={inputCls} value={target.type} onChange={event=>setTarget(event.target.value==='individual'?{type:'individual',employmentIds:[]}:{type:'group',condition:blankCondition()})}><option value="individual">{t('individual')}</option><option value="group">{t('group')}</option></select></Field>
          {target.type==='individual'?<Field label={t('employees')}><select multiple className={`${inputCls} min-h-32`} value={target.employmentIds} onChange={event=>setTarget({type:'individual',employmentIds:Array.from(event.target.selectedOptions,option=>option.value)})}>{employeeOptions.map(employee=><option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.name}</option>)}</select></Field>:<ConditionControl value={target.condition} onChange={condition=>setTarget({type:'group',condition})} currency={pattern.currency.code} choices={choices} assignment/>}
          <div className="grid gap-3 sm:grid-cols-3"><Field label={t('priority')}><input type="number" step="1" min="0" max="9999" className={inputCls} value={priority} onChange={event=>setPriority(event.target.value)}/></Field><Field label={t('effectiveFrom')}><input type="date" className={inputCls} value={assignmentFrom} onChange={event=>setAssignmentFrom(event.target.value)}/></Field><Field label={t('exclusiveTo')}><input type="date" className={inputCls} value={assignmentTo} onChange={event=>setAssignmentTo(event.target.value)}/></Field></div>
          <ActionButton actionKind="saving" aria-busy={pending} type="submit" className={button} disabled={dirty}>{t('saveAssignment')}</ActionButton>
        </fieldset></form>
        {detail?.assignments.map(assignment=><details key={assignment.id} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">{assignment.validFrom} → {assignment.validTo??t('noEnd')} · {t('priority')} {assignment.priority}</summary><div className="space-y-3 pt-3"><p className="break-all text-xs text-muted-foreground">{t('versionId',{id:assignment.versionId})}</p><ConditionOrEmployees target={assignment.target as unknown as OvertimeAssignmentTarget} choices={choices} currency={pattern.currency.code}/><Field label={t('exclusiveTo')}><input type="date" className={inputCls} value={closeDate} onChange={event=>setCloseDate(event.target.value)}/></Field><Field label={t('reason')}><input className={inputCls} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></Field><ActionButton guardNavigation aria-busy={pending} type="button" className={button} disabled={pending||!detail.writable||dirty} onClick={()=>perform(async()=>{const result=await closeOvertimeAssignmentAction({assignmentId:assignment.id,expectedRevision:assignment.revision,effectiveTo:closeDate,reason});if(succeeded(result)){setNotice('assignmentClosed');router.refresh();}})}>{t('closeAssignment')}</ActionButton></div></details>)}
      </div>
      <div role="tabpanel" id="ot-panel-preview" aria-labelledby="ot-tab-preview" hidden={section!=='preview'} className="space-y-5 rounded-xl border border-border bg-card p-5"><OvertimeSetupSummary name={name} code={code} description={description} pattern={pattern} choices={choices} assignments={detail?.assignments.filter(assignment=>assignment.versionId===version?.id)??[]} earningItems={setup.earningItems} onEdit={step=>setSection(step)}/>{editable?<ActionButton guardNavigation aria-busy={pending} type="button" className={btnPrimary} disabled={pending||needsCompany} onClick={()=>save(true)}>{t(pending?'working':'guided.savePattern')}</ActionButton>:null}</div>
      {editable?<p role="note" className="rounded-lg bg-primary/5 p-4 text-sm text-muted-foreground">{t('guided.draftOnlyNote')}</p>:null}
      <div className="flex items-center justify-between gap-3" aria-label={t('guided.stepNavigation')}><button type="button" className={button} disabled={section==='basic'||pending} onClick={()=>moveTab(OVERTIME_WORKSPACE_SECTIONS[OVERTIME_WORKSPACE_SECTIONS.indexOf(section)-1])}>{t('guided.back')}</button><span className="text-xs text-muted-foreground">{t('guided.stepOf',{current:OVERTIME_WORKSPACE_SECTIONS.indexOf(section)+1,total:STEPS})}</span>{section!=='preview'?<button type="button" className={btnPrimary} disabled={pending} onClick={()=>moveTab(OVERTIME_WORKSPACE_SECTIONS[OVERTIME_WORKSPACE_SECTIONS.indexOf(section)+1])}>{t('guided.next')}</button>:<span/>}</div>
      {version?<details className="rounded-xl border border-border p-5"><summary className="cursor-pointer text-sm font-medium">{t('guided.testCalculation')}</summary><div className="mt-4"><OvertimePreviewPanel patternId={detail?.pattern.id} versionId={version.id} pattern={pattern} employees={employeeOptions} earningItems={setup.earningItems} choices={choices} disabled={dirty}/></div></details>:null}
    </>}
  </div>;
}
function ConditionOrEmployees({target,choices,currency}:{target:OvertimeAssignmentTarget;choices:OvertimeChoices;currency:string}) {
  const t=useTranslations('overtimePatterns');
  if(target.type==='individual')return <ul className="text-sm">{target.employmentIds.map(id=><li key={id}>{choices.employmentId?.find(employee=>employee.id===id)?.label??t('unavailableReference',{id})}</li>)}</ul>;
  return <fieldset disabled><ConditionControl value={target.condition} onChange={()=>{}} choices={choices} currency={currency} assignment/></fieldset>;
}
