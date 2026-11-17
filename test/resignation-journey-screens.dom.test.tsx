import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import type {Editor} from '@tiptap/core';
import {NextIntlClientProvider} from 'next-intl';
import {useState,type ReactNode} from 'react';
import messages from '../messages/en.json';
import type {ResignationCaseView,ResignationLetterView,ResignationTaskView} from '../lib/resignation-journey';
import {DocumentBody} from '../components/lifecycle-v9/document-body';
import type {Block,Document,Field} from '../lib/lifecycle-v9-model';
import {EmployeeResignation} from '../components/resignation/employee';
import {ResignationCaseCard} from '../components/resignation/case-card';
import {ResignationLetterCard} from '../components/resignation/letter-card';
import {ResignationOffboardingDocuments} from '../components/resignation/offboarding-documents';
import {ResignationBlockEditor} from '../components/resignation/block-editor';
import {money,offerDifference,PriorCases} from '../components/resignation/common';
import {ResignationTaskRows,resignationTaskInFilter} from '../components/resignation/task-rows';
import {ResignationTaskPanel} from '../components/resignation/task-panel';
import {parseApprovalCategory} from '../lib/approvals-categories';
const actions=vi.hoisted(()=>({runResignationCommand:vi.fn(),reloadResignationCase:vi.fn(),submitOwnResignation:vi.fn(),uploadOwnResignationFile:vi.fn(),loadResignationOffboarding:vi.fn(),loadResignationCommunications:vi.fn().mockResolvedValue({ok:true,value:{caseId:'case-a',revision:7,items:[]}}),testResignationMessage:vi.fn(),editResignationMessage:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/resignation/actions',()=>actions);
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:actions.refresh})}));
const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>{node}</NextIntlClientProvider>);
const c=(patch:Partial<ResignationCaseView>={}):ResignationCaseView=>({id:'case-a',number:'RSN-42',revision:7,employmentId:'employment-a',employeeName:'Fictional Employee',employeeCode:'F42',companyId:'company-a',companyName:'Fictional Company',businessGroup:'Fictional Group',department:'Finance',position:'Analyst',jobGrade:'G3',currentBasicSalary:'6800.00',currency:'MYR',stage:'decision',submittedOn:'2026-11-16',lastWorkingDay:'2026-12-16',reason:'Closer to home',noticeLabel:'1 month',earliestLastDay:'2026-12-16',offer:null,offerReplyBy:null,offerRemindOn:null,offerBlock:null,offboardingCaseId:null,replacementNeeded:null,replacementRequest:null,deciders:[{id:'manager',name:'Fictional Manager'}],keptInLoop:[{id:'bp',name:'Fictional BP'}],decisionDueOn:'2026-11-19',comments:[],priorCases:[],attachments:[],letters:[],emails:[],tasks:[],blocked:[],capabilities:{withdraw:false,accept:true,offer:true,comment:false,retry:false},...patch});
const l=(patch:Partial<ResignationLetterView>={}):ResignationLetterView=>({id:'letter-a',kind:'retention',name:'Fictional retention letter',revision:2,templateVersion:1,generatedOn:'2026-11-16',state:'review',private:false,blocks:[],editableBlocks:null,mergeValues:{},routing:[],sentBack:null,changes:[],downloadUrl:null,opened:false,document:null,capabilities:{open:true,review:false,approve:false,sign:true,sendBack:true,recall:false,edit:false,correct:false,resend:false,withdrawOffer:false,regenerate:false},...patch});
const task=(patch:Partial<ResignationTaskView>={}):ResignationTaskView=>({id:'task-a',caseId:'case-a',caseNumber:'RSN-42',revision:7,employeeName:'Fictional Employee',employeeCode:'F42',title:'Sign fictional retention letter',kind:'sign',documentId:'letter-a',dueOn:null,overdue:false,team:false,tagged:false,status:'todo',onIt:null,canComment:false,actionable:true,uploadLabel:null,...patch});
afterEach(()=>{cleanup();vi.clearAllMocks();});
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});

