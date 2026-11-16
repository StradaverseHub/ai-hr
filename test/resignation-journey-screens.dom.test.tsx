import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import type {ReactNode} from 'react';
import messages from '../messages/en.json';
import type {ResignationCaseView,ResignationLetterView,ResignationTaskView} from '../lib/resignation-journey';
import {EmployeeResignation} from '../components/resignation/employee';
import {ResignationCaseCard} from '../components/resignation/case-card';
import {ResignationLetterCard} from '../components/resignation/letter-card';
import {ResignationOffboardingDocuments} from '../components/resignation/offboarding-documents';
import {ResignationBlockEditor} from '../components/resignation/block-editor';
import {offerDifference} from '../components/resignation/common';
import {resignationTaskInFilter} from '../components/resignation/task-rows';
import {ResignationTaskPanel} from '../components/resignation/task-panel';
import {parseApprovalCategory} from '../lib/approvals-categories';
const actions=vi.hoisted(()=>({runResignationCommand:vi.fn(),reloadResignationCase:vi.fn(),submitOwnResignation:vi.fn(),uploadOwnResignationFile:vi.fn(),loadResignationOffboarding:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/resignation/actions',()=>actions);
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:actions.refresh})}));
const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>{node}</NextIntlClientProvider>);
const c=(patch:Partial<ResignationCaseView>={}):ResignationCaseView=>({id:'case-a',number:'RSN-42',revision:7,employmentId:'employment-a',employeeName:'Fictional Employee',employeeCode:'F42',companyId:'company-a',companyName:'Fictional Company',businessGroup:'Fictional Group',department:'Finance',position:'Analyst',jobGrade:'G3',currentBasicSalary:'6800.00',stage:'decision',submittedOn:'2026-11-16',lastWorkingDay:'2026-12-16',reason:'Closer to home',noticeLabel:'1 month',earliestLastDay:'2026-12-16',offer:null,offerReplyBy:null,offerRemindOn:null,offerBlock:null,offboardingCaseId:null,replacementNeeded:null,replacementRequest:null,deciders:[{id:'manager',name:'Fictional Manager'}],keptInLoop:[{id:'bp',name:'Fictional BP'}],decisionDueOn:'2026-11-19',comments:[],priorCases:[],attachments:[],letters:[],emails:[],tasks:[],blocked:[],capabilities:{withdraw:false,accept:true,offer:true,comment:false,retry:false},...patch});
const l=(patch:Partial<ResignationLetterView>={}):ResignationLetterView=>({id:'letter-a',kind:'retention',name:'Fictional retention letter',revision:2,templateVersion:1,generatedOn:'2026-11-16',state:'review',private:false,blocks:[],editableBlocks:null,mergeValues:{},routing:[],sentBack:null,changes:[],downloadUrl:null,opened:false,document:null,capabilities:{open:true,review:false,approve:false,sign:true,sendBack:true,recall:false,edit:false,correct:false,resend:false,withdrawOffer:false,regenerate:false},...patch});
const task=(patch:Partial<ResignationTaskView>={}):ResignationTaskView=>({id:'task-a',caseId:'case-a',caseNumber:'RSN-42',revision:7,employeeName:'Fictional Employee',employeeCode:'F42',title:'Sign fictional retention letter',kind:'sign',documentId:'letter-a',dueOn:null,overdue:false,team:false,tagged:false,status:'todo',onIt:null,canComment:false,actionable:true,uploadLabel:null,...patch});
afterEach(()=>{cleanup();vi.clearAllMocks();});
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});

describe('employee resignation journey',()=>{
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
 it('explains why submission is unavailable when no decision workflow is configured',()=>{
  wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:'Ask HR to configure the resignation decision workflow.',canSubmit:false,cases:[]}}/>);
  expect(screen.getByText('Ask HR to configure the resignation decision workflow.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Submit resignation'})).not.toBeInTheDocument();
 });
 it('allows a new case after retention without deleting earlier history',()=>{
  wrap(<EmployeeResignation employmentId="employment-a" initial={{today:'2026-11-16',earliestLastDay:'2026-12-16',noticeLabel:'1 month',unavailableReason:null,canSubmit:true,cases:[c({stage:'retained',capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}})]}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Submit a new resignation'}));expect(screen.getByRole('button',{name:'Submit resignation'})).toBeInTheDocument();
 });
});

describe('manager decision and BP information',()=>{
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
  fireEvent.change(screen.getByLabelText('Basic salary (RM / month)'),{target:{value:'7600'}});
  expect(screen.getByText('+RM 800.00')).toBeInTheDocument();expect(screen.getByText('+11.8%')).toBeInTheDocument();expect(screen.queryByText(/allowance/i)).not.toBeInTheDocument();
  expect(offerDifference('100.01','100.02')).toEqual({monthly:'+RM 0.01',percent:'+0.0%'});
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
  fireEvent.click(screen.getByRole('button',{name:'Update letter'}));expect(screen.getByLabelText('1. Text')).toHaveValue('Dear {employee.name}');fireEvent.click(screen.getByRole('button',{name:'Save letter changes'}));expect(command).toHaveBeenCalledWith({type:'updateLetter',documentId:'letter-a',documentRevision:2,blocks:source});
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
 it('records a permitted recruitment handoff and closes a completed task',async()=>{
  const complete=vi.fn(),item=task({kind:'recruitment',documentId:null,title:'Arrange replacement recruitment'}),value=c({tasks:[item],replacementRequest:{id:'replacement-a',status:'requested',requestedOn:'2026-11-16',reference:null,completedOn:null},capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false}});
  actions.runResignationCommand.mockResolvedValue({ok:true,value:{...value,tasks:[],replacementRequest:{...value.replacementRequest!,status:'completed',reference:'https://recruitment.example.test/request/42',completedOn:'2026-11-17'}}});
  wrap(<ResignationTaskPanel task={item} initial={value} today="2026-11-16" close={vi.fn()} complete={complete}/>);
  expect(screen.getByRole('button',{name:'Record recruitment handoff'})).toBeDisabled();fireEvent.change(screen.getByLabelText('Recruitment reference URL'),{target:{value:'https://recruitment.example.test/request/42'}});fireEvent.submit(screen.getByRole('button',{name:'Record recruitment handoff'}).closest('form')!);
  await waitFor(()=>expect(actions.runResignationCommand).toHaveBeenCalledWith({caseId:'case-a',revision:7,command:{type:'completeReplacement',taskId:'task-a',reference:'https://recruitment.example.test/request/42'}}));await waitFor(()=>expect(complete).toHaveBeenCalledOnce());
 });
 it('edits table cells and rows while leaving letterhead and signatures protected',()=>{
  const change=vi.fn();wrap(<ResignationBlockEditor busy={false} onChange={change} blocks={[{id:'head',type:'letterhead',text:'',section:''},{id:'table',type:'table',text:'',section:'',columns:'Term | Offered',rows:'Grade | G4'},{id:'sig',type:'signature',text:'',section:''}]}/>);
  expect(screen.getAllByText(/This block is supplied/)).toHaveLength(2);fireEvent.change(screen.getByLabelText('Offered, Row 1'),{target:{value:'G5'}});expect(change.mock.calls[0][0][1].rows).toBe('Grade | G5');fireEvent.click(screen.getByRole('button',{name:'Add row'}));expect(change.mock.calls[1][0][1].rows).toBe('Grade | G4\n | ');
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
