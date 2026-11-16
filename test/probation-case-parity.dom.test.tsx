import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {PartEditor} from '../app/lifecycle/probation/part-editor';
import {ProbationCaseViewScreen} from '../app/lifecycle/probation/case-view';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {probationLetterDocument} from '../lib/probation-letter-document';
import type {Assessment} from '../lib/probation-model';
import type {ProbationCaseView,ProbationLetterView} from '../packs/probation/service';
import {probationCaseFixture,fixtureManager,fixtureStaff} from './helpers/probation-case-fixture';

/**
 * Lane M2: the case page and part forms follow the approved prototype (CaseView, ReviewTab, CriteriaGrid, ScoreTiles,
 * Part1Tab, OutcomeTab, LetterPaper). Every name and value is fictional.
 */
const m=vi.hoisted(()=>({save:vi.fn(),act:vi.fn(),refresh:vi.fn(),push:vi.fn()}));
vi.mock('../app/lifecycle/probation/actions',()=>({saveDraft:m.save,performReview:m.act,adjudicateOfflineFinal:vi.fn(),addFollowup:vi.fn(),recordLowResultAction:vi.fn(),decideOtherOutcome:vi.fn(),
 requestDateShift:vi.fn(),applyDateShift:vi.fn(),reconcileDates:vi.fn(),supersedeDateShift:vi.fn(),requestLegacyReconciliation:vi.fn(),approveLegacyReconciliation:vi.fn(),replaceSigner:vi.fn(),overrideRoute:vi.fn(),
 signLetter:vi.fn(),resendLetter:vi.fn(),releaseLetter:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh,push:m.push})}));
const cv=messages.probation.caseView,form=cv.form;
const wrap=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
const rated=(view:ProbationCaseView,rating:number,evidence:string):Assessment=>Object.fromEntries(view.form.criteria.map(c=>[c.id,{rating,evidence}]));
/** Part 3 with Parts 1 and 2 done and the employee's self-assessment in. */
function onPart3(){
 const f=probationCaseFixture(),p1=f.part(1),p3=f.part(3);
 for(const p of f.view.parts)if(p.type!==3)p.state='locked';
 p1.acknowledgedAt='2026-06-10T01:00:00Z';f.view.record.kpiAcknowledged=true;
 p1.kpis=[{id:'k1',accountability:'Fictional purchase order turnaround',measure:'Average days per order',target:'3 days',targetDate:'2026-08-31'}];
 p3.state='staff_submitted';p3.staffSubmittedAt='2026-11-01T01:00:00Z';p3.dueOn='2026-12-02';p3.issueOn='2026-11-01';p3.selfVisible=true;p3.employee=rated(f.view,4,'Fictional example');
 return{...f,p1,p3};
}
beforeEach(()=>{vi.clearAllMocks();m.save.mockResolvedValue({ok:true,result:2});m.act.mockResolvedValue({ok:true});});