describe('employee resignation journey',()=>{
 it.each([
  ['decision','No final outcome has been recorded yet.','Next steps will appear after a decision is recorded.'],
  ['retention','No final outcome has been recorded yet.','The letter must finish its earlier review and signing steps before you can respond.'],
  ['offer','An offer is waiting for your response.','Open the letter before signing, declining or sending it back.'],
  ['accepted','Your resignation was accepted. The acceptance letter is still being processed.','Follow the letter and clearance actions shown for this case.'],
  ['retained','You accepted the retention offer. Your resignation is withdrawn.','HR will complete any required updates to your employment record.'],
  ['withdrawn','You withdrew this resignation. The case is closed.','This resignation has no further leaving steps.'],
  ['leaving','Your resignation is accepted. Your exit checklist follows.','Complete the handover and clearance steps provided by HR.'],
 ] as const)('shows truthful outcome and next steps for the %s stage',(stage,outcome,next)=>{
  wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:null,canSubmit:false,cases:[c({stage})]}}/>);
  const tracker=screen.getByRole('list',{name:messages.resignationJourney.title}),steps=within(tracker).getAllByRole('listitem');
  expect(steps[2]).toHaveTextContent(outcome);expect(steps[3]).toHaveTextContent(next);
  if(!['accepted','leaving'].includes(stage))expect(tracker).not.toHaveTextContent('Your resignation is accepted.');
  if(stage==='accepted')expect(steps[2]).toHaveAttribute('aria-current','step');
 });
 it.each([[3,false,'3 working days left'],[0,true,'0 working days left'],[-1,true,'Reply overdue by 1 working day']] as const)('shows the server company-calendar reply count %i and reminder warning',(remaining,warning,copy)=>{
  const offer={position:'Senior Analyst',jobGrade:'G4',basicSalary:'7600.00',effectiveDate:'2027-01-01',justification:'Revised terms'};
  const rendered=wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:null,canSubmit:false,cases:[c({stage:'offer',offer,offerReplyBy:'2026-11-20',offerWorkingDaysRemaining:remaining,offerReplyWarning:warning})]}}/>);
  const deadline=rendered.container.querySelector('[data-offer-reply]');expect(deadline).toHaveTextContent('Reply by 20-Nov-2026');expect(deadline).toHaveTextContent(copy);expect(deadline?.classList.contains('bg-amber-100')).toBe(warning);
 });
 it('renders the same employee terms and reply timing on the authorized direct case, without exposing a private offer',()=>{
  const offer={position:'Senior Analyst',jobGrade:'G4',basicSalary:'7600.00',effectiveDate:'2027-01-01',justification:'Revised terms'},value=c({stage:'offer',offer,viewerIsEmployee:true,offerReplyBy:'2026-11-20',offerWorkingDaysRemaining:2,offerReplyWarning:true,capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}});
  const rendered=wrap(<ResignationCaseCard initial={value} today="2026-11-16"/>);expect(screen.getByText('Senior Analyst')).toBeInTheDocument();expect(screen.getByText('MYR 7,600.00')).toBeInTheDocument();expect(rendered.container.querySelector('[data-offer-reply]')).toHaveTextContent('2 working days left');
  cleanup();wrap(<ResignationCaseCard initial={{...value,stage:'retention'}} today="2026-11-16"/>);expect(screen.queryByText('MYR 7,600.00')).not.toBeInTheDocument();expect(screen.queryByText('Senior Analyst')).not.toBeInTheDocument();
 });

 it('uses the policy date, preserves input on refusal, and does not expose another submission while active',async()=>{
  actions.submitOwnResignation.mockResolvedValue({ok:false,error:'Try again later'});
  wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:null,canSubmit:true,cases:[]}}/>);
  const date=screen.getByLabelText('Last working day');expect(date).toHaveAttribute('min','2026-12-16');
  fireEvent.change(screen.getByLabelText('Reason (optional)'),{target:{value:'Keep this draft'}});
  fireEvent.submit(screen.getByRole('button',{name:'Submit resignation'}).closest('form')!);
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Try again later'));
  expect(screen.getByLabelText('Reason (optional)')).toHaveValue('Keep this draft');
  const form=actions.submitOwnResignation.mock.calls[0][0] as FormData;expect(form.get('employmentId')).toBe('employment-a');expect(form.get('lastWorkingDay')).toBe('2026-12-16');
  cleanup();wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:null,canSubmit:false,cases:[c({capabilities:{withdraw:true,accept:false,offer:false,comment:false,retry:false}})]}}/>);
  expect(screen.queryByRole('button',{name:'Submit resignation'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'Withdraw resignation'})).toBeInTheDocument();expect(screen.getByText('RSN-42')).toBeInTheDocument();
 });
 it('still submits without a decision workflow, preserves a refused draft, and tracks the recorded setup issue without claiming anyone was notified',async()=>{
  const reason='Keep this resignation reason',recorded=c({reason,deciders:[],keptInLoop:[],decisionDueOn:null,blocked:['Nobody was asked to record the resignation decision.','No active PeopleOps or authorized Offboarding HR recipient is configured. No repair notification was sent.'],capabilities:{withdraw:true,accept:false,offer:false,comment:false,retry:false,runAgain:false}});
  actions.submitOwnResignation.mockResolvedValueOnce({ok:false,error:'Save unavailable'}).mockResolvedValueOnce({ok:true,value:recorded});
  wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:null,configurationMessage:'No live decision workflow is configured.',canSubmit:true,cases:[]}}/>);
  expect(screen.getByText('No live decision workflow is configured.')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Submit resignation'})).toBeEnabled();fireEvent.change(screen.getByLabelText('Reason (optional)'),{target:{value:reason}});fireEvent.submit(screen.getByRole('button',{name:'Submit resignation'}).closest('form')!);
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Save unavailable'));expect(screen.getByLabelText('Reason (optional)')).toHaveValue(reason);const submit=await screen.findByRole('button',{name:'Submit resignation'});fireEvent.submit(submit.closest('form')!);
  expect(await screen.findByText('Your resignation is recorded. A decision maker has not been assigned yet.')).toBeInTheDocument();expect(screen.getByText('RSN-42')).toBeInTheDocument();expect(screen.getByText(reason)).toBeInTheDocument();expect(screen.getByText('No active PeopleOps or authorized Offboarding HR recipient is configured. No repair notification was sent.')).toBeInTheDocument();expect(screen.getByText('A decision maker has not been assigned. The workflow setup needs attention.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Submit resignation'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Run workflows again'})).not.toBeInTheDocument();expect(screen.queryByText('HR has been notified.')).not.toBeInTheDocument();expect(screen.queryByText('Your resignation is accepted. Your exit checklist follows.')).not.toBeInTheDocument();expect(screen.getByText('Next steps will appear after a decision is recorded.')).toBeInTheDocument();expect((actions.submitOwnResignation.mock.calls[1][0] as FormData).get('reason')).toBe(reason);
 });
 it('shows the employee retention comparison in the case currency',()=>{
  const offer={position:'Analyst',jobGrade:'G4',basicSalary:'7600.00',effectiveDate:'2027-01-01',justification:'Revised terms'};
  wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:null,canSubmit:false,cases:[c({stage:'offer',currency:'SGD',offer,capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})]}}/>);
  expect(screen.getByText('SGD 6,800.00')).toBeInTheDocument();expect(screen.getByText('SGD 7,600.00')).toBeInTheDocument();expect(screen.getByText('Basic salary (per month) · SGD')).toBeInTheDocument();expect(screen.queryByText(/RM |MYR /)).not.toBeInTheDocument();
 });
 it('allows a new case after retention without deleting earlier history',()=>{
  wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:null,canSubmit:true,cases:[c({stage:'retained',capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})]}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Submit a new resignation'}));expect(screen.getByRole('button',{name:'Submit resignation'})).toBeInTheDocument();
 });
});

