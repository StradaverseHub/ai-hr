import {describe,expect,it,vi,beforeEach} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {ProbationCaseViewScreen,type ProbationCaseViewProps} from '../app/lifecycle/probation/case-view';
import {probationDefaultTab,probationRouteSteps,probationWaitingOn} from '../app/lifecycle/probation/case-stage';
import {probationCaseFixture,fixtureManager,fixtureStaff} from './helpers/probation-case-fixture';
vi.mock('../app/lifecycle/probation/actions',()=>({addFollowup:vi.fn(),saveDraft:vi.fn(),performReview:vi.fn(),adjudicateOfflineFinal:vi.fn(),recordLowResultAction:vi.fn(),decideOtherOutcome:vi.fn(),
 requestDateShift:vi.fn(),applyDateShift:vi.fn(),reconcileDates:vi.fn(),supersedeDateShift:vi.fn(),requestLegacyReconciliation:vi.fn(),approveLegacyReconciliation:vi.fn(),replaceSigner:vi.fn(),overrideRoute:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const cv=messages.probation.caseView;
const show=(props:Partial<ProbationCaseViewProps>&Pick<ProbationCaseViewProps,'view'|'tab'>)=>render(<NextIntlClientProvider locale="en" messages={messages}><ProbationCaseViewScreen today="2026-09-20" part={null} actor={{id:'viewer',name:'Fictional Viewer'}} {...props}/></NextIntlClientProvider>);
/** A six-month case on Part 2: Part 1 done, the employee's self-assessment in, the Line Manager's assessment overdue. */
function onPart2(){
 const f=probationCaseFixture(),p1=f.part(1),p2=f.part(2);
 p1.state='locked';p1.acknowledgedAt='2026-06-12T02:00:00Z';
 p2.state='staff_submitted';p2.staffSubmittedAt='2026-09-01T02:00:00Z';p2.dueOn='2026-09-14';p2.issueOn='2026-08-15';
 return{...f,p1,p2};
}
beforeEach(()=>vi.clearAllMocks());

describe('Probation case view (L1, prototype CaseView)',()=>{
 it('shows the facts, the parts stepper with done / overdue / not reached, the live route and who it waits on',()=>{
  const{view,p2}=onPart2();
  show({view,tab:'p2',part:p2});
  expect(screen.getByRole('heading',{level:1,name:'Probation · '+cv.stage['2']})).toBeInTheDocument();
  expect(screen.getByTestId('probation-waiting')).toHaveTextContent('Waiting on: Line Manager · Fictional Manager · assessment · due 14/09/2026 (6 days overdue)');
  const parts=within(screen.getByRole('list',{name:cv.partsLabel})).getAllByRole('listitem');
  expect(parts.map(step=>[step.textContent,step.getAttribute('data-state')])).toEqual([
   ['Week 1 KPIs (done)','done'],['Part 2 Mid-Probation (overdue)','overdue'],['Part 3 Final review (not reached)','waiting'],['Outcome (not reached)','waiting']]);
  const route=within(screen.getByRole('list',{name:cv.routeLabel})).getAllByRole('listitem');
  expect(route.map(step=>[step.textContent,step.getAttribute('data-state')])).toEqual([
   ['Employee self-assessment (done)','done'],['LM assessment (current)','current'],['Employee acknowledges (not reached)','waiting']]);
  const facts=screen.getByRole('region',{name:'Probation · '+cv.stage['2']});
  for(const text of ['Fictional Employee · EX001','Fictional Role · 12','03/06/2026 – 02/12/2026','6 months · P2 + P3','0 of 2','LM Fictional Manager','PBP Fictional Partner'])expect(within(facts).getByText(text,{exact:false})).toBeInTheDocument();
 });
 it('uses the prototype tab set, marks the current stage and opens the part form inside its tab without a second header',()=>{
  const{view,p1,p2}=onPart2();
  show({view,tab:'p2',part:p2});
  const tabs=within(screen.getByRole('navigation',{name:cv.tabs.label})).getAllByRole('link');
  expect(tabs.map(tab=>tab.textContent)).toEqual(['Part 1 · Week 1 KPIs','Part 2 · Mid-Probation'+cv.tabs.current,'Part 3 · Final','Outcome & letters','Files (0)','History']);
  expect(tabs[0]).toHaveAttribute('href','/lifecycle/probation/'+view.record.id+'/'+p1.id);
  expect(tabs[1]).toHaveAttribute('aria-current','page');expect(tabs[3]).toHaveAttribute('href','/lifecycle/probation/'+view.record.id+'?tab=outcome');
  // The part form: its own sections, without the standalone page's heading, back link or parts list.
  expect(screen.getByRole('heading',{name:messages.probation.signing.title})).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:messages.probation.backCase})).not.toBeInTheDocument();
  expect(screen.queryByRole('heading',{level:1,name:'Part 2'})).not.toBeInTheDocument();
  expect(screen.getByRole('link',{name:messages.probation.backTracker})).toHaveAttribute('href','/lifecycle/probation');
 });
 it('keeps every case action: low result, outcome records and letters on Outcome & letters; follow-ups, date review and workflow history on History; files on Files',()=>{
  const{view,p2}=onPart2();view.roles=['pbp'];
  p2.managerSubmittedAt='2026-09-15T02:00:00Z';p2.scoreBand=1;p2.override=true;
  view.outcomes=[{id:'outcome',partId:p2.id,outcome:'other',state:'awaiting_decision',revision:2,letterFileId:null,releasedAt:null,failure:null,sourceKey:'source',filingState:'not_prepared'}];
  view.letterTasks=[{partId:'letter-part',label:'Fictional confirmation letter',state:'awaiting_signature',waitingRole:'pbp',waitingName:'Fictional Partner'}];
  view.canRequestDateShift=true;
  view.files=[{id:'file',kind:'completed_part',name:'Part 1 completed form.pdf',partId:view.parts[0].id,revision:1,filingState:'filed'}];
  view.followups=[{id:'note',kind:'followup',note:'Fictional follow-up note',at:'2026-09-02 10:00:00+08',actorId:fixtureManager}];
  const outcome=show({view,tab:'outcome'});
  expect(screen.getByText(messages.probation.tracker.flags.overridden)).toBeInTheDocument();
  expect(screen.getByRole('region',{name:messages.probation.lowResult.title})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:messages.probation.lowResult.save})).toBeInTheDocument();
  expect(screen.getByRole('link',{name:messages.probation.manageOutcome})).toHaveAttribute('href','/lifecycle/probation/'+view.record.id+'/outcomes/outcome');
  expect(screen.getByRole('link',{name:messages.probation.letters.open})).toHaveAttribute('href','/lifecycle/probation/'+view.record.id+'/letters/letter-part');
  expect(screen.getByText('Fictional Partner')).toBeInTheDocument();
  outcome.unmount();
  const history=show({view,tab:'history',history:[{id:'run',trigger:'caseOpened',triggerLabel:'Case opened',status:'done',startedAt:'2026-06-03 09:00:00+08',updatedAt:'2026-06-03 09:00:00+08',failure:null,entries:[]}]});
  expect(screen.getByRole('region',{name:messages.probation.automationHistory.title})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:messages.probation.followup.save})).toBeInTheDocument();
  expect(screen.getByText('Fictional follow-up note')).toBeInTheDocument();expect(screen.getByText('02/09/2026 10:00',{exact:false})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:messages.probation.dates.title})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:messages.probation.dates.request})).toBeInTheDocument();
  history.unmount();
  show({view,tab:'files'});
  expect(screen.getByRole('link',{name:'Part 1 completed form.pdf'})).toHaveAttribute('href','/lifecycle/probation/'+view.record.id+'/files/file');
 });
 it('names a closed case, opens it on Outcome & letters and shows the empty states plainly',()=>{
  const{view}=probationCaseFixture();
  for(const part of view.parts)part.state='locked';
  view.record.state='confirmed';
  expect(probationDefaultTab(view)).toBe('outcome');expect(probationWaitingOn(view)).toBeNull();
  show({view,tab:'outcome'});
  expect(screen.getByRole('heading',{level:1,name:'Probation · '+messages.probation.caseStates.confirmed})).toBeInTheDocument();
  expect(screen.getByTestId('probation-waiting')).toHaveTextContent(cv.closed);
  expect(within(screen.getByRole('list',{name:cv.partsLabel})).getAllByRole('listitem').map(step=>step.getAttribute('data-state'))).toEqual(['done','done','done','done']);
  expect(screen.queryByRole('list',{name:cv.routeLabel})).not.toBeInTheDocument();
  expect(screen.getByText(cv.noOutcome)).toBeInTheDocument();
 });
 it('opens a case waiting for its start date on Part 1 with nothing due',()=>{
  const{view}=probationCaseFixture();view.startStatus='waiting_for_start';
  expect(probationDefaultTab(view)).toBe('p1');
  show({view,tab:'files'});
  expect(screen.getByRole('heading',{level:1,name:'Probation · '+messages.probation.caseStates.waitingForStart})).toBeInTheDocument();
  expect(screen.getByText(cv.filesEmpty)).toBeInTheDocument();
  expect(screen.getByText(/Waiting for the start date \(03\/06\/2026\)/)).toBeInTheDocument();
 });
 it('reads a pending approval step from the signing document and names its holder',()=>{
  const{view,part}=probationCaseFixture(),p3=part(3);
  for(const p of view.parts)if(p.type!==3)p.state='locked';
  p3.route={...p3.route,steps:p3.route.steps.map(step=>step.role==='hod'?{...step,holderId:'hod-user'}:step)};view.holderNames['hod-user']='Fictional Head';
  p3.state='pending_approval';p3.staffSubmittedAt='2026-11-20T01:00:00Z';p3.managerSubmittedAt='2026-11-21T01:00:00Z';
  const signed=(stepId:string,role:string,actorId:string)=>({id:stepId,stepId,contentRevision:1,contentHash:'h',actorId,actorPersonId:'p',actorName:'x',representedId:actorId,role,at:'2026-11-21T01:00:00Z',action:'signed' as const,comment:'',signature:{method:'typed' as const,value:'x',consent:true as const}});
  p3.signing={id:'s',document:{tenantId:'t',companyId:'c',subjectId:p3.id,subjectType:'probation',contentRevision:1,contentHash:'h',route:p3.route,actions:[signed('lm','lm',fixtureManager),signed('employee','employee',fixtureStaff)]}};
  const steps=probationRouteSteps(p3);
  expect(steps.map(s=>[s.kind,s.state])).toEqual([['self','done'],['lmAssess','done'],['ack','done'],['approveSign','current'],['approveSign','waiting']]);
  expect(probationWaitingOn(view)).toMatchObject({role:'hod',holderId:'hod-user',what:'approve'});
  show({view,tab:'outcome'});
  expect(screen.getByTestId('probation-waiting')).toHaveTextContent(/^Waiting on: Head of Department · Fictional Head · approval · due /);
  expect(within(screen.getByRole('list',{name:cv.routeLabel})).getAllByRole('listitem').map(step=>step.textContent)).toEqual([
   'Employee self-assessment (done)','LM assessment (done)','Employee acknowledges (done)','Approve and sign · Fictional Head (current)','Approve and sign · Fictional Partner (not reached)']);
 });
});
