import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {PartEditor} from '../app/lifecycle/probation/part-editor';
import {CaseDateControls} from '../app/lifecycle/probation/case-date-controls';
import {createProbationCase,DEFAULT_PROBATION_CONFIG,probationRoute} from '../lib/probation-model';
import {DEFAULT_PROBATION_FORM} from '../lib/probation-form';
import type {ProbationCaseView,ProbationPartView,ProbationPersonnel} from '../packs/probation/service';
const mocks=vi.hoisted(()=>({save:vi.fn(),act:vi.fn(),refresh:vi.fn(),push:vi.fn(),reconcile:vi.fn(),supersede:vi.fn(),applyDate:vi.fn(),requestDate:vi.fn(),adjudicate:vi.fn()}));
vi.mock('../app/lifecycle/probation/actions',()=>({saveDraft:mocks.save,performReview:mocks.act,reconcileDates:mocks.reconcile,supersedeDateShift:mocks.supersede,applyDateShift:mocks.applyDate,requestDateShift:mocks.requestDate,adjudicateOfflineFinal:mocks.adjudicate}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh,push:mocks.push})}));
const staff='11111111-1111-4111-8111-111111111111',manager='22222222-2222-4222-8222-222222222222';
function fixture(){
 let serial=10;const id=()=>`00000000-0000-4000-8000-${String(serial++).padStart(12,'0')}`;
 const record=createProbationCase({id:id(),employmentId:id(),companyId:id(),sourceKey:'fictional',startOn:'2026-11-02',endOn:'2027-05-01',months:6,grade:'12',explicitNoProbation:false,config:DEFAULT_PROBATION_CONFIG,nextId:id,isWorking:()=>true})!;
 const facts:ProbationPersonnel={employmentId:record.employmentId,personId:id(),companyId:record.companyId,employeeName:'Fictional Employee',employeeCode:'EX001',companyName:'Fictional Company',startOn:record.startOn,endOn:record.endOn,grade:'12',gradeId:id(),currentGradeId:id(),employmentType:'full_time',probationMonths:6,probationUnit:'month',probationValue:6,explicitNoProbation:false,unknownPeriod:false,confirmationOn:null,resignationOn:null,terminatedOn:null,departmentId:id(),businessUnitId:id(),businessGroupId:id(),businessGroup:'Fictional Group',department:'Fictional Department',businessUnit:'Fictional Unit',title:'Fictional Role',division:null,holders:{employee:staff,lm:manager,hod:null,pbp:null}};
 const parts:ProbationPartView[]=record.parts.map(p=>({...p,state:'issued',storageRevision:1,contentRevision:1,selfVisible:true,managerVisible:false,canEditEmployee:p.type!==1,canEditSelfAssessment:p.type!==1,canEditEmployeeComments:false,canAdjudicateOfflineDecision:false,canEditManager:false,managerIssues:[],employeeIssues:DEFAULT_PROBATION_FORM.criteria.map(c=>c.id+':unrated'),allowedCommands:[],signing:null,route:probationRoute(p.type,{employee:staff,lm:manager,hod:null,pbp:null,gbs:null})}));
 const view:ProbationCaseView={sourceMoved:false,runtimeEnabled:true,canRequestDateShift:false,canReconcileDates:false,letterTasks:[],sourceChanged:false,dateAdjustments:[],record:{...record,facts,parts},parts,form:DEFAULT_PROBATION_FORM,roles:['employee'],files:[],followups:[],outcomes:[],holderNames:{[staff]:'Fictional Employee',[manager]:'Fictional Manager'}};
 return{view,part:parts.find(p=>p.type===2)!};
}
function show(view:ProbationCaseView,part:ProbationPartView){return render(<NextIntlClientProvider locale="en" messages={messages}><PartEditor view={view} part={part} actor={{id:staff,name:'Fictional Employee'}}/></NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();mocks.save.mockResolvedValue({ok:true,result:2});mocks.act.mockResolvedValue({ok:true,result:{revision:2}});});
describe('probation reviewer interactions',()=>{
 it('starts unrated, requires evidence for a low rating and preserves private manager drafts',()=>{
  const{view,part}=fixture();show(view,part);
  expect(screen.getAllByRole('radio').every(r=>!(r as HTMLInputElement).checked)).toBe(true);
  const criterion=within(screen.getByRole('heading',{name:'Employee assessment'}).closest('section')!).getByRole('group',{name:/KPI Achievement Progress/});fireEvent.click(within(criterion).getByRole('radio',{name:/1 · Unacceptable/}));
  expect(within(criterion).getByRole('textbox',{name:/Evidence and examples/})).toBeRequired();
  expect(screen.getByText("The manager's submitted assessment is not available yet.")).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Record completed review'})).not.toBeInTheDocument();
 });
 it('retains entered ratings and error recovery when the guarded save fails',async()=>{
  mocks.save.mockResolvedValue({ok:false,detail:'The review changed. Reload before saving.'});const{view,part}=fixture();show(view,part);
  const criterion=within(screen.getByRole('heading',{name:'Employee assessment'}).closest('section')!).getByRole('group',{name:/KPI Achievement Progress/});fireEvent.click(within(criterion).getByRole('radio',{name:/3 · Meets Expectations/}));fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  await screen.findByRole('alert');expect(within(criterion).getByRole('radio',{name:/3 · Meets Expectations/})).toBeChecked();await waitFor(()=>expect(screen.getByText('You have unsaved changes')).toBeInTheDocument());expect(mocks.refresh).not.toHaveBeenCalled();
 });
 it('locks submitted self-ratings and saves only the permitted acknowledgement comment contribution',async()=>{
  const{view,part}=fixture();part.canEditSelfAssessment=false;part.canEditEmployeeComments=true;part.staffSubmittedAt='2026-12-01T01:00:00Z';part.managerSubmittedAt='2026-12-02T01:00:00Z';part.managerVisible=true;part.allowedCommands=['acknowledge','return'];part.state='pending_ack';
  const hash='a'.repeat(64);part.signing={id:'signing',document:{tenantId:'tenant',companyId:view.record.companyId,subjectId:part.id,subjectType:'probation',contentRevision:1,contentHash:hash,route:part.route,actions:[{id:'manager-signed',stepId:part.route.steps.find(s=>s.role==='lm')!.id,contentRevision:1,contentHash:hash,actorId:manager,actorPersonId:'manager-person',actorName:'Fictional Manager',representedId:manager,role:'lm',at:'2026-12-02T01:00:00Z',action:'signed',comment:'',signature:{method:'typed',value:'Fictional Manager',consent:true}}]}};
  show(view,part);expect(screen.queryByRole('radio')).not.toBeInTheDocument();fireEvent.change(screen.getByRole('textbox',{name:'Employee comments'}),{target:{value:'The review was discussed; I have noted the feedback.'}});fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalled());expect(mocks.save.mock.calls[0][0].patch).toEqual({employeeComments:'The review was discussed; I have noted the feedback.'});
 });
 it('lets the employee save only Part 1 meeting-acknowledgement comments',async()=>{
  const{view}=fixture(),part=view.parts.find(p=>p.type===1)!;part.canEditEmployee=true;part.canEditEmployeeComments=true;part.canEditSelfAssessment=false;part.managerSubmittedAt='2026-11-03T01:00:00Z';part.allowedCommands=['acknowledge'];
  show(view,part);fireEvent.change(screen.getByRole('textbox',{name:'Employee comments'}),{target:{value:'The Week 1 meeting was held and the KPIs discussed.'}});fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({rater:'employee',patch:{employeeComments:'The Week 1 meeting was held and the KPIs discussed.'}})));
 });
 it('shows the submitted Personnel snapshot and period on a previously submitted review',()=>{
  const{view,part}=fixture();part.submittedFacts={...view.record.facts,companyName:'Company at submission'};part.submittedPeriod={startOn:'2026-10-01',endOn:'2027-03-31',gradeAtStart:'14'};
  show(view,part);expect(screen.getByText('Company at submission')).toBeInTheDocument();expect(screen.queryByText('Fictional Company')).not.toBeInTheDocument();expect(screen.getByText('2027-03-31')).toBeInTheDocument();expect(screen.getByText(/Personnel details and review period recorded/)).toBeInTheDocument();
 });
 it('lets PBP confirm a different permitted extension without editing the manager assessment',async()=>{
  const{view}=fixture(),part=view.parts.find(p=>p.type===3)!;view.roles=['pbp'];part.canEditEmployee=false;part.canEditManager=false;part.managerSubmittedAt='2027-04-01T01:00:00Z';part.extensionMonths=3;part.allowedCommands=['confirm_extension'];
  show(view,part);fireEvent.change(screen.getByRole('combobox',{name:/Extension period/}),{target:{value:'6'}});fireEvent.change(screen.getByRole('textbox',{name:/Reason/}),{target:{value:'Reviewed the support plan and approved six months.'}});fireEvent.click(screen.getByRole('button',{name:'Confirm extension'}));
  await waitFor(()=>expect(mocks.act).toHaveBeenCalledWith(expect.objectContaining({command:'confirm_extension',months:6,reason:'Reviewed the support plan and approved six months.'})));expect(mocks.save).not.toHaveBeenCalled();
 });
 it('does not offer a signature or privileged state change to a read-only viewer',()=>{
  const{view,part}=fixture();view.roles=['hod'];part.canEditEmployee=false;part.selfVisible=false;part.allowedCommands=[];show(view,part);
  expect(screen.queryByRole('button',{name:'Save draft'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Sign and submit'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Unlock the selected owner\'s fields'})).not.toBeInTheDocument();
 });
 it('requires a saved employee comment when the pinned evaluation form requires one',()=>{
  const{view,part}=fixture();view.form={...view.form,employeeCommentsRequired:true};part.canEditSelfAssessment=false;part.canEditEmployeeComments=true;part.staffSubmittedAt='2026-12-01T01:00:00Z';part.managerSubmittedAt='2026-12-02T01:00:00Z';part.allowedCommands=['acknowledge'];part.state='pending_ack';
  const hash='a'.repeat(64);part.signing={id:'signing',document:{tenantId:'tenant',companyId:view.record.companyId,subjectId:part.id,subjectType:'probation',contentRevision:1,contentHash:hash,route:part.route,actions:[{id:'manager-signed',stepId:part.route.steps.find(s=>s.role==='lm')!.id,contentRevision:1,contentHash:hash,actorId:manager,actorPersonId:'manager-person',actorName:'Fictional Manager',representedId:manager,role:'lm',at:'2026-12-02T01:00:00Z',action:'signed',comment:'',signature:{method:'typed',value:'Fictional Manager',consent:true}}]}};
  show(view,part);expect(screen.getByText('Save the required employee comments before acknowledging this review.')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Sign and submit'})).toBeDisabled();expect(mocks.act).not.toHaveBeenCalled();
 });
});