describe('manager decision and BP information',()=>{
 it('hides retention only for an explicit accept-only workflow while preserving a cooldown explanation',()=>{
  const base=c({decisionChoices:'accept',offerBlock:'This workflow step allows accept only.',capabilities:{...c().capabilities,offer:false}});wrap(<ResignationCaseCard initial={base} today="2026-11-16"/>);expect(screen.getByRole('radio',{name:'Accept resignation'})).toBeInTheDocument();expect(screen.queryByRole('radio',{name:messages.resignationJourney.retain})).not.toBeInTheDocument();
  cleanup();wrap(<ResignationCaseCard initial={{...base,decisionChoices:'both',offerBlock:'Another offer can be made from 16 November 2027.'}} today="2026-11-16"/>);expect(screen.getByRole('radio',{name:messages.resignationJourney.retain})).toBeDisabled();expect(screen.getByText('Another offer can be made from 16 November 2027.')).toBeInTheDocument();
 });

 it('submits the edited agreed date and replacement choice under the original case revision',async()=>{
  actions.runResignationCommand.mockResolvedValue({ok:true,value:c({stage:'accepted',capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})});
  wrap(<ResignationCaseCard initial={c()} today="2026-11-16"/>);
  fireEvent.click(screen.getByRole('radio',{name:'Accept resignation'}));
  fireEvent.change(screen.getByLabelText('Agreed last working day'),{target:{value:'2026-12-20'}});
  fireEvent.change(screen.getByLabelText('Replacement needed?'),{target:{value:'no'}});
  fireEvent.submit(screen.getByRole('button',{name:'Accept resignation'}).closest('form')!);
  await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'accept',lastWorkingDay:'2026-12-20',replacementNeeded:false}}));
 });
 it('shows exact monthly difference, the percentage and no allowance field',()=>{
  wrap(<ResignationCaseCard initial={c()} today="2026-11-16"/>);
  fireEvent.change(screen.getByLabelText('Basic salary (per month) · MYR'),{target:{value:'7600'}});
  expect(screen.getByText('+MYR 800.00')).toBeInTheDocument();expect(screen.getByText('+11.8%')).toBeInTheDocument();expect(screen.queryByText(/allowance/i)).not.toBeInTheDocument();
  expect(offerDifference('100.01','100.02','MYR')).toEqual({monthly:'+MYR 0.01',percent:'+0.0%'});
 });
 it('labels a foreign-company comparison and its monthly delta with the frozen case currency',()=>{
  wrap(<ResignationCaseCard initial={c({currency:'SGD'})} today="2026-11-16"/>);fireEvent.change(screen.getByLabelText('Basic salary (per month) · SGD'),{target:{value:'7600'}});expect(screen.getByText('SGD 6,800.00')).toBeInTheDocument();expect(screen.getByText('+SGD 800.00')).toBeInTheDocument();expect(screen.queryByText(/RM |MYR /)).not.toBeInTheDocument();
 });
 it('shows bare amounts when currency is unknown and never guesses MYR',()=>{
  wrap(<ResignationCaseCard initial={c({currency:null})} today="2026-11-16"/>);fireEvent.change(screen.getByLabelText('Basic salary (per month)'),{target:{value:'7600'}});expect(screen.getByText('6,800.00')).toBeInTheDocument();expect(screen.getByText('+800.00')).toBeInTheDocument();expect(screen.queryByText(/RM |MYR |SGD /)).not.toBeInTheDocument();expect(money('123.45',null)).toBe('123.45');expect(money(null,'SGD')).toBe('—');
 });
 it('keeps each historical offer in its own currency and does not aggregate different currencies',()=>{
  const offer={position:'Prior position',jobGrade:'G2',basicSalary:'1000.00',effectiveDate:'2026-01-01',justification:''};
  wrap(<PriorCases value={c({currency:'SGD',priorCases:[{id:'past-myr',number:'RSN-11',stage:'retained',submittedOn:'2025-01-01',closedOn:'2025-02-01',currency:'MYR',offer},{id:'past-sgd',number:'RSN-12',stage:'retained',submittedOn:'2025-04-01',closedOn:'2025-05-01',currency:'SGD',offer},{id:'past-unknown',number:'RSN-13',stage:'retained',submittedOn:'2025-07-01',closedOn:'2025-08-01',offer}]})}/>);
  const rows=screen.getAllByRole('listitem');expect(rows[0]).toHaveTextContent('MYR 1,000.00');expect(rows[1]).toHaveTextContent('SGD 1,000.00');expect(rows[2]).toHaveTextContent('1,000.00');expect(rows[2]).not.toHaveTextContent(/MYR|SGD|RM/);expect(screen.queryByText(/3,000.00/)).not.toBeInTheDocument();
 });
 it('keeps FYI view separate from decisions, requires a current comment, and preserves text on failure',async()=>{
  actions.runResignationCommand.mockResolvedValue({ok:false,error:'Stale comment',conflict:true});
  wrap(<ResignationCaseCard initial={c({capabilities:{withdraw:false,accept:false,offer:false,comment:true,retry:false}})} today="2026-11-16" fyi/>);
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();expect(screen.getByText('For your information')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Post comment'}));expect(actions.runResignationCommand).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Add a comment'),{target:{value:'Latest comment'}});fireEvent.click(screen.getByRole('button',{name:'Post comment'}));
  await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'comment',text:'Latest comment'}}));expect(screen.getByLabelText('Add a comment')).toHaveValue('Latest comment');
  expect(screen.getByRole('button',{name:'Reload case'})).toBeInTheDocument();
 });
 it('acts on an assigned general workflow approval without granting a letter decision',async()=>{
  actions.runResignationCommand.mockResolvedValue({ok:true,value:c({tasks:[],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})});
  wrap(<ResignationCaseCard initial={c({tasks:[task({kind:'approve',documentId:null,title:'Approval from configured workflow'})],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})} today="2026-11-16"/>);
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Approve and pass on'}));
  await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'approvalTask',taskId:'task-a',action:'approve'}}));
 });
 it('requires a live rejection reason for an assigned approval',async()=>{
  actions.runResignationCommand.mockResolvedValue({ok:false,error:'Keep the reason'});
  wrap(<ResignationCaseCard initial={c({tasks:[task({kind:'approve',documentId:null})],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})} today="2026-11-16"/>);
  const reject=screen.getByRole('button',{name:'Reject'});expect(reject).toBeDisabled();fireEvent.change(screen.getByLabelText('Rejection explanation (required)'),{target:{value:'The offered grade needs review'}});fireEvent.click(reject);
  await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'approvalTask',taskId:'task-a',action:'reject',comment:'The offered grade needs review'}}));expect(screen.getByLabelText('Rejection explanation (required)')).toHaveValue('The offered grade needs review');
 });
 it('saves the latest case email override and preserves its draft on refusal',async()=>{
  actions.runResignationCommand.mockResolvedValue({ok:false,error:'Retry this email'});
  wrap(<ResignationCaseCard initial={c({emails:[{id:'email-a',name:'Case email',subject:'Original',body:'Dear {employee.name}',editable:true}],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})} today="2026-11-16"/>);
  fireEvent.click(screen.getByRole('button',{name:'Edit email for this person'}));fireEvent.change(screen.getByLabelText('Subject'),{target:{value:'Updated subject'}});fireEvent.change(screen.getByLabelText('Email body'),{target:{value:'Updated {employee.name}'}});fireEvent.click(screen.getByRole('button',{name:'Save email'}));
  await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'updateEmail',emailTemplateId:'email-a',subject:'Updated subject',body:'Updated {employee.name}'}}));expect(screen.getByLabelText('Subject')).toHaveValue('Updated subject');
 });
 it('only enables the resignation category through explicit managed assignment access',()=>{
  expect(parseApprovalCategory('resignations',{admin:false})).toBe('all');expect(parseApprovalCategory('resignations',{admin:false,resignationAccess:true})).toBe('resignations');expect(parseApprovalCategory('hrReviews',{admin:false,resignationAccess:true})).toBe('all');
 });
});

