import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {PROBATION_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/probation';
import type {AutomationWorkflow} from '../lib/automation/workflow';
import {WorkflowEditor,type WorkflowEditorReferences} from '../app/automation/workflows/workflow-editor';
import {WorkflowsWorkspace} from '../app/automation/workflows/workflows-workspace';

/** The shared HR Automation workflow editor (prototype WorkflowsPage; handoff A1). Server actions are mocked; the store and
 * its database refusals are covered by test/automation-store-db.test.ts and test/automation-email-store-db.test.ts. */
const m=vi.hoisted(()=>({save:vi.fn(),dryRun:vi.fn(),cases:vi.fn(),people:vi.fn(),install:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/automation/actions',()=>({saveWorkflowAction:m.save,dryRunWorkflowAction:m.dryRun,searchProbationCasesAction:m.cases,searchPeopleAction:m.people,installProbationDefaultsAction:m.install}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh,push:vi.fn()})}));
vi.mock('next/link',async()=>{const React=await import('react');return {default:({prefetch:_prefetch,...props}:Record<string,unknown>)=>React.createElement('a',props,props.children as React.ReactNode)};});

const catalogue=PROBATION_AUTOMATION_CATALOGUE;
const refs:WorkflowEditorReferences={
 routings:[{id:'00000000-0000-4000-8000-0000000000b1',name:'BP by business group'}],
 groups:[{id:'g-gbs',name:'GBS People Ops'}],people:[],
 emailTemplates:[{id:'00000000-0000-4000-8000-0000000000e1',name:'Your probation letter',active:true,retired:false,subject:'Your probation letter'}],
 letterTemplates:[{id:'confirm-letter',name:'Confirmation letter'}],
 conditionValues:{businessGroup:[{value:'00000000-0000-4000-8000-0000000000c0',label:'Fictional Group'}],company:[{value:'00000000-0000-4000-8000-0000000000c1',label:'Fictional Company Sdn Bhd'}],department:[{value:'00000000-0000-4000-8000-0000000000d1',label:'Finance'}],jobGrade:[{value:'12',label:'12'}],extensionsUsed:['0','1','2'].map(value=>({value,label:value}))},
};
const workflow=(over:Partial<AutomationWorkflow>={}):AutomationWorkflow=>({id:'00000000-0000-4000-8000-0000000000a1',module:'probation',name:'Outcome · Confirm',description:'',status:'paused',required:true,
 trigger:{event:'outcomeDecided',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[{field:'outcome',op:'is',values:['Confirm']}],
 steps:[{id:'s1',type:'notify',conditions:[],to:[{kind:'role',role:'employee'}],cc:[{kind:'group',groupId:'g-gbs'}],params:{subject:'Your outcome',body:'Hello {{employee.name}}'}}],...over});
const show=(initial:AutomationWorkflow,revision=1)=>render(<NextIntlClientProvider locale="en" messages={messages}><WorkflowEditor catalogue={catalogue} initial={initial} revision={revision} refs={refs} onClose={vi.fn()}/></NextIntlClientProvider>);
const options=(select:HTMLElement)=>within(select).getAllByRole('option').map(option=>option.textContent);

beforeEach(()=>{vi.clearAllMocks();m.save.mockResolvedValue({ok:true,result:{revision:2,problems:[],warnings:[]}});});

describe('shared workflow editor',()=>{
 it('offers only the condition fields the chosen trigger can supply',()=>{
  show(workflow({trigger:{event:'caseOpened',days:0,workdays:false,repeat:false},conditions:[]}));
  fireEvent.click(screen.getByRole('button',{name:'Add condition'}));
  const caseOpened=options(screen.getByRole('combobox',{name:'Condition field'}));
  expect(caseOpened).toEqual(['Review plan','Business group','Company','Department','Job grade','Extensions used']);
  fireEvent.change(screen.getByRole('combobox',{name:'What starts it'}),{target:{value:'lowResult'}});
  const lowResult=options(screen.getByRole('combobox',{name:'Condition field'}));
  expect(lowResult).toEqual(expect.arrayContaining(['Part','Result band','Suggestion overridden']));
  expect(lowResult).not.toContain('Outcome');expect(lowResult).not.toContain('Pending step');
  // Date settings appear only for date-based triggers.
  expect(screen.queryByRole('checkbox',{name:'Count working days (Mon–Fri)'})).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox',{name:'What starts it'}),{target:{value:'dueBeforeReview'}});
  expect(screen.getByRole('checkbox',{name:'Count working days (Mon–Fri)'})).toBeInTheDocument();
  expect(screen.getByRole('spinbutton',{name:'Days before a review due date'})).toHaveValue(1);
 });

 it('keeps a condition the new trigger cannot supply visible and reports it as a problem',()=>{
  show(workflow());
  fireEvent.change(screen.getByRole('combobox',{name:'What starts it'}),{target:{value:'caseOpened'}});
  const field=screen.getByRole('combobox',{name:'Condition field'});
  expect(field).toHaveValue('outcome');
  expect(options(field)[0]).toBe('Outcome · not available for this trigger');
  expect(within(screen.getByRole('region',{name:'Problems'})).getByText('Condition 1: this field is not available for the chosen trigger.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Make it live'})).toBeDisabled();
 });

 it('selects several condition values and saves them in catalogue order',async()=>{
  show(workflow());
  fireEvent.click(screen.getByRole('button',{name:'Condition value for Outcome'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Non-confirmation'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Extend'}));
  fireEvent.click(screen.getByRole('button',{name:'Done'}));
  expect(screen.getByRole('button',{name:'Condition value for Outcome'})).toHaveTextContent('Confirm, Extend, Non-confirmation');
  fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(m.save).toHaveBeenCalledTimes(1));
  expect(m.save.mock.calls[0][0]).toMatchObject({expectedRevision:1,reason:'Edited in the workflow builder',workflow:{status:'paused',conditions:[{field:'outcome',op:'is',values:['Confirm','Extend','Non-confirmation']}]}});
 });

 it('stores business group, company and department conditions as ids and shows their names; a value saved as a name becomes its id',async()=>{
  show(workflow({conditions:[{field:'outcome',op:'is',values:['Confirm']},{field:'company',op:'is',values:['Fictional Company Sdn Bhd']}]}));
  expect(screen.getByRole('button',{name:'Condition value for Company'})).toHaveTextContent('Fictional Company Sdn Bhd');
  fireEvent.click(screen.getByRole('button',{name:'Add condition'}));
  const fields=screen.getAllByRole('combobox',{name:'Condition field'});
  fireEvent.change(fields[fields.length-1],{target:{value:'department'}});
  expect(screen.getByRole('button',{name:'Condition value for Department'})).toHaveTextContent('Finance');
  fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(m.save).toHaveBeenCalledTimes(1));
  expect(m.save.mock.calls[0][0].workflow.conditions).toEqual([
   {field:'outcome',op:'is',values:['Confirm']},
   {field:'company',op:'is',values:['00000000-0000-4000-8000-0000000000c1']},
   {field:'department',op:'is',values:['00000000-0000-4000-8000-0000000000d1']},
  ]);
 });

 it('blocks Make it live while there are problems, and makes a clean workflow live',async()=>{
  const view=show(workflow({steps:[{id:'s1',type:'sendEmail',conditions:[],to:[],cc:[],params:{emailTemplateId:''}}]}));
  const problems=within(screen.getByRole('region',{name:'Problems'}));
  expect(problems.getByText('Step 1: choose an email template.')).toBeInTheDocument();
  expect(problems.getByText('Step 1: choose who receives the email.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Make it live'})).toBeDisabled();
  view.unmount();
  show(workflow());
  expect(screen.queryByRole('region',{name:'Problems'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Make it live'}));
  await waitFor(()=>expect(m.save).toHaveBeenCalledTimes(1));
  expect(m.save.mock.calls[0][0]).toMatchObject({workflow:{status:'live'},reason:'Made live in the workflow builder'});
  expect(await screen.findByRole('button',{name:'Pause'})).toBeInTheDocument();
 });

 it('shows the problems the server returns when it refuses to make a workflow live',async()=>{
  m.save.mockResolvedValue({ok:false,code:'invalid',detail:'Fix the problem before making it live.',problems:['Step 1 To: a chosen routing no longer exists.']});
  show(workflow());
  fireEvent.click(screen.getByRole('button',{name:'Make it live'}));
  const alert=await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Fix the problem before making it live.');
  expect(alert).toHaveTextContent('Step 1 To: a chosen routing no longer exists.');
  expect(screen.getByRole('button',{name:'Make it live'})).toBeInTheDocument();
 });

 it('warns about merge fields the trigger cannot supply without blocking', ()=>{
  show(workflow({steps:[{id:'s1',type:'notify',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{subject:'Band {{probation.resultBand}}',body:''}}]}));
  expect(within(screen.getByRole('region',{name:'Notes'})).getByText('Step 1: {{probation.resultBand}} cannot be filled for this trigger.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Make it live'})).toBeEnabled();
 });

 it('renders a dry run against a chosen probation case without sending anything',async()=>{
  m.cases.mockResolvedValue({ok:true,result:[{id:'case-1',name:'Fictional Employee',detail:'EX001 · Fictional Group'}]});
  m.dryRun.mockResolvedValue({ok:true,result:{employeeName:'Fictional Employee',run:{wouldRun:false,reason:'It would match, but the workflow is not live.',runDate:'2026-11-20',repeats:true,
   conditions:[{condition:{field:'outcome',op:'is',values:['Confirm']},ok:true,actual:'Confirm',unavailable:false}],
   steps:[{index:1,id:'s1',type:'notify',runs:true,conditions:[],to:['Fictional Employee'],cc:['Everyone in “GBS People Ops”'],missing:[]},
    {index:2,id:'s2',type:'sendEmail',runs:false,conditions:[{condition:{field:'outcome',op:'is',values:['Extend']},ok:false,actual:'Confirm',unavailable:false}],to:[],cc:[],missing:['No row of “BP by business group” matches this employee.']}],sends:false}}});
  show(workflow());
  const panel=within(screen.getByRole('region',{name:'Dry run'}));
  fireEvent.change(panel.getByRole('textbox',{name:'Find a probation case'}),{target:{value:'Fict'}});
  fireEvent.click(panel.getByRole('button',{name:'Find cases'}));
  await waitFor(()=>expect(panel.getByRole('combobox',{name:'Test case'})).toHaveValue('case-1'));
  fireEvent.change(panel.getByRole('combobox',{name:'Outcome'}),{target:{value:'Extend'}});
  fireEvent.click(panel.getByRole('button',{name:'Run the dry run'}));
  const result=within(await panel.findByRole('status',{name:'Dry run result'}));
  expect(m.dryRun).toHaveBeenCalledWith(expect.objectContaining({caseId:'case-1',event:expect.objectContaining({outcome:'Extend'}),workflow:expect.objectContaining({id:'00000000-0000-4000-8000-0000000000a1'})}));
  expect(result.getByText('Would run on 2026-11-20. Then every morning after that.')).toBeInTheDocument();
  expect(result.getByText('Would not run for Fictional Employee.')).toBeInTheDocument();
  expect(result.getByText('It would match, but the workflow is not live.')).toBeInTheDocument();
  expect(result.getByText(/1\. Notify someone · to Fictional Employee · CC Everyone in “GBS People Ops”/)).toBeInTheDocument();
  expect(result.getByText(/2\. Send an email · skipped: Outcome is Extend/)).toBeInTheDocument();
  expect(result.getByText(/No row of “BP by business group” matches this employee\./)).toBeInTheDocument();
  expect(result.getByText('Nothing is sent and nothing is saved.')).toBeInTheDocument();
  expect(m.save).not.toHaveBeenCalled();
 });
});

describe('shared workflow list',()=>{
 it('lists Probation workflows with Live, Paused and Required pills and a one-line summary, and links the other builders',()=>{
  const confirm=workflow({status:'live',steps:[{id:'s1',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:'confirm-letter'}},{id:'s2',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:'00000000-0000-4000-8000-0000000000e1'}},{id:'s3',type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:'Confirmation'}}]});
  const reminder=workflow({id:'00000000-0000-4000-8000-0000000000a2',name:'Review reminder',required:true,trigger:{event:'dueBeforeReview',days:7,workdays:false,repeat:true},conditions:[{field:'part',op:'isNot',values:['Part 1 · Week 1 Success Plan']}]});
  render(<NextIntlClientProvider locale="en" messages={messages}><WorkflowsWorkspace filter="all" access={{legacy:true,probation:true,contractStaff:false,any:true}} workflows={[{workflow:confirm,revision:3},{workflow:reminder,revision:1}]} refs={refs} defaultsMissing={0}/></NextIntlClientProvider>);
  expect(screen.getByText('When the probation outcome is decided · if Outcome is Confirm · Generate a document → Send an email → Create Personnel Management posting')).toBeInTheDocument();
  expect(screen.getByText('7 days before a review due date, then every morning · if Part is not Part 1 · Week 1 Success Plan · Notify someone')).toBeInTheDocument();
  const items=screen.getAllByRole('listitem');
  expect(within(items[0]).getByText('Live')).toBeInTheDocument();expect(within(items[0]).getByText('Required')).toBeInTheDocument();
  expect(within(items[1]).getByText('Paused')).toBeInTheDocument();expect(within(items[1]).getByText('Required')).toBeInTheDocument();
  expect(within(items[1]).queryByText('Needs attention')).not.toBeInTheDocument();
  // A required workflow that is not live is called out; the live one is not.
  expect(screen.getByRole('note')).toHaveTextContent('Review reminder is required for probation but not live.');
  expect(screen.queryByRole('button',{name:'Install default Probation workflows'})).not.toBeInTheDocument();
  expect(screen.getAllByRole('link',{name:'Open the On/Off Boarding workflow builder'})[0]).toHaveAttribute('href','/lifecycle/v9?view=workflows');
  expect(within(screen.getByRole('region',{name:'Contract staff'})).getByText('You cannot configure this module.')).toBeInTheDocument();
 });
});
