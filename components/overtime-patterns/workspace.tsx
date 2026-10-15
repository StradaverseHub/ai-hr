'use client';

import {useEffect,useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Field,inputCls,btnPrimary} from '@/components/ui';
import {AttendanceSettingsNavigation} from '@/components/attendance-settings-navigation';
import {canRenderOvertimeDraft} from '@/lib/overtime-pattern-ui-shape';
import type {OvertimePattern,OvertimeAssignmentTarget,OvertimeIssue} from '@/lib/overtime-pattern-model';
import type {OvertimePatternDetail,OvertimePatternSetup,OvertimePatternVersionView,OvertimePatternDraft} from '@/packs/attendance/service';
import {saveOvertimeDraftAction,forkOvertimeDraftAction,validateOvertimeAction,activateOvertimeAction,stopOvertimeAction,archiveOvertimeAction,saveOvertimeAssignmentAction,closeOvertimeAssignmentAction,overtimeChoicesAction,type OvertimeActionFailure} from '@/app/admin/attendance/settings/overtime-patterns/actions';
import {OvertimeEligibilitySection,OvertimeRatesSection,OvertimeFormulaSection,OvertimeMappingSection} from './definition-sections';
import {ConditionControl,blankCondition,type OvertimeChoices} from './rule-controls';
import {OvertimePreviewPanel} from './preview-panel';
import {OvertimeIssues} from './calculation-result';

export const OVERTIME_WORKSPACE_SECTIONS=['basic','assignment','eligibility','rates','formula','mapping','preview'] as const;
type Section=typeof OVERTIME_WORKSPACE_SECTIONS[number];
const PAGE='/admin/attendance/settings/overtime-patterns';
const button='min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
const newPattern=():OvertimePattern=>({v:1,currency:{code:'',minorScale:0},eligibilityBasis:'day',definitions:[],eligibility:{id:'eligibility',type:'group',logic:'and',children:[]},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[],paymentCap:null,moneyRounding:{stage:'line',mode:'halfUp'}});
const definitionOf=(version:OvertimePatternVersionView|undefined):OvertimePattern|null=>version?.kind==='formula'?version.definition as unknown as OvertimePattern:null;