describe('letter privacy and consent',()=>{
 it('requires opening, typed name and consent before accepting an offer',()=>{
  const command=vi.fn(async()=>true),view=c({stage:'offer'});const original=l();const ui=wrap(<ResignationLetterCard value={view} letter={original} busy={false} command={command}/>);
  expect(screen.getByRole('button',{name:'Sign and accept offer'})).toBeDisabled();expect(screen.getByLabelText('Type your full name as your signature')).toBeDisabled();
  ui.rerender(<NextIntlClientProvider locale="en" messages={messages}><ResignationLetterCard value={view} letter={{...original,opened:true}} busy={false} command={command}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText('Type your full name as your signature'),{target:{value:'Fictional Employee'}});expect(screen.getByRole('button',{name:'Sign and accept offer'})).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Sign and accept offer'}));expect(command).toHaveBeenCalledWith({type:'letterAction',documentId:'letter-a',documentRevision:2,action:'sign',signature:'Fictional Employee',consent:true});
 });
 it('reads the latest send-back reason and hides send back from an owner capability',()=>{
  const command=vi.fn(async()=>true),view=c();wrap(<ResignationLetterCard value={view} letter={l({opened:true})} busy={false} command={command}/>);
  fireEvent.click(screen.getByRole('button',{name:'Send back for changes'}));expect(command).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent('Enter a reason');
  fireEvent.change(screen.getByLabelText('Why does the letter need changes?'),{target:{value:'Change the latest effective date'}});fireEvent.click(screen.getByRole('button',{name:'Send back for changes'}));expect(command).toHaveBeenCalledWith({type:'sendBack',documentId:'letter-a',documentRevision:2,reason:'Change the latest effective date'});
  cleanup();wrap(<ResignationLetterCard value={view} letter={l({capabilities:{...l().capabilities,sendBack:false,sign:false,edit:true}})} busy={false} command={command}/>);expect(screen.queryByRole('button',{name:'Send back for changes'})).not.toBeInTheDocument();
 });
 it('offers regeneration only through the current backend capability and preserves the original date when refused',()=>{
  const command=vi.fn(async()=>false),letter=l({capabilities:{...l().capabilities,sign:false,sendBack:false,regenerate:true}});
  wrap(<ResignationLetterCard value={c()} letter={letter} busy={false} command={command}/>);
  expect(screen.getByText(/Generated 16-Nov-2026/)).toBeInTheDocument();expect(screen.getByText('Use the current published template and restart routing. This replaces case edits and keeps the original generated date.')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Regenerate from current template'}));expect(command).toHaveBeenCalledWith({type:'regenerateLetter',documentId:'letter-a',documentRevision:2});expect(screen.getByText(/Generated 16-Nov-2026/)).toBeInTheDocument();
  cleanup();wrap(<ResignationLetterCard value={c()} letter={l({routing:[{id:'owner',order:1,action:'Review',people:[{id:'me',name:'Me'}],owner:true,status:'pending',signedBy:null,signedAt:null}],capabilities:{...l().capabilities,regenerate:false}})} busy={false} command={command}/>);expect(screen.queryByRole('button',{name:'Regenerate from current template'})).not.toBeInTheDocument();
 });
 it('edits raw case blocks without replacing live merge tokens with displayed facts',()=>{
  const command=vi.fn(async()=>true),source=[{id:'text-a',type:'text' as const,text:'Dear {employee.name}',section:''}];
  wrap(<ResignationLetterCard value={c()} letter={l({blocks:[{...source[0],text:'Dear sampled name'}],editableBlocks:source,capabilities:{...l().capabilities,edit:true,sign:false,sendBack:false}})} busy={false} command={command}/>);
  fireEvent.click(screen.getByRole('button',{name:'Update letter'}));expect(screen.getByRole('textbox',{name:'1. Text'})).toHaveTextContent('Dear {Full name}');expect(screen.getByRole('textbox',{name:'1. Text'}).querySelector('[data-letter-field]')).toHaveAttribute('data-letter-field','employee.name');fireEvent.click(screen.getByRole('button',{name:'Save letter changes'}));expect(command).toHaveBeenCalledWith({type:'updateLetter',documentId:'letter-a',documentRevision:2,blocks:source});
 });
 it('does not render protected text when letter content is private',()=>{
  wrap(<ResignationLetterCard value={c()} letter={l({private:true,blocks:[{id:'secret',type:'text',text:'Private proposed terms',section:''}],capabilities:{...l().capabilities,open:false,sign:false,sendBack:false}})} busy={false} command={vi.fn(async()=>true)}/>);
  expect(screen.queryByText('Private proposed terms')).not.toBeInTheDocument();expect(screen.getByText('The letter is private until it reaches you.')).toBeInTheDocument();
 });
});

describe('task rows and block editing',()=>{
 it('counts personal, claimed team, tagged and overdue items independently',()=>{
  expect(resignationTaskInFilter(task(),'assigned','me')).toBe(true);expect(resignationTaskInFilter(task({team:true}),'assigned','me')).toBe(false);expect(resignationTaskInFilter(task({team:true,onIt:{id:'me',name:'Me'}}),'assigned','me')).toBe(true);expect(resignationTaskInFilter(task({team:true,onIt:{id:'other',name:'Other'}}),'assigned','me')).toBe(false);expect(resignationTaskInFilter(task({tagged:true}),'tagged')).toBe(true);expect(resignationTaskInFilter(task({overdue:true}),'overdue')).toBe(true);
 });
 it('opens a labelled side panel and dismisses it through Escape/cancel',()=>{
  const close=vi.fn();wrap(<ResignationTaskPanel task={task()} initial={c()} today="2026-11-16" close={close} complete={vi.fn()}/>);
  const panel=screen.getByRole('dialog',{name:'Sign fictional retention letter'});expect(panel).toHaveAttribute('open');fireEvent(panel,new Event('cancel',{bubbles:false,cancelable:true}));expect(close).toHaveBeenCalledOnce();
 });
 it('maps decision repair to the shared task list and permits only the explicit current-workflow repair command',async()=>{
  const complete=vi.fn(),repair=task({kind:'repair',documentId:null,title:'Assign a resignation decision maker'}),value=c({tasks:[repair],deciders:[],blocked:['Nobody is assigned to record the decision.'],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false,runAgain:true}});
  const rows=wrap(<ResignationTaskRows items={[repair]} filter="all" today="2026-11-16"/>);expect(screen.getByRole('button',{name:'Open workflow repair'})).toBeInTheDocument();rows.unmount();
  actions.runResignationCommand.mockResolvedValueOnce({ok:false,error:'The configuration still needs attention.'}).mockResolvedValueOnce({ok:true,value:{...value,revision:8,tasks:[],blocked:[],deciders:[{id:'manager',name:'Assigned manager'}],capabilities:{...value.capabilities,runAgain:false}}});
  wrap(<ResignationTaskPanel task={repair} initial={value} today="2026-11-16" close={vi.fn()} complete={complete}/>);fireEvent.click(screen.getByRole('button',{name:'Run workflows again'}));await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'runWorkflowsAgain'}}));expect(await screen.findByRole('alert')).toHaveTextContent('The configuration still needs attention.');expect(screen.getByText('Closer to home')).toBeInTheDocument();expect(complete).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'Retry failed workflows'})).not.toBeInTheDocument();
  const run=await screen.findByRole('button',{name:'Run workflows again'});await waitFor(()=>expect(run).toBeEnabled());fireEvent.click(run);await waitFor(()=>expect(complete).toHaveBeenCalledOnce());expect(actions.runResignationCommand).toHaveBeenCalledTimes(2);expect(actions.runResignationCommand.mock.calls.every(([input])=>input.command.type==='runWorkflowsAgain')).toBe(true);
 });
 it('does not mark repair complete when running current workflows leaves a new unassigned repair task',async()=>{
  const complete=vi.fn(),repair=task({kind:'repair',documentId:null,title:'Repair decision setup'}),value=c({deciders:[],tasks:[repair],blocked:['No decision maker yet.'],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false,runAgain:true}});
  actions.runResignationCommand.mockResolvedValue({ok:true,value:{...value,revision:8,tasks:[{...repair,id:'repair-again',revision:8}],blocked:['Still no decision maker after running the current definitions.']}});
  wrap(<ResignationTaskPanel task={repair} initial={value} today="2026-11-16" close={vi.fn()} complete={complete}/>);fireEvent.click(screen.getByRole('button',{name:'Run workflows again'}));expect(await screen.findByText('Still no decision maker after running the current definitions.')).toBeInTheDocument();expect(complete).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'Repair decision setup'})).toBeInTheDocument();const run=screen.getByRole('button',{name:'Run workflows again'});await waitFor(()=>expect(run).toBeEnabled());fireEvent.click(run);await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenLastCalledWith({caseId:'case-a',revision:8,command:{type:'runWorkflowsAgain'}}));
 });
 it('does not grant the repair command from a repair task kind when the backend capability is absent',()=>{
  const repair=task({kind:'repair',documentId:null,actionable:false,title:'Review decision setup'});wrap(<ResignationTaskPanel task={repair} initial={c({tasks:[repair],deciders:[],blocked:['Decision workflow needs attention.'],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false,runAgain:false}})} today="2026-11-16" close={vi.fn()} complete={vi.fn()}/>);expect(screen.getByText('This case needs a decision maker. Review the recorded setup issue below; run the workflows again when the configuration is ready.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Run workflows again'})).not.toBeInTheDocument();expect(actions.runResignationCommand).not.toHaveBeenCalled();
 });
 it('keeps pinned failed-run retry separate from running current definitions again',()=>{
  actions.runResignationCommand.mockResolvedValue({ok:false,error:'Pinned run still needs attention.'});wrap(<ResignationCaseCard initial={c({blocked:['A pinned workflow failed.'],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:true,runAgain:false}})} today="2026-11-16"/>);expect(screen.queryByRole('button',{name:'Run workflows again'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Retry failed workflows'}));expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'retry'}});
 });
 it('records a permitted recruitment handoff and closes a completed task',async()=>{
  const complete=vi.fn(),item=task({kind:'recruitment',documentId:null,title:'Arrange replacement recruitment'}),value=c({tasks:[item],replacementRequest:{id:'replacement-a',status:'requested',requestedOn:'2026-11-16',reference:null,completedOn:null},capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}});
  actions.runResignationCommand.mockResolvedValue({ok:true,value:{...value,tasks:[],replacementRequest:{...value.replacementRequest!,status:'completed',reference:'https://recruitment.example.test/request/42',completedOn:'2026-11-17'}}});
  wrap(<ResignationTaskPanel task={item} initial={value} today="2026-11-16" close={vi.fn()} complete={complete}/>);
  expect(screen.getByRole('button',{name:'Record recruitment handoff'})).toBeDisabled();fireEvent.change(screen.getByLabelText('Recruitment reference URL'),{target:{value:'https://recruitment.example.test/request/42'}});fireEvent.submit(screen.getByRole('button',{name:'Record recruitment handoff'}).closest('form')!);
  await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'completeReplacement',taskId:'task-a',reference:'https://recruitment.example.test/request/42'}}));await waitFor(()=>expect(complete).toHaveBeenCalledOnce());
 });
 it('edits table cells and rows while leaving letterhead and signatures protected',async()=>{
  const change=vi.fn();wrap(<ResignationBlockEditor busy={false} onChange={change} blocks={[{id:'head',type:'letterhead',text:'',section:''},{id:'table',type:'table',text:'',section:'',columns:'Term | Offered',rows:'Grade | G4'},{id:'sig',type:'signature',text:'',section:''}]}/>);
  expect(screen.getAllByText(/This block is supplied/)).toHaveLength(2);fireEvent.focus(await screen.findByRole('textbox',{name:'Offered, Row 1'}));await waitFor(()=>expect(screen.getByRole('textbox',{name:'Offered, Row 1'})).toHaveAttribute('contenteditable','true'));fireEvent.paste(screen.getByRole('textbox',{name:'Offered, Row 1'}),{clipboardData:{getData:()=> 'Revised '}});await waitFor(()=>expect(change.mock.calls[0][0][1].rows).toBe('Grade | G4Revised '));fireEvent.click(screen.getByRole('button',{name:'Add row'}));expect(change.mock.calls[1][0][1].rows).toBe('Grade | G4\n | ');
 });
});