describe('historical probation source review',()=>{
 it('requests a schedule review during pause without offering a Personnel date write',async()=>{
  const{view}=fixture();view.runtimeEnabled=false;view.canReconcileDates=true;view.sourceChanged=true;view.record.facts.endOn='2027-05-10';view.roles=['pbp'];mocks.reconcile.mockResolvedValue({ok:true,result:{queued:true}});
  render(<NextIntlClientProvider locale="en" messages={messages}><CaseDateControls view={view}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByRole('textbox',{name:'Reason'}),{target:{value:'Reviewed the canonical start and end dates.'}});fireEvent.click(screen.getByRole('button',{name:'Request schedule review while paused'}));
  await screen.findByText('Schedule review requested. Processing remains paused.');expect(mocks.reconcile).toHaveBeenCalledWith({caseId:view.record.id,revision:view.record.revision,reason:'Reviewed the canonical start and end dates.'});expect(mocks.applyDate).not.toHaveBeenCalled();expect(mocks.requestDate).not.toHaveBeenCalled();
 });
 it('closes an outdated request using its revision and reason without applying the old date',async()=>{
  const{view}=fixture();view.roles=['pbp'];view.dateAdjustments=[{id:'older-request',oldEndOn:'2027-05-01',newEndOn:'2027-05-28',reason:'Original long leave request.',requestedAt:'2026-11-03',status:'failed',appliedAt:null,approvedAt:'2026-11-03',failure:'private fixture details',canApprove:false,canSupersede:true,supersededAt:null,supersededReason:null}];mocks.supersede.mockResolvedValue({ok:true});
  render(<NextIntlClientProvider locale="en" messages={messages}><CaseDateControls view={view}/></NextIntlClientProvider>);const button=screen.getByRole('button',{name:'Close outdated request'});expect(button).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox',{name:'Reason'}),{target:{value:'Personnel has a newer verified date.'}});fireEvent.click(button);await waitFor(()=>expect(mocks.supersede).toHaveBeenCalledWith({caseId:view.record.id,requestId:'older-request',revision:view.record.revision,reason:'Personnel has a newer verified date.'}));expect(mocks.applyDate).not.toHaveBeenCalled();expect(screen.queryByText('private fixture details')).not.toBeInTheDocument();
 });
 it('lets scoped People Ops record the verified original paper decision without electronic ratings or signing',async()=>{
  const{view}=fixture(),part=view.parts.find(p=>p.type===3)!;view.roles=['gbs'];part.state='completed_offline';part.canEditEmployee=false;part.canEditSelfAssessment=false;part.allowedCommands=['record'];part.offlineDecision={id:'paper',entryId:'intake',revision:1,outcome:'confirm',extensionMonths:null,reason:'The signed paper decision was checked.',evidenceId:'evidence',fileId:'original-file',periodStart:'2026-11-02',periodEnd:'2027-05-01',proposedBy:'pbp',proposedAt:'2026-11-03',acceptedBy:null,acceptedAt:null};view.files=[{id:'original-file',kind:'offline',name:'Original signed final review.pdf',partId:part.id,revision:1,filingState:'filed'}];show(view,part);
  expect(screen.getByRole('link',{name:'Original signed final review.pdf'})).toHaveAttribute('href','/lifecycle/probation/'+view.record.id+'/files/original-file');expect(screen.queryByRole('radio')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Sign and submit'})).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox',{name:/Reason/}),{target:{value:'Verified the actual signed original.'}});fireEvent.click(screen.getByRole('button',{name:'Record verified paper decision'}));await waitFor(()=>expect(mocks.act).toHaveBeenCalledWith(expect.objectContaining({command:'record',partId:part.id,revision:part.storageRevision,reason:'Verified the actual signed original.'})));expect(mocks.save).not.toHaveBeenCalled();
 });
});
