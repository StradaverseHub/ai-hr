'use client';
import {useLocale} from 'next-intl';
import {useOnboardingCopy} from '@/lib/onboarding-copy';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {Button, Field} from '@/components/ui';
import {OnboardingBreadcrumb, OnboardingBadge} from '@/components/onboarding-workspace';
import {CasePageHeader, CaseSummaryCards, CaseSummaryCard, CaseSection, CaseColumns, CaseAside, CaseTaskRow, CaseItemsTable, CaseDocumentsList, CaseDocumentRow,caseTasksByDue} from '@/components/lifecycle-v9/case-layout';
import {onboardingRelative} from '@/lib/onboarding-presentation';
import {onboardingTimestamp} from '@/lib/onboarding-format';
import {todayInKualaLumpur} from '@/lib/hr-date';
import * as M from '@/lib/lifecycle-v9-model';
import type {LifecycleV9Workspace as Workspace, LifecycleV9Command as Command} from '@/packs/lifecycle/service';
import {OffboardingCaseForm} from './offboarding-case-form';
import {CaseNotes} from './case-notes';
import {PreviousCaseNotes} from '@/components/lifecycle-v9/previous-case-notes';
import {CaseStatus} from './case-status';
import {WorkAssignee} from './work-assignee';
import {ChecklistPreview} from './checklist-preview';
import {PendingReturns} from './pending-returns';
import {CaseCalculator} from './case-calculator';
import {CaseFiles} from './case-files';
import {CaseWorkflows} from './case-workflows';
import {CaseEmails} from './email-composer';
import {CaseMailHistory} from './mail-history';
import {PersonnelReview} from './personnel-review';