describe('shared acceptance letters in existing Offboarding Documents',()=>{
 const projection=(letter:ResignationLetterView)=>({caseId:'case-a',revision:7,caseNumber:'RSN-42',employeeName:'Fictional Employee',offboardingCaseId:'offboarding-a',letters:[letter]});
 it('loads one authorized projection, opens the shared signed acceptance document and keeps journey facts out of the case panel',async()=>{
  const letter=l({kind:'acceptance',name:'Shared acceptance letter',state:'released',downloadUrl:'/resignation/case-a/documents/letter-a?offboardingCaseId=offboarding-a',capabilities:{...l().capabilities,sign:false,sendBack:false,regenerate:false},document:{id:'letter-a',templateId:'template-a',version:1,name:'Shared acceptance letter',status:'signed',blocks:[{id:'text-a',type:'text',text:'Frozen acceptance document text',section:''}],fields:[],values:{},edits:{},hrSignature:null,employeeSignature:null,createdAt:'2026-11-16T00:00:00Z',sentAt:null}});
  actions.loadResignationOffboarding.mockResolvedValue({ok:true,value:projection(letter)});wrap(<ResignationOffboardingDocuments offboardingCaseId="offboarding-a"/>);
  expect(screen.getByRole('status')).toHaveTextContent('Loading resignation');await screen.findByRole('heading',{name:'Shared acceptance letter'});expect(actions.loadResignationOffboarding).toHaveBeenCalledWith('offboarding-a');expect(screen.getByText('Signed and released')).toBeInTheDocument();expect(screen.getByRole('link',{name:'Download signed PDF'})).toHaveAttribute('href','/resignation/case-a/documents/letter-a?offboardingCaseId=offboarding-a');
  expect(screen.queryByText('Fictional Employee')).not.toBeInTheDocument();expect(screen.queryByText('Closer to home')).not.toBeInTheDocument();expect(screen.queryByRole('radio')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Regenerate from current template'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Open letter'}));expect(screen.getByText('Frozen acceptance document text')).toBeInTheDocument();expect(actions.runResignationCommand).not.toHaveBeenCalled();
 });
 it('sends the actual journey and document revisions for permitted regeneration, keeps errors visible, and reloads through the narrow adapter',async()=>{
  const letter=l({kind:'acceptance',name:'Waiting acceptance letter',capabilities:{...l().capabilities,sign:false,sendBack:false,regenerate:true}});actions.loadResignationOffboarding.mockResolvedValue({ok:true,value:projection(letter)});actions.runResignationCommand.mockResolvedValue({ok:false,error:'This shared letter changed.',conflict:true});wrap(<ResignationOffboardingDocuments offboardingCaseId="offboarding-a"/>);
  fireEvent.click(await screen.findByRole('button',{name:'Regenerate from current template'}));await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'regenerateLetter',documentId:'letter-a',documentRevision:2}}));expect(await screen.findByRole('alert')).toHaveTextContent('This shared letter changed.');fireEvent.click(screen.getByRole('button',{name:'Reload case'}));await waitFor(()=>expect(actions.loadResignationOffboarding).toHaveBeenCalledTimes(2));await screen.findByRole('heading',{name:'Waiting acceptance letter'});
 });
 it('renders no linked section for a legacy case with no managed source',async()=>{
  actions.loadResignationOffboarding.mockResolvedValue({ok:true,value:null});const view=wrap(<ResignationOffboardingDocuments offboardingCaseId="legacy-offboarding"/>);await waitFor(()=>expect(view.container).toBeEmptyDOMElement());
 });
});


