'use client';
import {useLocale,useTranslations} from 'next-intl';
import {useOnboardingCopy} from '@/lib/onboarding-copy';
import {useContractSharedCopy} from '@/lib/contract-shared-copy';
import {lazy,Suspense,useEffect,useState} from 'react';
const ResignationOffboardingDocuments=lazy(()=>import('@/components/resignation/offboarding-documents').then(module=>({default:module.ResignationOffboardingDocuments})));
import Link from 'next/link';
import {Button, Field} from '@/components/ui';
import {OnboardingBreadcrumb, OnboardingBadge} from '@/components/onboarding-workspace';
import {CasePageHeader, CaseSummaryCards, CaseSummaryCard, CaseSection, CaseColumns, CaseAside, CaseTaskRow, CaseItemsTable, CaseDocumentsList, CaseDocumentRow,caseTasksByDue} from '@/components/lifecycle-v9/case-layout';
import {onboardingRelative} from '@/lib/onboarding-presentation';
import {onboardingTimestamp} from '@/lib/onboarding-format';
import {todayInKualaLumpur} from '@/lib/hr-date';
import * as M from '@/lib/lifecycle-v9-model';
import type {LifecycleV9Workspace as Workspace,LifecycleV9CaseDetail, LifecycleV9Command as Command} from '@/packs/lifecycle/service';
import {OffboardingCaseForm} from './offboarding-case-form';
import {CaseNotes} from './case-notes';
import {PreviousCaseNotes} from '@/components/lifecycle-v9/previous-case-notes';
import {CaseStatus} from './case-status';
import {WorkAssignee} from './work-assignee';
import {ChecklistPreview} from './checklist-preview';
import {OffboardingReturns} from './offboarding-returns';
import {CaseCalculator} from './case-calculator';
import {CaseFiles} from './case-files';
import {CaseWorkflows} from './case-workflows';
import {CaseEmails} from './email-composer';
import {CaseMailHistory} from './mail-history';
import {PersonnelReview} from './personnel-review';
import {readV9Case} from './actions';