const date=(value:string)=>M.validDate(value)?value.split('-').reverse().join('/'):'—';
export {caseTasksByDue} from '@/components/lifecycle-v9/case-layout';
export function OffboardingCaseView({c, config, users, actor, personnelWritableKeys, busy, command, onDocument, onReason, onOpenWorkflow, onBack, canOpenTasks=true, today=todayInKualaLumpur()}: {
 c:M.Case;config:M.Config;users:Workspace['options']['users'];actor:M.Actor;personnelWritableKeys:string[];busy:boolean;
 command:(value:Command)=>Promise<{ok:boolean;error?:string}>;onDocument:(document:M.Document)=>void;onReason:(type:'cancel'|'reopen')=>void;onOpenWorkflow:(id:string)=>void;onBack:()=>void;canOpenTasks?:boolean;today?:string;
}){
 const copy=useOnboardingCopy(),locale=useLocale();
 const [editing,setEditing]=useState(c.state==='pending'),[error,setError]=useState('');
 useEffect(()=>{setEditing(c.state==='pending');},[c.id,c.state]);
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
     actions={task.documentTemplate?<Button variant="outline" disabled={busy} onClick={()=>{const document=M.activeDocument(c,task.documentTemplate!);if(document)onDocument(document);else void command({type:'generate',template:task.documentTemplate!});}}>{copy('Open document')}</Button>:undefined}
    >{note(task.id,task.name)}</CaseTaskRow>)}{!tasks.length&&<p className="onb-muted">{copy('No checklist tasks.')}</p>}</div>}
   </CaseSection>
   <CaseCalculator c={c} busy={busy} command={command}/>
  </div><CaseAside label={copy('Summary')}>
   <CaseSection title={copy('Progress by assignee')}>{[...new Set(c.tasks.map(task=>task.assignee))].map(id=>{const assigned=c.tasks.filter(task=>task.assignee===id),done=assigned.filter(task=>M.isResolved(task.status)).length;return <div key={id??'unassigned'}><div className="flex justify-between gap-3"><strong>{userName(id)}</strong><span className="onb-muted">{done} of {assigned.length} done</span></div><progress value={done} max={assigned.length||1} aria-label={userName(id)} className="h-1 w-full"/></div>;})}{!c.tasks.length&&<p className="onb-muted">{copy('Tasks start when the checklist is confirmed.')}</p>}</CaseSection>
   <CaseSection title={copy('Case history')}><ol className="lifecycle-case-history v9-list">{c.log.slice().reverse().map(log=><li key={log.id}><div>{log.detail}</div><div className="onb-muted">{log.actor.name} · {onboardingTimestamp(log.at)}</div></li>)}</ol></CaseSection>
   <CaseSection title={copy('From Personnel Management')}>{c.pmChanges.length?<PersonnelReview key={c.id} c={c} busy={busy} writableKeys={personnelWritableKeys} command={command}/>:<p className="onb-muted">{copy('No changes awaiting Personnel Management review.')}</p>}</CaseSection>
  </CaseAside></CaseColumns>
  <CaseSection title={copy('Return and revoke')}><p className="onb-muted">{c.items.length} items · Return company items and revoke system access.</p>{c.state==='pending'?<PendingReturns c={c} config={config} busy={busy} command={command}/>:<CaseItemsTable label={copy('Return and revoke')} headings={['Item','Type','Provided by','Owner','Return or revoke by','Status'].map(label=>copy(label))}>
   {c.items.map(item=><tr key={item.id}><td><strong>{item.name}</strong><p className="onb-muted">{item.nativeSource?<Link className="v9-link" href={`/lifecycle/requisitions/onboarding/${item.nativeSource.caseId}`}>{item.nativeSource.requestNumber} · handed onboarding item</Link>:item.sourceId?'Issued asset register':item.sourceCatalogueId?'Added by HR from the catalogue':'Case item'}{item.kind==='system'&&' · HR records confirmed revocation'}</p>{item.returnReported&&item.status!=='done'&&<p className="v9-notice">Employee says this item was returned on {date(item.returnReported.at.slice(0,10))}{item.returnReported.note?' · '+item.returnReported.note:''}. Waiting for the providing team to confirm.</p>}{note(item.id,item.name)}</td><td>{item.kind==='system'?'Access':'Item'}</td><td>—</td><td><WorkAssignee name={item.name} group={item.group} assignee={item.assignee} config={config} users={users} busy={busy} editable={c.state==='submitted'&&!M.isResolved(item.status)&&item.status!=='notReturned'} change={userId=>command({type:'assignItem',id:item.id,userId})}/><span className="onb-muted">{userName(item.assignee)}</span></td><td>{date(item.dueOn)}</td><td><CaseStatus name={item.name} kind="item" value={item.status} reason={item.reason} busy={busy} editable={c.state==='submitted'} change={(status,reason)=>command({type:'item',id:item.id,status,reason})}/></td></tr>)}
   {!c.items.length&&<tr><td colSpan={6}>{copy('No return or revoke items recorded.')}</td></tr>}
  </CaseItemsTable>}</CaseSection>
  <CaseSection title={copy('Documents')}><CaseDocumentsList empty={copy("Documents appear when their workflow runs.")}>{c.documents.length?c.documents.map(document=><CaseDocumentRow key={document.id} name={document.name} detail={`Version ${document.version}`} status={<OnboardingBadge>{copy(document.status)}</OnboardingBadge>} actions={<><Button variant="outline" onClick={()=>onDocument(document)}>{copy("Open")} {document.name}</Button>{M.canRegenerate(c,document)&&<Button variant="outline" disabled={busy} onClick={()=>void command({type:'documentRegenerate',id:document.id})}>{copy("Regenerate")} {document.name}</Button>}</>}/>):null}</CaseDocumentsList></CaseSection>
  <CaseFiles key={c.id} c={c} config={config} readOnly/>
  <CaseWorkflows c={c} config={config} busy={busy} command={command} onOpenWorkflow={onOpenWorkflow}/>
  <CaseEmails c={c} config={config} busy={busy} command={command}/>
  <CaseSection title={copy('Sent emails')}>{c.mails.length?<CaseMailHistory caseId={c.id} mails={c.mails} userName={userName} open={c.state==='submitted'} busy={busy} command={command}/>:<p className="onb-muted">{copy('No email deliveries recorded.')}</p>}</CaseSection>
  <CaseSection title={copy('Exit clearance')}>{c.state==='pending'?<p className="onb-muted">Submit this case to start its checklist and return/revoke work.</p>:c.state==='cleared'?<p>Cleared by {c.closedBy?.name} · {c.closedAt?onboardingTimestamp(c.closedAt):''}{c.closeReason?' · '+c.closeReason:''}</p>:<p className="onb-muted">{state.open.length} tasks or items still open. {state.notReturned.length?`${state.notReturned.length} items were not returned. HR must record how they were settled.`:''}</p>}</CaseSection>
 </div>;
}