it('shows only the server-authorized current holder when a letter is private',()=>{
 const letter=l({private:true,waitingOn:[{id:'safe-holder',name:'Fictional current reviewer'}],routing:[{id:'future-secret',order:3,action:'Sign',people:[{id:'secret-person',name:'Future private signer'}],owner:false,status:'waiting',signedBy:null,signedAt:null}],blocks:[{id:'secret',type:'text',text:'Private offer salary 99999',section:''}],capabilities:{...l().capabilities,open:false,sign:false,sendBack:false}});
 wrap(<ResignationLetterCard value={c({stage:'retention'})} letter={letter} busy={false} command={vi.fn(async()=>true)}/>);
 expect(screen.getByText('Waiting for Fictional current reviewer')).toBeInTheDocument();expect(screen.queryByText('Future private signer')).not.toBeInTheDocument();expect(screen.queryByText('Private offer salary 99999')).not.toBeInTheDocument();expect(screen.queryByRole('list')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Open letter'})).not.toBeInTheDocument();
});


function letterFieldDocument():Document{
 const field=(id:string,label:string,owner:Field['owner'],pmKey:string|null=null):Field=>({id,label,owner,pmKey,type:'text',required:true,sensitive:false,options:[],section:'details',when:null});
 return{id:'letter-a',templateId:'template-a',version:1,name:'Fictional form letter',status:'opened',blocks:[{id:'details',type:'fields',text:'',section:'details'}],fields:[field('employee-note','Employee response','employee'),field('hr-note','HR review note','hr'),field('registered-name','Registered name','pmLocked','employee.name'),field('mapped-job','Mapped job','hr','employee.position')],values:{'employee-note':'Recorded response','hr-note':'Recorded review','registered-name':'Fictional Employee','mapped-job':'Analyst'},mergeValues:{},edits:{},hrSignature:null,employeeSignature:null,createdAt:'2026-11-16T00:00:00Z',sentAt:null};
}
it('saves only authorized document fields and keeps the draft and native refusal visible before signing',async()=>{
 actions.runResignationCommand.mockResolvedValue({ok:false,error:'Choose a valid field value.'});
 const letter=l({document:letterFieldDocument(),opened:true,editableFieldIds:['employee-note'],capabilities:{...l().capabilities,sendBack:false}});
 wrap(<ResignationCaseCard initial={c({stage:'offer',letters:[letter],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})} today="2026-11-16"/>);
 fireEvent.click(screen.getByRole('button',{name:'Open letter'}));expect(screen.getByLabelText('Employee response *')).toBeEnabled();expect(screen.getByLabelText('HR review note *')).toBeDisabled();expect(screen.getByLabelText(/Registered name/)).toBeDisabled();expect(screen.getByLabelText('Mapped job *')).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Type your full name as your signature'),{target:{value:'Fictional Employee'}});fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByRole('button',{name:'Sign and accept offer'})).toBeEnabled();
 fireEvent.change(screen.getByLabelText('Employee response *'),{target:{value:'My unsaved response'}});expect(screen.getByRole('button',{name:'Sign and accept offer'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Save form fields'}));
 await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'saveLetterFields',documentId:'letter-a',documentRevision:2,values:{'employee-note':'My unsaved response'}}}));expect(await screen.findByRole('alert')).toHaveTextContent('Choose a valid field value.');expect(screen.getByLabelText('Employee response *')).toHaveValue('My unsaved response');expect(actions.runResignationCommand.mock.calls.some(([input])=>input.command.type==='letterAction')).toBe(false);
});
it.each(['review','approve'] as const)('allows an incomplete authorized field draft but blocks %s until saved',action=>{
 const command=vi.fn(async()=>false),letter=l({document:letterFieldDocument(),opened:true,editableFieldIds:['hr-note'],capabilities:{...l().capabilities,sign:false,sendBack:false,review:action==='review',approve:action==='approve'}});
 wrap(<ResignationLetterCard value={c()} letter={letter} busy={false} command={command}/>);fireEvent.click(screen.getByRole('button',{name:'Open letter'}));fireEvent.change(screen.getByLabelText('HR review note *'),{target:{value:''}});
 expect(screen.getByRole('button',{name:messages.resignationJourney[action]})).toBeDisabled();expect(screen.getByRole('button',{name:'Save form fields'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'Save form fields'}));expect(command).toHaveBeenCalledWith({type:'saveLetterFields',documentId:'letter-a',documentRevision:2,values:{'hr-note':''}});expect(screen.getByLabelText('Employee response *')).toBeDisabled();
});
it('preserves existing owner-based document editing and never enables mapped Personnel fields through an explicit scope',()=>{
 const document=letterFieldDocument(),rendered=wrap(<DocumentBody document={document} editableBy="hr" change={vi.fn()}/>);expect(screen.getByLabelText('HR review note *')).toBeEnabled();expect(screen.getByLabelText('Employee response *')).toBeDisabled();
 rendered.rerender(<NextIntlClientProvider locale="en" messages={messages}><DocumentBody document={document} editableBy="hr" editableFieldIds={['employee-note','registered-name','mapped-job']} change={vi.fn()}/></NextIntlClientProvider>);expect(screen.getByLabelText('Employee response *')).toBeEnabled();expect(screen.getByLabelText('HR review note *')).toBeDisabled();expect(screen.getByLabelText(/Registered name/)).toBeDisabled();expect(screen.getByLabelText('Mapped job *')).toBeDisabled();
});