describe('Part 2 / Part 3 rating grid (prototype ReviewTab, CriteriaGrid)',()=>{
 it('lays the criteria out as one grid with both raters, live result tiles and the outcome choice beside them',async()=>{
  const{view,p3}=onPart3();view.roles=['lm'];p3.canEditManager=true;p3.managerVisible=true;
  wrap(<PartEditor embedded view={view} part={p3} actor={{id:fixtureManager,name:'Fictional Manager'}}/>);
  expect(screen.getByRole('heading',{level:2,name:cv.stage['3']})).toBeInTheDocument();
  expect(screen.getByText(form.yourLm)).toBeInTheDocument();
  expect(screen.getByRole('textbox',{name:messages.probation.conductedBy})).toHaveValue('Fictional Manager');
  expect(screen.getByRole('heading',{name:'A. Role Performance Assessment · B. 7 Leadership Principles'})).toBeInTheDocument();
  const grid=screen.getByRole('table',{name:form.gridLabel});
  expect(within(grid).getAllByRole('columnheader').map(h=>h.textContent)).toEqual(['Criterion','Weight','Employee','Line Manager','Comments / evidence']);
  expect(within(grid).getByText('A. Role (50%)')).toBeInTheDocument();expect(within(grid).getByText('B. 7 Leadership Principles (50%)')).toBeInTheDocument();
  expect(within(grid).getAllByText('“Fictional example”',{exact:false})).toHaveLength(9);
  expect(within(grid).getByRole('button',{name:'Shows the 1 Week 1 KPIs'})).toBeInTheDocument();
  const band=screen.getByTestId('probation-band');expect(band).toHaveTextContent('Rate all 9');
  expect(screen.getByText('Employee self-score 4.00 (Band 4). Only the Line Manager’s result drives the suggestion.')).toBeInTheDocument();
  for(const c of view.form.criteria)fireEvent.click(within(screen.getByRole('group',{name:'Line Manager rating for '+c.title})).getByRole('button',{name:'4 · Above Expectations'}));
  expect(band).toHaveTextContent('4 · Above');
  expect(screen.getByText('Section A /2.50').nextSibling).toHaveTextContent('2.00');expect(screen.getByText('Total /5.00').nextSibling).toHaveTextContent('4.00');
  const outcome=screen.getByRole('group',{name:form.choice['3']});
  expect(within(outcome).getAllByRole('radio').map(r=>r.closest('label')!.textContent)).toEqual(['Confirm employment'+form.suggested,'Extend probation · 3 or 6 months','Non-confirmation','Other · needs justification and a PBP decision']);
  expect(within(outcome).getAllByRole('radio').every(r=>!(r as HTMLInputElement).checked)).toBe(true);
  fireEvent.click(within(outcome).getByRole('radio',{name:/^Extend probation/}));
  fireEvent.change(screen.getByRole('combobox',{name:/Extension length/}),{target:{value:'3'}});
  expect(screen.getByRole('heading',{name:form.result['3']})).toBeInTheDocument();expect(screen.getByRole('heading',{name:form.ackHeading})).toBeInTheDocument();
  expect(screen.getByTestId('probation-part-actions')).toHaveTextContent('Submitting sends the review to Fictional Employee to acknowledge.');
  fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(m.save).toHaveBeenCalled());
  const patch=m.save.mock.calls[0][0].patch;expect(m.save.mock.calls[0][0].rater).toBe('lm');
  expect(Object.values(patch.manager).map(r=>(r as {rating:number}).rating)).toEqual(Array(9).fill(4));expect(patch).toMatchObject({outcome:'extend',extensionMonths:3});
 });
 it('opens the criterion guide and the Week 1 KPIs in a drawer that Escape closes',()=>{
  const{view,p3}=onPart3();view.roles=['lm'];p3.canEditManager=true;p3.managerVisible=true;
  wrap(<PartEditor embedded view={view} part={p3} actor={{id:fixtureManager,name:'Fictional Manager'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Guide for Job Knowledge & Problem Solving'}));
  const guide=screen.getByRole('dialog',{name:'Appendix A · Job Knowledge & Problem Solving'});
  expect(within(guide).getByText(view.form.criteria.find(c=>c.id==='knowledge')!.prompt)).toBeInTheDocument();
  fireEvent.keyDown(window,{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Shows the 1 Week 1 KPIs'}));
  expect(within(screen.getByRole('dialog',{name:form.drawer.kpiTitle})).getByText('Fictional purchase order turnaround')).toBeInTheDocument();
 });
 it('renders a completed part as the same grid with values, not a long list of fields',()=>{
  const{view,p3}=onPart3();view.roles=['hod'];p3.state='locked';p3.managerVisible=true;p3.manager=rated(view,3,'Met the standard');p3.outcome='confirm';p3.justification='Fictional reasons.';p3.reviewOn='2026-11-20';
  wrap(<PartEditor embedded view={view} part={p3} actor={{id:'viewer',name:'Fictional Viewer'}}/>);
  const grid=screen.getByRole('table',{name:form.gridLabel});
  expect(within(grid).queryAllByRole('textbox')).toHaveLength(0);
  const lm=within(grid).getByRole('group',{name:'Line Manager rating for KPI Achievement Progress'});
  expect(within(lm).getByRole('button',{name:'3 · Meets Expectations'})).toHaveAttribute('aria-pressed','true');expect(within(lm).getAllByRole('button').every(b=>(b as HTMLButtonElement).disabled)).toBe(true);
  expect(within(grid).getAllByText('Met the standard')).toHaveLength(9);
  expect(screen.getByRole('radio',{name:/^Confirm employment/})).toBeChecked();expect(screen.getByRole('radio',{name:/^Confirm employment/})).toBeDisabled();
  expect(screen.getByRole('textbox',{name:/Recommendation and justification/})).toHaveAttribute('readonly');
  expect(screen.getByTestId('probation-part-actions')).toHaveTextContent(form.notes.locked);
  expect(screen.queryByRole('button',{name:'Save draft'})).not.toBeInTheDocument();
 });
 it('shows a part that has not opened yet as a scheduled card with its dates',()=>{
  const{view,part}=probationCaseFixture(),p2=part(2);p2.issueOn='2026-08-15';p2.dueOn='2026-09-14';view.roles=['lm'];
  wrap(<PartEditor embedded view={view} part={p2} actor={{id:fixtureManager,name:'Fictional Manager'}}/>);
  expect(screen.getByText('Scheduled. The form opens on 15/08/2026, 30 days before the due date 14/09/2026.')).toBeInTheDocument();
  expect(screen.getByText(form.gateBlocks)).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
 });
});

describe('Part 1 · Week 1 KPIs (prototype Part1Tab)',()=>{
 it('shows A. the KPI table, B. planned support and C. meeting acknowledgement, and saves the rows the manager adds',async()=>{
  const{view,part}=probationCaseFixture(),p1=part(1);p1.state='issued';p1.canEditManager=true;p1.managerVisible=true;view.roles=['lm'];
  wrap(<PartEditor embedded view={view} part={p1} actor={{id:fixtureManager,name:'Fictional Manager'}}/>);
  const kpis=screen.getByRole('region',{name:form.kpiHeading});
  expect(within(kpis).getAllByRole('columnheader').map(h=>h.textContent)).toEqual(['No.','Key accountability','KPI / success measure','Target','Target date',form.kpiRemove]);
  expect(within(kpis).getByText(form.kpiEmpty)).toBeInTheDocument();
  fireEvent.click(within(kpis).getByRole('button',{name:form.kpiAdd}));
  fireEvent.change(screen.getByRole('textbox',{name:'Key accountability 1'}),{target:{value:'Fictional accountability'}});
  fireEvent.change(screen.getByRole('textbox',{name:'KPI / success measure 1'}),{target:{value:'Fictional measure'}});
  for(const label of Object.values(form.supportLabels))expect(screen.getByRole('textbox',{name:label+' *'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:form.meetingHeading})).toBeInTheDocument();expect(screen.getByRole('textbox',{name:messages.probation.employeeComments})).toHaveAttribute('readonly');
  expect(screen.getByTestId('probation-part-actions')).toHaveTextContent(form.notes.lmKpis);
  fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(m.save).toHaveBeenCalled());
  expect(m.save.mock.calls[0][0].patch.kpis).toEqual([expect.objectContaining({accountability:'Fictional accountability',measure:'Fictional measure'})]);
 });
});

describe('Case header and Outcome & letters (prototype CaseView, OutcomeTab)',()=>{
 function onPart2(){
  const f=probationCaseFixture(),p1=f.part(1),p2=f.part(2);
  p1.state='locked';p1.acknowledgedAt='2026-06-12T02:00:00Z';p2.state='staff_submitted';p2.staffSubmittedAt='2026-09-01T02:00:00Z';p2.dueOn='2026-09-30';p2.issueOn='2026-08-30';
  return{...f,p2};
 }
 const screenFor=(view:ProbationCaseView,actorId:string,extra:Partial<Parameters<typeof ProbationCaseViewScreen>[0]>={})=>wrap(<ProbationCaseViewScreen view={view} today="2026-09-20" tab="outcome" part={null} actor={{id:actorId,name:'Fictional Viewer'}} {...extra}/>);
 it('shows the facts with their labels, a Next action bar for others and "Your step" for the holder',()=>{
  const{view}=onPart2();
  const first=screenFor(view,'someone-else');
  expect(screen.getByTestId('probation-next-action')).toHaveTextContent('Next action: Line Manager · Fictional Manager · assessment.');
  expect(document.querySelector('.pcc-pill-acc')).toHaveTextContent(cv.pill);
  expect(Array.from(document.querySelectorAll('.probation-facts dt')).map(dt=>dt.textContent)).toEqual(Object.values(cv.facts));
  first.unmount();
  screenFor(view,fixtureManager);
  expect(screen.getByTestId('probation-waiting')).toHaveTextContent(/^Your step: Line Manager · Fictional Manager · assessment · due 30\/09\/2026 \(10 days left\)$/);
  expect(screen.queryByTestId('probation-next-action')).not.toBeInTheDocument();
 });
 it('shows the latest letter in full on the tab with its routing and state, and earlier letters as links',()=>{
  const{view}=onPart2();
  const template=newProbationLetterTemplate('confirm','template','Fictional confirmation letter');template.blocks=[{id:'body',type:'text',text:'Dear {employeeName}',section:'main'}];
  const route={version:1,steps:[{id:'pbp',role:'pbp',kind:'sign' as const,stage:1,holderId:'pbp-user',required:true},{id:'employee',role:'employee',kind:'sign' as const,stage:2,holderId:fixtureStaff,required:true}]};
  const signing={tenantId:'tenant',companyId:'company',subjectId:'letter',subjectType:'probation',contentRevision:1,contentHash:'a'.repeat(64),route,actions:[]};
  const merge={employeeName:'Fictional Employee'};
  const letter:ProbationLetterView={routed:false,contentVisible:true,owner:null,canEditContent:false,unresolved:[],sourceMoved:false,runtimeEnabled:true,id:'letter',caseId:view.record.id,outcomeId:'outcome',outcomeRevision:2,storageRevision:1,state:'pending_approval',createdAt:'',name:'Fictional confirmation letter',templateId:'template',templateVersion:3,blocks:template.blocks,fields:[],merge,signing:{id:'signing',document:signing},route,canPrepare:false,canRelease:false,
   signers:{pbp:{holderId:'pbp-user',name:'Fictional Partner',title:null,label:null,role:'pbp',representedName:null}},
   document:probationLetterDocument({id:'letter',name:'Fictional confirmation letter',templateId:'template',templateVersion:3,blocks:template.blocks,fields:[],merge,createdAt:'',signing})};
  view.letterTasks=[{partId:'letter',label:'Fictional confirmation letter',state:'awaiting_signature',waitingRole:'pbp',waitingName:'Fictional Partner'},{partId:'older',label:'Fictional earlier letter',state:'released',waitingRole:null,waitingName:null}];
  screenFor(view,'someone-else',{letter});
  expect(screen.getByRole('heading',{level:2,name:'Fictional confirmation letter'})).toBeInTheDocument();
  expect(screen.getByText('From the shared Templates builder · module Probation · template v3 · '+messages.probation.letters.frozen)).toBeInTheDocument();
  expect(screen.getByTestId('probation-letter-state')).toHaveTextContent('Waiting for Fictional Partner');
  expect(within(screen.getByRole('heading',{name:cv.letter.routing}).closest('section')!).getAllByRole('listitem')).toHaveLength(2);
  expect(document.querySelector('.pcc-paper')).toHaveTextContent('Dear Fictional Employee');
  const earlier=screen.getByRole('heading',{name:cv.earlierLetters}).closest('section')!;
  expect(within(earlier).getByRole('link',{name:messages.probation.letters.open})).toHaveAttribute('href','/lifecycle/probation/'+view.record.id+'/letters/older');
  expect(screen.queryByRole('link',{name:messages.probation.backCase})).not.toBeInTheDocument();
 });
});