type WorkspaceProps={detail:OvertimePatternDetail|null;version?:OvertimePatternVersionView;setup:OvertimePatternSetup};
export function OvertimeWorkspace(props:WorkspaceProps) {
  const t=useTranslations('overtimePatterns');
  if(props.version?.kind==='formula'&&!canRenderOvertimeDraft(props.version.definition))return <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">{t('malformedDraft')}</p>;
  return <EditableOvertimeWorkspace {...props}/>;
}
function EditableOvertimeWorkspace({detail,version,setup}:WorkspaceProps) {
  const t=useTranslations('overtimePatterns');
  const router=useRouter();
  const initial=definitionOf(version);
  const [pattern,setPattern]=useState<OvertimePattern>(()=>initial??newPattern());
  const [basisChosen,setBasisChosen]=useState(Boolean(initial?.eligibilityBasis));
  const [code,setCode]=useState(detail?.pattern.code??'');
  const [name,setName]=useState(version?.name??'');
  const [description,setDescription]=useState(version?.description??'');
  const [creationCompanyId,setCreationCompanyId]=useState(detail?.pattern.creationCompanyId??'');
  const [companyIds,setCompanyIds]=useState<string[]>(version?.companyIds??[]);
  const [section,setSection]=useState<Section>('basic');
  const [failure,setFailure]=useState<OvertimeActionFailure|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [issues,setIssues]=useState<OvertimeIssue[]>([]);
  const [validationDigest,setValidationDigest]=useState<string|null>(null);
  const [effectiveFrom,setEffectiveFrom]=useState('');
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
  const draft:OvertimePatternDraft={code,creationCompanyId,name,description,companyIds,definition:pattern};
  const fingerprint=JSON.stringify(draft);
  const baseline=useRef(fingerprint);
  const dirty=fingerprint!==baseline.current;
  const choices:OvertimeChoices={...setup.choices,employmentId:employeeOptions.map(employee=>({id:employee.id,label:`${employee.employeeCode??''} ${employee.name}`.trim()}))};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setValidationDigest(null);},[fingerprint]);
  function update(next:OvertimePattern) {setPattern(next);setValidationDigest(null);setNotice(null);}
  function perform(work:()=>Promise<void>) {
    if(busy.current)return;
    busy.current=true;setFailure(null);setNotice(null);
    startTransition(async()=>{try{await work();}catch{if(mounted.current)setFailure({ok:false,code:'system'});}finally{busy.current=false;}});
  }
  function succeeded(result:{ok:true}|OvertimeActionFailure) {if(!result.ok){if(mounted.current)setFailure(result as OvertimeActionFailure);return false;}return mounted.current;}
  function moveTab(next:Section) {setSection(next);}
  const save=()=>perform(async()=>{
    if(companyIds.length>100){setFailure({ok:false,code:'limit'});setSection('basic');return;}
    if(!basisChosen||!pattern.currency.code){setFailure({ok:false,code:'invalid'});setSection('basic');return;}
    const result=await saveOvertimeDraftAction({patternId:detail?.pattern.id,versionId:version?.id,expectedRevision:version?.revision,draft});
    if(!succeeded(result)||!result.ok)return;
    baseline.current=fingerprint;setSavedRevision(value=>value+1);setNotice('saved');
    router.replace(`${PAGE}?pattern=${result.value.patternId}&version=${result.value.versionId}`);router.refresh();
  });
  function checkSaved() {if(!version||dirty){setFailure({ok:false,code:'invalid'});setNotice('saveBeforeAction');return false;}return true;}
  const validate=()=>perform(async()=>{
    if(!checkSaved())return;
    const result=await validateOvertimeAction({versionId:version!.id,expectedRevision:version!.revision});
    if(!succeeded(result)||!result.ok)return;
    setIssues(result.value.issues);setValidationDigest(result.value.validationDigest);setNotice(result.value.issues.some(issue=>issue.severity==='error')?'validationFailed':'validated');
  });
  const activate=()=>perform(async()=>{
    if(!checkSaved()||!validationDigest)return;
    const result=await activateOvertimeAction({versionId:version!.id,expectedRevision:version!.revision,validationDigest,effectiveFrom});
    if(succeeded(result)){setNotice('activated');router.refresh();}
  });
  const fork=()=>perform(async()=>{
    if(!version||!detail)return;
    const result=await forkOvertimeDraftAction({versionId:version.id,expectedPatternRevision:detail.pattern.revision});
    if(!succeeded(result)||!result.ok)return;
    router.push(`${PAGE}?pattern=${result.value.patternId}&version=${result.value.versionId}`);router.refresh();
  });
  const stop=()=>perform(async()=>{
    if(!version||dirty)return;
    const result=await stopOvertimeAction({versionId:version.id,expectedRevision:version.revision,effectiveFrom,reason});
    if(succeeded(result)){setNotice('stopped');router.refresh();}
  });
  const archive=()=>perform(async()=>{
    if(!detail||dirty)return;
    const result=await archiveOvertimeAction({patternId:detail.pattern.id,expectedRevision:detail.pattern.revision,reason});
    if(succeeded(result)){setNotice('archived');router.refresh();}
  });
  const assign=()=>perform(async()=>{
    if(!checkSaved()||!Number.isSafeInteger(Number(priority))||priority.trim()===''){setFailure({ok:false,code:'invalid'});return;}
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
    {failure?<div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm"><p>{t(`errors.${failure.code}`)}</p>{failure.reference?<p className="mt-1 text-xs">{t('reference',{reference:failure.reference})}</p>:null}{failure.code==='stale'?<button type="button" className={button} onClick={()=>{if(!dirty||window.confirm(t('leaveUnsaved')))router.refresh();}}>{t('reload')}</button>:null}</div>:null}
    {notice?<p role="status" className="text-sm">{t(notice)}</p>:null}
    {setup.readerLimitations.length?<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('readerLimitations')}</summary><ul className="mt-2 space-y-2 text-sm text-muted-foreground">{setup.readerLimitations.map((field,index)=><li key={index}>{t.has(`limitations.${field}`)?t(`limitations.${field}`):t('unknownHelp')}</li>)}</ul><p className="mt-2 text-sm text-muted-foreground">{t('unknownHelp')}</p></details>:null}
    {version?<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('versionHistory')} · {version.ordinal} · {t(`status.${version.status}`)}</summary><p className="mt-2 break-all text-xs text-muted-foreground">{t('versionId',{id:version.id})}</p><ol className="mt-3 space-y-2 text-sm">{version.states.map(state=><li key={state.id}>{state.effectiveFrom} · {t(`status.${state.state}`)} · {state.reason}</li>)}</ol></details>:null}
    {isLegacy?<p className="rounded-lg border border-border p-4 text-sm">{t('legacyHelp')} <a className="text-primary underline" href="/admin/attendance/schedule">{t('legacyLink')}</a></p>:<>
      <div role="tablist" aria-label={t('sectionsLabel')} className="flex gap-1 overflow-x-auto border-b border-border" onKeyDown={event=>{
        const index=OVERTIME_WORKSPACE_SECTIONS.indexOf(section);
        const next=event.key==='ArrowRight'?(index+1)%7:event.key==='ArrowLeft'?(index+6)%7:event.key==='Home'?0:event.key==='End'?6:null;
        if(next===null)return;event.preventDefault();moveTab(OVERTIME_WORKSPACE_SECTIONS[next]);document.getElementById(`ot-tab-${OVERTIME_WORKSPACE_SECTIONS[next]}`)?.focus();
      }}>{OVERTIME_WORKSPACE_SECTIONS.map(key=><button type="button" role="tab" key={key} id={`ot-tab-${key}`} aria-controls={`ot-panel-${key}`} aria-selected={section===key} tabIndex={section===key?0:-1} className={`min-h-11 shrink-0 border-b-2 px-4 py-3 text-sm ${section===key?'border-primary font-medium text-primary':'border-transparent text-muted-foreground'}`} onClick={()=>moveTab(key)}>{t(`sections.${key}`)}</button>)}</div>
      <form id="overtime-definition" method="post" onSubmit={event=>{event.preventDefault();if(editable)save();}}>
        <input type="hidden" name="overtimeDraft" value={fingerprint}/>
        <fieldset disabled={pending||!editable} className="min-w-0">
          <div role="tabpanel" id="ot-panel-basic" aria-labelledby="ot-tab-basic" hidden={section!=='basic'} className="space-y-4 rounded-xl border border-border bg-card p-5">
            <div className="grid gap-4 sm:grid-cols-2"><Field label={t('code')}><input className={inputCls} maxLength={64} value={code} readOnly={Boolean(detail)} onChange={event=>setCode(event.target.value)}/></Field><Field label={t('name')}><input className={inputCls} maxLength={160} value={name} onChange={event=>setName(event.target.value)}/></Field></div>
            <Field label={t('description')}><textarea className={inputCls} rows={3} maxLength={1000} value={description} onChange={event=>setDescription(event.target.value)}/></Field>
            <div className="grid gap-4 sm:grid-cols-2"><Field label={t('creationCompany')}><select className={inputCls} value={creationCompanyId} disabled={Boolean(detail)} onChange={event=>{setCreationCompanyId(event.target.value);setCompanyIds(event.target.value?[event.target.value]:[]);}}><option value="">{t('choose')}</option>{setup.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></Field><Field label={t('companies')}><select multiple className={`${inputCls} min-h-24`} value={companyIds} onChange={event=>setCompanyIds(Array.from(event.target.selectedOptions,option=>option.value))}>{setup.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></Field></div>
            <div className="grid gap-4 sm:grid-cols-3"><Field label={t('currency')}><select className={inputCls} value={pattern.currency.code} onChange={event=>{const company=setup.companies.find(item=>item.currency===event.target.value);if(company)update({...pattern,currency:{code:company.currency,minorScale:company.minorScale}});}}><option value="">{t('choose')}</option>{[...new Set(setup.companies.filter(company=>companyIds.includes(company.id)).map(company=>company.currency))].map(currency=><option key={currency} value={currency}>{currency}</option>)}</select></Field><Field label={t('minorScale')}><input className={inputCls} readOnly value={pattern.currency.code?String(pattern.currency.minorScale):''}/></Field><Field label={t('eligibilityBasis')}><select className={inputCls} value={basisChosen?pattern.eligibilityBasis:''} onChange={event=>{setBasisChosen(Boolean(event.target.value));update({...pattern,eligibilityBasis:event.target.value as 'day'|'session'});}}><option value="">{t('choose')}</option><option value="day">{t('bases.day')}</option><option value="session">{t('bases.session')}</option></select></Field></div>
            <p className="text-xs text-muted-foreground">{t('eligibilityBasisHelp')}</p>
          </div>
          <div role="tabpanel" id="ot-panel-eligibility" aria-labelledby="ot-tab-eligibility" hidden={section!=='eligibility'} className="rounded-xl border border-border bg-card p-5"><OvertimeEligibilitySection pattern={pattern} onChange={update} choices={choices}/></div>
          <div role="tabpanel" id="ot-panel-rates" aria-labelledby="ot-tab-rates" hidden={section!=='rates'} className="rounded-xl border border-border bg-card p-5"><OvertimeRatesSection pattern={pattern} onChange={update} choices={choices}/></div>
          <div role="tabpanel" id="ot-panel-formula" aria-labelledby="ot-tab-formula" hidden={section!=='formula'} className="rounded-xl border border-border bg-card p-5"><OvertimeFormulaSection pattern={pattern} onChange={update} choices={choices} resources={[{id:'lateIn',label:t('lateIn')},{id:'postOtBreak',label:t('postOtBreak')}]} earningItems={setup.earningItems}/></div>
          <div role="tabpanel" id="ot-panel-mapping" aria-labelledby="ot-tab-mapping" hidden={section!=='mapping'} className="rounded-xl border border-border bg-card p-5"><OvertimeMappingSection pattern={pattern} onChange={update} earningItems={setup.earningItems}/></div>
        </fieldset>
        {editable?<div className="mt-4 flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t(dirty?'unsaved':'savedState')}</span><button type="submit" className={btnPrimary} disabled={pending}>{t(pending?'working':'saveDraft')}</button></div>:<p className="mt-4 text-sm text-muted-foreground">{t('immutableHelp')}</p>}
      </form>
      <div role="tabpanel" id="ot-panel-assignment" aria-labelledby="ot-tab-assignment" hidden={section!=='assignment'} className="space-y-4 rounded-xl border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground">{t('assignmentHelp')}</p>
        <form id="overtime-assignment" method="post" data-attendance-save-scope aria-busy={pending} data-attendance-saved-receipt={assignmentReceipt} onSubmit={event=>{event.preventDefault();assign();}}><input type="hidden" name="overtimeAssignment" value={JSON.stringify({target,priority,assignmentFrom,assignmentTo})}/><fieldset disabled={pending||!detail?.writable||!version} className="space-y-4">
          <div className="flex flex-wrap items-end gap-3"><Field label={t('employeeSearch')}><input className={inputCls} value={employeeSearch} onChange={event=>setEmployeeSearch(event.target.value)}/></Field><button type="button" className={button} onClick={()=>searchEmployees()}>{t('search')}</button>{employeeCursor?<button type="button" className={button} onClick={()=>searchEmployees(true)}>{t('loadMore')}</button>:null}</div>
          <Field label={t('assignmentType')}><select className={inputCls} value={target.type} onChange={event=>setTarget(event.target.value==='individual'?{type:'individual',employmentIds:[]}:{type:'group',condition:blankCondition()})}><option value="individual">{t('individual')}</option><option value="group">{t('group')}</option></select></Field>
          {target.type==='individual'?<Field label={t('employees')}><select multiple className={`${inputCls} min-h-32`} value={target.employmentIds} onChange={event=>setTarget({type:'individual',employmentIds:Array.from(event.target.selectedOptions,option=>option.value)})}>{employeeOptions.map(employee=><option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.name}</option>)}</select></Field>:<ConditionControl value={target.condition} onChange={condition=>setTarget({type:'group',condition})} currency={pattern.currency.code} choices={choices} assignment/>}
          <div className="grid gap-3 sm:grid-cols-3"><Field label={t('priority')}><input type="number" step="1" min="0" max="9999" className={inputCls} value={priority} onChange={event=>setPriority(event.target.value)}/></Field><Field label={t('effectiveFrom')}><input type="date" className={inputCls} value={assignmentFrom} onChange={event=>setAssignmentFrom(event.target.value)}/></Field><Field label={t('exclusiveTo')}><input type="date" className={inputCls} value={assignmentTo} onChange={event=>setAssignmentTo(event.target.value)}/></Field></div>
          <button type="submit" className={button} disabled={dirty}>{t('saveAssignment')}</button>
        </fieldset></form>
        {detail?.assignments.map(assignment=><details key={assignment.id} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">{assignment.validFrom} → {assignment.validTo??t('noEnd')} · {t('priority')} {assignment.priority}</summary><div className="space-y-3 pt-3"><p className="break-all text-xs text-muted-foreground">{t('versionId',{id:assignment.versionId})}</p><ConditionOrEmployees target={assignment.target as unknown as OvertimeAssignmentTarget} choices={choices} currency={pattern.currency.code}/><Field label={t('exclusiveTo')}><input type="date" className={inputCls} value={closeDate} onChange={event=>setCloseDate(event.target.value)}/></Field><Field label={t('reason')}><input className={inputCls} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></Field><button type="button" className={button} disabled={pending||!detail.writable||dirty} onClick={()=>perform(async()=>{const result=await closeOvertimeAssignmentAction({assignmentId:assignment.id,expectedRevision:assignment.revision,effectiveTo:closeDate,reason});if(succeeded(result)){setNotice('assignmentClosed');router.refresh();}})}>{t('closeAssignment')}</button></div></details>)}
      </div>
      <div role="tabpanel" id="ot-panel-preview" aria-labelledby="ot-tab-preview" hidden={section!=='preview'} className="rounded-xl border border-border bg-card p-5"><OvertimePreviewPanel patternId={detail?.pattern.id} versionId={version?.id} pattern={pattern} employees={employeeOptions} choices={choices} disabled={dirty||!version}/></div>
      <OvertimeIssues issues={issues}/>
      {detail?.writable||!detail?<fieldset aria-label={t('lifecycle')} disabled={pending} className="space-y-4 rounded-xl border border-border p-5"><p className="text-sm text-muted-foreground">{t('activationHelp')}</p><div className="grid gap-3 sm:grid-cols-2"><Field label={t('effectiveFrom')}><input type="date" className={inputCls} value={effectiveFrom} onChange={event=>setEffectiveFrom(event.target.value)}/></Field><Field label={t('reason')}><input className={inputCls} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></Field></div><div className="flex flex-wrap gap-2">{editable?<><button type="button" className={button} disabled={!version||dirty} onClick={validate}>{t('validate')}</button><button type="button" className={btnPrimary} disabled={!validationDigest||dirty||!effectiveFrom} onClick={activate}>{t('activate')}</button></>:<button type="button" className={button} disabled={!version||Boolean(detail?.pattern.archivedAt)} onClick={fork}>{t('fork')}</button>}{version?.activatedAt?<button type="button" className={button} disabled={!effectiveFrom||!reason||dirty} onClick={stop}>{t('stop')}</button>:null}{detail?<button type="button" className={button} disabled={!reason||dirty||Boolean(detail.pattern.archivedAt)} onClick={archive}>{t('archive')}</button>:null}</div></fieldset>:null}
    </>}
  </div>;
}
function ConditionOrEmployees({target,choices,currency}:{target:OvertimeAssignmentTarget;choices:OvertimeChoices;currency:string}) {
  const t=useTranslations('overtimePatterns');
  if(target.type==='individual')return <ul className="text-sm">{target.employmentIds.map(id=><li key={id}>{choices.employmentId?.find(employee=>employee.id===id)?.label??t('unavailableReference',{id})}</li>)}</ul>;
  return <fieldset disabled><ConditionControl value={target.condition} onChange={()=>{}} choices={choices} currency={currency} assignment/></fieldset>;
}