it('preserves an unsaved letter field across unrelated serialized DTO refreshes and resets on a real letter revision',async()=>{
 const command=vi.fn(async()=>false),document=letterFieldDocument(),letter=l({document,opened:true,editableFieldIds:['employee-note'],capabilities:{...l().capabilities,sign:false,sendBack:false}});
 const ui=wrap(<ResignationLetterCard value={c()} letter={letter} busy={false} command={command}/>);fireEvent.click(screen.getByRole('button',{name:'Open letter'}));fireEvent.change(screen.getByLabelText('Employee response *'),{target:{value:'Keep my local response'}});
 ui.rerender(<NextIntlClientProvider locale="en" messages={messages}><ResignationLetterCard value={c({revision:8})} letter={{...letter,document:JSON.parse(JSON.stringify(document))}} busy={false} command={command}/></NextIntlClientProvider>);expect(screen.getByLabelText('Employee response *')).toHaveValue('Keep my local response');expect(screen.getByRole('button',{name:'Save form fields'})).toBeEnabled();
 ui.rerender(<NextIntlClientProvider locale="en" messages={messages}><ResignationLetterCard value={c({revision:9})} letter={{...letter,revision:3,document:{...document,values:{...document.values,'employee-note':'Latest canonical response'}}}} busy={false} command={command}/></NextIntlClientProvider>);await waitFor(()=>expect(screen.getByLabelText('Employee response *')).toHaveValue('Latest canonical response'));expect(screen.getByRole('button',{name:'Save form fields'})).toBeDisabled();
});
it('sends only changed prospectively visible field values and drops a dirty child hidden by its parent',()=>{
 const document=letterFieldDocument();document.fields=[{...document.fields[0],id:'answer',label:'More details?',type:'select',options:['Yes','No']},{...document.fields[0],id:'details',label:'Details',when:{field:'answer',value:'Yes'}}];document.values={answer:'Yes',details:'Recorded details'};
 const command=vi.fn(async()=>false),letter=l({document,opened:true,editableFieldIds:['answer','details'],capabilities:{...l().capabilities,sign:false,sendBack:false}});wrap(<ResignationLetterCard value={c()} letter={letter} busy={false} command={command}/>);fireEvent.click(screen.getByRole('button',{name:'Open letter'}));fireEvent.change(screen.getByLabelText('Details *'),{target:{value:'Dirty child that is now hidden'}});fireEvent.change(screen.getByLabelText('More details? *'),{target:{value:'No'}});expect(screen.queryByLabelText('Details *')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Save form fields'}));expect(command).toHaveBeenCalledWith({type:'saveLetterFields',documentId:'letter-a',documentRevision:2,values:{answer:'No'}});
});
it('keeps a newly visible conditional field read-only until the server provides its authorized scope',()=>{
 const document=letterFieldDocument();document.fields=[{...document.fields[0],id:'answer',label:'More details?',type:'select',options:['Yes','No']},{...document.fields[0],id:'details',label:'Details',when:{field:'answer',value:'Yes'}}];document.values={answer:'No',details:''};const command=vi.fn(async()=>false),letter=l({document,opened:true,editableFieldIds:['answer'],capabilities:{...l().capabilities,sign:false,sendBack:false}});wrap(<ResignationLetterCard value={c()} letter={letter} busy={false} command={command}/>);fireEvent.click(screen.getByRole('button',{name:'Open letter'}));fireEvent.change(screen.getByLabelText('More details? *'),{target:{value:'Yes'}});expect(screen.getByLabelText('Details *')).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Save form fields'}));expect(command).toHaveBeenCalledWith({type:'saveLetterFields',documentId:'letter-a',documentRevision:2,values:{answer:'Yes'}});
});


it('loads owner case communications only when an existing letter capability admits the case surface',async()=>{
 wrap(<ResignationCaseCard initial={c({letters:[l({private:true,capabilities:{...l().capabilities,open:false,sign:false,sendBack:false}})]})} today="2026-11-16"/>);expect(actions.loadResignationCommunications).not.toHaveBeenCalled();
 cleanup();wrap(<ResignationCaseCard initial={c({letters:[l({capabilities:{...l().capabilities,open:true,sign:false,sendBack:false}})]})} today="2026-11-16"/>);expect(await screen.findByRole('heading',{name:'Case communications'})).toBeInTheDocument();expect(actions.loadResignationCommunications).toHaveBeenCalledWith({caseId:'case-a',offboardingCaseId:undefined});
});

it('refreshes managed acceptance documents on a sibling source change and emits one source refresh after a successful command',async()=>{
 const letter=l({kind:'acceptance',capabilities:{...l().capabilities,sign:false,sendBack:false,regenerate:true}}),first={caseId:'case-a',caseNumber:'RSN-42',revision:7,letters:[letter]},next={...first,revision:8,letters:[{...letter,revision:3}]},changed=vi.fn();
 actions.loadResignationOffboarding.mockResolvedValueOnce({ok:true,value:first}).mockResolvedValueOnce({ok:true,value:next});actions.runResignationCommand.mockResolvedValue({ok:true,value:c({revision:8,letters:next.letters})});
 const ui=wrap(<ResignationOffboardingDocuments offboardingCaseId="offboarding-a" refreshKey={1} onChanged={changed}/>);fireEvent.click(await screen.findByRole('button',{name:'Regenerate from current template'}));await waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));
 ui.rerender(<NextIntlClientProvider locale="en" messages={messages}><ResignationOffboardingDocuments offboardingCaseId="offboarding-a" refreshKey={2} onChanged={changed}/></NextIntlClientProvider>);await waitFor(()=>expect(actions.loadResignationOffboarding).toHaveBeenCalledTimes(2));await screen.findByText(/Version 3 · template version 1/);expect(changed).toHaveBeenCalledTimes(1);
});