const date=(value:string)=>M.validDate(value)?value.split('-').reverse().join('/'):'—';
export {caseTasksByDue} from '@/components/lifecycle-v9/case-layout';
export function OffboardingCaseView({c, config, users, actor, personnelWritableKeys, busy, command, onDocument, onReason, onOpenWorkflow, onBack, canOpenTasks=true,canConfigure=false, today=todayInKualaLumpur()}: {
 c:M.Case;config:M.Config;users:Workspace['options']['users'];actor:M.Actor;personnelWritableKeys:string[];busy:boolean;
 command:(value:Command)=>Promise<{ok:boolean;error?:string}>;onDocument:(document:M.Document)=>void;onReason:(type:'cancel'|'reopen')=>void;onOpenWorkflow:(id:string)=>void;onBack:()=>void;canOpenTasks?:boolean;canConfigure?:boolean;today?:string;
}){
 const copy=useOnboardingCopy(),contractCopy=useContractSharedCopy(),locale=useLocale(),t=useTranslations('resignationJourney');
 const [detail,setDetail]=useState<LifecycleV9CaseDetail|null>(null),[detailError,setDetailError]=useState(''),[detailLoaded,setDetailLoaded]=useState(false),[detailAttempt,setDetailAttempt]=useState(0),[manualTemplate,setManualTemplate]=useState('');
 useEffect(()=>{let active=true;setDetail(null);setDetailError('');setDetailLoaded(false);void readV9Case(c.id).then(result=>{if(!active)return;if(result?.ok)setDetail(result.detail);else setDetailError(result?.error??t('failed'));}).catch(()=>{if(active)setDetailError(t('failed'));}).finally(()=>{if(active)setDetailLoaded(true);});return()=>{active=false;};},[c.id,c.revision,detailAttempt,t]);
 const [editing,setEditing]=useState(c.state==='pending'),[error,setError]=useState('');
 useEffect(()=>{setEditing(c.state==='pending');},[c.id,c.state]);
 const managedResignation='resignationSourceCaseId' in c&&typeof c.resignationSourceCaseId==='string'&&!!c.resignationSourceCaseId;
 const verifiedScope=detail?.case.id===c.id?detail.resignationDocuments:undefined,verifiedManaged=!!verifiedScope;
 const ownedTemplateIds=verifiedScope?.ownedTemplateIds??[],warnings=verifiedScope?.configurationWarnings??[],pendingSource=managedResignation&&!detailLoaded;
 const manualTemplates=verifiedManaged?config.templates.filter(template=>template.module==='off'&&!template.retired&&M.currentVersion(template)&&M.matches(template.rules,c.facts)&&!ownedTemplateIds.includes(template.id)):[];
 const ownedTasks=(c.state==='pending'?M.matchChecklist(config,c).checklist?.tasks??[]:c.tasks).filter(task=>task.documentTemplate&&ownedTemplateIds.includes(task.documentTemplate));
 const state=M.work(c),tasks=caseTasksByDue(c.tasks),next=tasks.find(task=>!M.isResolved(task.status)),first=c.log[0];
 const userName=(id:string|null)=>users.find(user=>user.id===id)?.name??'Unassigned';
 const groupName=(id:string|null)=>config.groups.find(group=>group.id===id)?.name??'Unassigned team';
 const status=c.state==='cancelled'?'Cancelled':c.state==='cleared'?'Cleared':c.state==='pending'?'Pending submission':c.review?'Needs HR review':state.open.length?'In progress':'Ready for clearance';
 const tone=c.state==='cancelled'?'danger':c.state==='pending'||c.review?'warning':c.state==='cleared'||!state.open.length?'success':'neutral';
 const note=(context:string,label:string)=><CaseNotes key={context} c={c} context={context} label={label} actor={actor} users={users} busy={busy} command={command}/>;
 async function toggle(task:M.Task,done:boolean){setError('');try{const result=await command({type:'task',id:task.id,status:done?'done':'todo',reason:''});if(!result.ok)setError(result.error??'The task could not be saved.');}catch{setError('The task could not be saved. Try again.');}}
 return <div className="onb-workspace lifecycle-case-page space-y-5" aria-busy={busy}>
  <OnboardingBreadcrumb root="Offboarding" items={[{label:'Leavers',href:'/lifecycle/v9?view=leavers'},{label:c.facts.name}]}/>
  <CasePageHeader eyebrow={<>{c.number} · {copy(status)}</>} title={c.facts.name} detail={<>{c.facts.employeeNo}{c.facts.title&&!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(c.facts.title)?` · ${c.facts.title}`:''} · Last working day {date(c.facts.lastDay)}</>} actions={<>
   <Link href="/lifecycle/v9?view=leavers" onClick={onBack}><Button variant="outline">{copy('Leavers')}</Button></Link>
   {canOpenTasks&&<Link href="/lifecycle/v9?view=tasks"><Button variant="outline">{copy('My tasks')}</Button></Link>}
   {['pending','submitted'].includes(c.state)&&<Button variant="outline" onClick={()=>onReason('cancel')}>{copy('Cancel offboarding case')}</Button>}
   {c.state==='cleared'&&<Button variant="outline" onClick={()=>onReason('reopen')}>{copy('Reopen case')}</Button>}
   {['pending','submitted'].includes(c.state)&&!editing&&<Button variant="outline" onClick={()=>setEditing(true)}>{copy('Edit details')}</Button>}
  </>}/>
  {c.contractSharedSourceCaseId&&<div className="v9-notice" role="status"><strong>{contractCopy('Contract Management handoff')}</strong><p>{contractCopy(c.state==='cleared'?'Offboarding clearance completed.':'Offboarding clearance pending.')} {contractCopy('People Ops records termination manually in Personnel Management. Contract Management does not end employment automatically.')}</p><Link href={`/lifecycle/contracts/${encodeURIComponent(c.contractSharedSourceCaseId)}`}>{contractCopy('Open source Contract case')}</Link></div>}
  <CaseSummaryCards>
   <CaseSummaryCard label={copy('Last working day')} value={date(c.facts.lastDay)} detail={<>{onboardingRelative(c.facts.lastDay,today,locale)} · Access revoked {date(c.revokeDate)}</>}/>
   <CaseSummaryCard label={copy('Case status')} value={<OnboardingBadge tone={tone}>{copy(status)}</OnboardingBadge>} detail={first?<>{first.detail} · {onboardingTimestamp(first.at)}</>:'Source not recorded'}/>
   <CaseSummaryCard label={copy('Overall progress')} value={c.state==='pending'?copy('Not started'):`${state.percent}%`} detail={<><progress value={state.done} max={state.total||1} aria-label={copy('Overall progress')}/>{c.state==='pending'?'Review the preview below':`${state.done} of ${state.total} done`}</>}/>
   <CaseSummaryCard label={copy('Next step')} value={c.state==='pending'?'Submit the offboarding case':c.state==='cancelled'||c.state==='cleared'?copy('No further action'):next?.name??'Review clearance'} detail={next&&c.state==='submitted'?`Due ${date(next.dueOn)} · ${userName(next.assignee)}`:undefined}/>
  </CaseSummaryCards>
  {c.review&&<div className="v9-notice v9-warning" role="status"><strong>{copy('Needs HR review')}</strong><p>{c.review.detail}</p></div>}
  {error&&<p role="alert" className="v9-error">{error}</p>}
  <CaseColumns><div className="onb-main">
   <CaseSection title={copy('Case details')}><OffboardingCaseForm key={`${c.id}:${c.revision}`} c={c} config={config} users={users} busy={busy} command={command} editing={editing} onEditingChange={setEditing}/><PreviousCaseNotes notes={c.notes ?? []}/></CaseSection>
   <CaseSection title={copy('Offboarding checklist')}>
    <Field label={copy('Checklist choice')}><select aria-label={copy('Checklist choice')} value={c.state==='pending'?c.override:c.checklistId??''} disabled={busy||c.state!=='pending'} onChange={event=>void command({type:'override',checklist:event.target.value})}>
     {c.state==='pending'?<><option value="automatic">{copy('Automatic matching')}</option><option value="none">{copy('No checklist (manual choice)')}</option>{config.checklists.filter(checklist=>checklist.module===c.module).map(checklist=><option key={checklist.id} value={checklist.id}>{checklist.name}</option>)}</>:<option value={c.checklistId??''}>{c.checklistName||'No checklist'}</option>}
    </select></Field>
    {c.state==='pending'?<ChecklistPreview c={c} config={config}/>:<div>{tasks.map(task=><CaseTaskRow key={task.id} name={task.name} done={task.status==='done'}
     checkbox={<input type="checkbox" aria-label={`Mark task done ${task.name}`} checked={task.status==='done'} disabled={busy||c.state!=='submitted'||!!task.documentTemplate||!!task.opensOn&&task.opensOn>today} onChange={event=>void toggle(task,event.target.checked)}/>}
     metadata={<>Due {date(task.dueOn)} · {task.mode==='rr'?'Round robin':'Manual assignment'} · {task.by==='group'?groupName(task.group):task.by==='manager'?'Line manager':'Leaver'}</>}
     assignment={<>{(!task.group||c.state!=='submitted'||M.isResolved(task.status))&&<span className="onb-muted">{userName(task.assignee)}</span>}<WorkAssignee name={task.name} group={task.group} assignee={task.assignee} config={config} users={users} busy={busy} editable={c.state==='submitted'&&!M.isResolved(task.status)} change={userId=>command({type:'assign',id:task.id,userId})}/></>}
     warning={task.assignmentFailure}
     status={<><span>{task.opensOn&&task.opensOn>today?`Opens ${date(task.opensOn)}`:task.status==='todo'?'To do':task.status==='progress'?'In progress':task.status==='notNeeded'?'Not needed':'Done'}</span><CaseStatus compact name={task.name} kind="task" value={task.status} reason={task.reason} busy={busy} editable={c.state==='submitted'} documentLinked={!!task.documentTemplate} change={(status,reason)=>command({type:'task',id:task.id,status:status as M.Task['status'],reason})}/></>}
     actions={task.documentTemplate&&ownedTemplateIds.includes(task.documentTemplate)?<span className="text-sm text-muted-foreground">{t('journeyOwnedDocument')}</span>:task.documentTemplate?<Button variant="outline" disabled={busy} onClick={()=>{const document=M.activeDocument(c,task.documentTemplate!);if(document)onDocument(document);else void command({type:'generate',template:task.documentTemplate!});}}>{copy('Open document')}</Button>:undefined}
    >{note(task.id,task.name)}</CaseTaskRow>)}{!tasks.length&&<p className="onb-muted">{copy('No checklist tasks.')}</p>}</div>}
   </CaseSection>
   <CaseCalculator c={c} busy={busy} command={command} source={{detail,error:detailError}}/>
  </div><CaseAside label={copy('Summary')}>
   <CaseSection title={copy('Progress by assignee')}>{[...new Set(c.tasks.map(task=>task.assignee))].map(id=>{const assigned=c.tasks.filter(task=>task.assignee===id),done=assigned.filter(task=>M.isResolved(task.status)).length;return <div key={id??'unassigned'}><div className="flex justify-between gap-3"><strong>{userName(id)}</strong><span className="onb-muted">{done} of {assigned.length} done</span></div><progress value={done} max={assigned.length||1} aria-label={userName(id)} className="h-1 w-full"/></div>;})}{!c.tasks.length&&<p className="onb-muted">{copy('Tasks start when the checklist is confirmed.')}</p>}</CaseSection>
   <CaseSection title={copy('Case history')}><ol className="lifecycle-case-history v9-list">{c.log.slice().reverse().map(log=><li key={log.id}><div>{log.detail}</div><div className="onb-muted">{log.actor.name} · {onboardingTimestamp(log.at)}</div></li>)}</ol></CaseSection>
   <CaseSection title={copy('From Personnel Management')}>{c.pmChanges.length?<PersonnelReview key={c.id} c={c} busy={busy} writableKeys={personnelWritableKeys} command={command}/>:<p className="onb-muted">{copy('No changes awaiting Personnel Management review.')}</p>}</CaseSection>
  </CaseAside></CaseColumns>
  <OffboardingReturns c={c} config={config} users={users} busy={busy} command={command} note={note}/>
  <CaseSection title={copy('Documents')}>{warnings.length>0&&<div role="alert" className="v9-notice v9-warning"><strong>{t('checklistReviewRequired')}</strong><ul>{ownedTasks.length?ownedTasks.map(task=><li key={task.id}>{t('ownedChecklistWarning',{task:task.name})}</li>):warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}{(c.documents.length>0||!managedResignation)&&<CaseDocumentsList empty={copy("Documents appear when their workflow runs.")}>{c.documents.length?c.documents.map(document=><CaseDocumentRow key={document.id} name={document.name} detail={`Version ${document.version}`} status={<OnboardingBadge>{copy(document.status)}</OnboardingBadge>} actions={<><Button variant="outline" onClick={()=>onDocument(document)}>{copy("Open")} {document.name}</Button>{M.canRegenerate(c,document)&&!ownedTemplateIds.includes(document.templateId)&&<Button variant="outline" disabled={busy} onClick={()=>void command({type:'documentRegenerate',id:document.id})}>{copy("Regenerate")} {document.name}</Button>}</>}/>):null}</CaseDocumentsList>}{managedResignation&&<Suspense fallback={null}><ResignationOffboardingDocuments key={c.id} offboardingCaseId={c.id}/></Suspense>}{verifiedManaged&&manualTemplates.length>0&&<form className="mt-4 space-y-3 border-t pt-4" onSubmit={async event=>{event.preventDefault();if(!manualTemplates.some(template=>template.id===manualTemplate))return;setError('');try{const result=await command({type:'generate',template:manualTemplate});if(result.ok)setManualTemplate('');else setError(result.error??t('failed'));}catch{setError(t('failed'));}}}><label className="block space-y-1 text-sm"><span>{t('manualClearanceForm')}</span><select className="v9-input" value={manualTemplate} disabled={busy||c.state!=='submitted'} onChange={event=>setManualTemplate(event.target.value)}><option value="">{t('chooseClearanceForm')}</option>{manualTemplates.map(template=><option key={template.id} value={template.id}>{template.name}</option>)}</select></label><Button type="submit" variant="outline" disabled={busy||c.state!=='submitted'||!manualTemplates.some(template=>template.id===manualTemplate)}>{t('generateClearanceForm')}</Button></form>}</CaseSection>
  <CaseFiles key={c.id} c={c} config={config} readOnly/>
  {verifiedManaged?<CaseSection title={t('sharedCommunications')}><p className="text-sm text-muted-foreground">{t('sharedCommunicationsHint')}</p>{canConfigure&&<Link className="mt-3 inline-flex text-sm font-medium text-primary underline" href="/automation/workflows?module=off">{t('openSharedConfiguration')}</Link>}</CaseSection>:managedResignation&&(pendingSource||detailError)?<section className="space-y-2">{pendingSource?<p role="status">{t('loading')}</p>:<><p role="alert" className="text-destructive">{detailError}</p><Button variant="outline" onClick={()=>setDetailAttempt(value=>value+1)}>{t('reload')}</Button></>}</section>:<><CaseWorkflows c={c} config={config} busy={busy} command={command} onOpenWorkflow={onOpenWorkflow} users={users}/><CaseEmails c={c} config={config} busy={busy} command={command}/></>}
  <CaseSection title={copy('Sent emails')}>{c.mails.length?<CaseMailHistory caseId={c.id} mails={c.mails} userName={userName} open={c.state==='submitted'&&!verifiedManaged&&!pendingSource} busy={busy} command={command}/>:<p className="onb-muted">{copy('No email deliveries recorded.')}</p>}</CaseSection>
  <CaseSection title={copy('Exit clearance')}>{c.state==='pending'?<p className="onb-muted">Submit this case to start its checklist and return/revoke work.</p>:c.state==='cleared'?<p>Cleared by {c.closedBy?.name} · {c.closedAt?onboardingTimestamp(c.closedAt):''}{c.closeReason?' · '+c.closeReason:''}</p>:<p className="onb-muted">{state.open.length} tasks or items still open. {state.notReturned.length?`${state.notReturned.length} items were not returned. HR must record how they were settled.`:''}</p>}</CaseSection>
 </div>;
}