describe('inline letter review and final signing labels',()=>{
 it('saves canonical case edits in the single Review command, preserves refused drafts and protects the template structure',async()=>{
  const source=[{id:'head',type:'letterhead' as const,text:'',section:''},{id:'body',type:'text' as const,text:'Dear {employee.name}',section:''},{id:'sig',type:'signature' as const,text:'',section:'',role:'step:bp'}];
  const command=vi.fn(async()=>false),letter=l({kind:'acceptance',editableBlocks:source,capabilities:{...l().capabilities,review:true,edit:true,sign:false,sendBack:false}}),value=c();
  const ui=wrap(<ResignationLetterCard value={value} letter={letter} busy={false} command={command}/>);fireEvent.click(screen.getByRole('button',{name:'Update letter'}));
  fireEvent.focus(await screen.findByRole('textbox',{name:'2. Text'}));await waitFor(()=>expect(screen.getByRole('textbox',{name:'2. Text'})).toHaveAttribute('contenteditable','true'));const body=screen.getByRole('textbox',{name:'2. Text'});expect(body.querySelector('[data-letter-field]')).toHaveAttribute('contenteditable','false');
  expect(screen.queryByRole('button',{name:'Save letter changes'})).not.toBeInTheDocument();fireEvent.paste(body,{clipboardData:{getData:()=> 'Reviewed '}});await waitFor(()=>expect(screen.getByText('Your letter edits will be saved when you complete Review.')).toBeInTheDocument());
  ui.rerender(<NextIntlClientProvider locale="en" messages={messages}><ResignationLetterCard value={{...value,revision:8}} letter={JSON.parse(JSON.stringify(letter))} busy={false} command={command}/></NextIntlClientProvider>);
  expect(screen.getByRole('textbox',{name:'2. Text'})).toHaveTextContent('Dear {Full name}Reviewed');fireEvent.click(screen.getByRole('button',{name:'Review'}));
  await waitFor(()=>expect(command).toHaveBeenCalledOnce());expect(command).toHaveBeenCalledWith({type:'letterAction',documentId:'letter-a',documentRevision:2,action:'review',blocks:[source[0],{...source[1],text:'Dear {employee.name}Reviewed '},source[2]]});
  expect(screen.getByRole('textbox',{name:'2. Text'})).toHaveTextContent('Dear {Full name}Reviewed');expect(source[1].text).toBe('Dear {employee.name}');
 });
 it('keeps returned-owner Save separate from Resend while letter edits are unsaved',async()=>{
  const source=[{id:'body',type:'text' as const,text:'Dear {employee.name}',section:''}],command=vi.fn(async()=>false);
  wrap(<ResignationLetterCard value={c()} letter={l({state:'owner',editableBlocks:source,capabilities:{...l().capabilities,edit:true,resend:true,sign:false,sendBack:false}})} busy={false} command={command}/>);
  fireEvent.click(screen.getByRole('button',{name:'Update letter'}));fireEvent.focus(await screen.findByRole('textbox',{name:'1. Text'}));await waitFor(()=>expect(screen.getByRole('textbox',{name:'1. Text'})).toHaveAttribute('contenteditable','true'));fireEvent.paste(screen.getByRole('textbox',{name:'1. Text'}),{clipboardData:{getData:()=> 'Corrected '}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Send round again'})).toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'Save letter changes'}));
  expect(command).toHaveBeenCalledWith({type:'updateLetter',documentId:'letter-a',documentRevision:2,blocks:[{...source[0],text:'Dear {employee.name}Corrected '}]});
 });
 it.each([[false,'Sign letter'],[true,'Sign and release letter']] as const)('uses the canonical final-sign capability %s for acceptance letters',(releaseOnSign,label)=>{
  wrap(<ResignationLetterCard value={c()} letter={l({kind:'acceptance',opened:true,capabilities:{...l().capabilities,releaseOnSign}})} busy={false} command={vi.fn(async()=>true)}/>);
  expect(screen.getByRole('button',{name:label,exact:true})).toBeInTheDocument();
 });
 it('keeps retention employee consent and acceptance distinct even if a malformed DTO supplies a release label flag',()=>{
  wrap(<ResignationLetterCard value={c({stage:'offer'})} letter={l({opened:true,capabilities:{...l().capabilities,releaseOnSign:true}})} busy={false} command={vi.fn(async()=>true)}/>);
  expect(screen.getByRole('button',{name:'Sign and accept offer'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Sign and release letter'})).not.toBeInTheDocument();
 });
});

it('keeps an invalid local editor draft and blocks Review until that actual draft is corrected',async()=>{
 const source=[{id:'body',type:'text' as const,text:'Saved canonical wording',section:''}],command=vi.fn(async()=>true);
 wrap(<ResignationLetterCard value={c()} letter={l({editableBlocks:source,capabilities:{...l().capabilities,review:true,edit:true,sign:false,sendBack:false}})} busy={false} command={command}/>);
 fireEvent.click(screen.getByRole('button',{name:'Update letter'}));fireEvent.focus(screen.getByRole('textbox',{name:'1. Text'}));await waitFor(()=>expect(screen.getByRole('textbox',{name:'1. Text'})).toHaveAttribute('contenteditable','true'));
 const getEditor=()=>(screen.getByRole('textbox',{name:'1. Text'}) as HTMLElement&{editor:Editor}).editor;
 act(()=>{getEditor().commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Unsaved first paragraph'}]},{type:'paragraph',content:[{type:'text',text:'Unsaved second paragraph'}]}]});});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Review'})).toBeDisabled());expect(screen.getByRole('alert')).toHaveTextContent('Use plain text and merge fields only.');expect(command).not.toHaveBeenCalled();
 screen.getByRole('button',{name:'Open letter'}).focus();await waitFor(()=>expect(screen.getByRole('textbox',{name:'1. Text'})).not.toHaveAttribute('contenteditable','true'));
 expect(screen.getByRole('textbox',{name:'1. Text'})).toHaveTextContent('Unsaved second paragraph');expect(screen.getByRole('button',{name:'Review'})).toBeDisabled();
 screen.getByRole('textbox',{name:'1. Text'}).focus();await waitFor(()=>expect(screen.getByRole('textbox',{name:'1. Text'})).toHaveAttribute('contenteditable','true'));expect(getEditor().getJSON().content).toHaveLength(2);expect(screen.getByRole('button',{name:'Review'})).toBeDisabled();
 act(()=>{getEditor().commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Corrected local wording'}]}]});});await waitFor(()=>expect(screen.getByRole('button',{name:'Review'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Review'}));expect(command).toHaveBeenCalledWith({type:'letterAction',documentId:'letter-a',documentRevision:2,action:'review',blocks:[{...source[0],text:'Corrected local wording'}]});
});

it('preserves a blank single-column row through add, fill and clear, and removes only the selected row',async()=>{
 const changes:Block[][]=[];
 function Table(){const[blocks,setBlocks]=useState<Block[]>([{id:'one-column',type:'table',text:'',section:'',columns:'Term',rows:''}]);return <ResignationBlockEditor busy={false} blocks={blocks} onChange={next=>{changes.push(next);setBlocks(next);}}/>;}
 wrap(<Table/>);expect(screen.queryByRole('textbox',{name:'Term, Row 1'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Add row'}));
 expect(changes.at(-1)?.[0].rows).toBe(' ');expect(screen.getAllByRole('button',{name:/Remove row/})).toHaveLength(1);
 screen.getByRole('textbox',{name:'Term, Row 1'}).focus();await waitFor(()=>expect(screen.getByRole('textbox',{name:'Term, Row 1'})).toHaveAttribute('contenteditable','true'));
 const editor=(screen.getByRole('textbox',{name:'Term, Row 1'}) as HTMLElement&{editor:Editor}).editor;
 act(()=>{editor.commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'First term'}]}]});});await waitFor(()=>expect(changes.at(-1)?.[0].rows).toBe('First term'));
 act(()=>{editor.commands.setContent({type:'doc',content:[{type:'paragraph',content:[]}]});});await waitFor(()=>expect(changes.at(-1)?.[0].rows).toBe(' '));expect(screen.getAllByRole('button',{name:/Remove row/})).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'Add row'}));expect(changes.at(-1)?.[0].rows).toBe(' \n ');expect(screen.getByRole('textbox',{name:'Term, Row 2'})).toBeInTheDocument();
 screen.getByRole('textbox',{name:'Term, Row 2'}).focus();await waitFor(()=>expect(screen.getByRole('textbox',{name:'Term, Row 2'})).toHaveAttribute('contenteditable','true'));
 act(()=>{(screen.getByRole('textbox',{name:'Term, Row 2'}) as HTMLElement&{editor:Editor}).editor.commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Keep this term'}]}]});});await waitFor(()=>expect(changes.at(-1)?.[0].rows).toBe(' \nKeep this term'));
 fireEvent.click(screen.getByRole('button',{name:'Remove row 1'}));expect(changes.at(-1)?.[0].rows).toBe('Keep this term');expect(screen.getByRole('textbox',{name:'Term, Row 1'})).toHaveTextContent('Keep this term');expect(screen.queryByRole('textbox',{name:'Term, Row 2'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Remove row 1'}));expect(changes.at(-1)?.[0].rows).toBe('');expect(screen.queryByRole('button',{name:/Remove row/})).not.toBeInTheDocument();
});
it('does not offer a stale wording or correction save after the native capabilities are removed',()=>{
 const command=vi.fn(async()=>true),source=[{id:'body',type:'text' as const,text:'Canonical wording',section:''}],letter=l({editableBlocks:source,capabilities:{...l().capabilities,edit:true,sign:false,sendBack:false}}),ui=wrap(<ResignationLetterCard value={c()} letter={letter} busy={false} command={command}/>);
 fireEvent.click(screen.getByRole('button',{name:'Update letter'}));expect(screen.getByRole('button',{name:'Save letter changes'})).toBeInTheDocument();
 ui.rerender(<NextIntlClientProvider locale="en" messages={messages}><ResignationLetterCard value={c()} letter={{...letter,capabilities:{...letter.capabilities,edit:false,correct:false}}} busy={false} command={command}/></NextIntlClientProvider>);expect(screen.queryByRole('button',{name:'Save letter changes'})).not.toBeInTheDocument();expect(command).not.toHaveBeenCalled();
 cleanup();const correcting=l({capabilities:{...l().capabilities,correct:true,sign:false,sendBack:false}}),details=wrap(<ResignationLetterCard value={c()} letter={correcting} busy={false} command={command}/>);fireEvent.click(screen.getByRole('button',{name:'Correct the details on the case'}));expect(screen.getByRole('button',{name:'Save letter changes'})).toBeInTheDocument();
 details.rerender(<NextIntlClientProvider locale="en" messages={messages}><ResignationLetterCard value={c()} letter={{...correcting,capabilities:{...correcting.capabilities,correct:false}}} busy={false} command={command}/></NextIntlClientProvider>);expect(screen.queryByRole('button',{name:'Save letter changes'})).not.toBeInTheDocument();expect(command).not.toHaveBeenCalled();
});
