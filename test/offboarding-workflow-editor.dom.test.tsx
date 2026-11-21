import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {OFFBOARDING_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/offboarding';
import type {AutomationWorkflow} from '../lib/automation/workflow';
import {WorkflowEditor,type WorkflowEditorReferences} from '../app/automation/workflows/workflow-editor';
const mocks=vi.hoisted(()=>({save:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/automation/actions',()=>({saveWorkflowAction:mocks.save,searchPeopleAction:vi.fn(),searchOffboardingCasesAction:vi.fn(),dryRunOffboardingWorkflowAction:vi.fn(),searchProbationCasesAction:vi.fn(),dryRunWorkflowAction:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
const refs:WorkflowEditorReferences={routings:[{id:'bp',name:'BP by business group'}],groups:[{id:'ops',name:'GBS People Ops'}],people:[],emailTemplates:[],letterTemplates:[{id:'retention',name:'Retention offer'}],postingApproverGroupId:'ops',conditionValues:{}};
const make=(event='submitted'):AutomationWorkflow=>({id:'00000000-0000-4000-8000-000000000001',module:'off',name:'Decision',description:'',status:'paused',required:false,trigger:{event,days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'decision',type:'requestDecision',to:[{kind:'role',role:'directSuperior'}],cc:[],conditions:[],params:{choices:'both',watch:[{kind:'routing',routingId:'bp'}],canComment:true}}]});
const show=(workflow:AutomationWorkflow,editable=true)=>render(<NextIntlClientProvider locale="en" messages={messages}><WorkflowEditor catalogue={OFFBOARDING_AUTOMATION_CATALOGUE} initial={workflow} revision={1} refs={refs} editable={editable} onClose={vi.fn()}/></NextIntlClientProvider>);
beforeEach(()=>{vi.clearAllMocks();mocks.save.mockResolvedValue({ok:true,result:{revision:2,problems:[],warnings:[]}});});
describe('Offboarding configuration editor',()=>{
 it('repairs an unsupported stored exit reason with a native classification before activation',async()=>{
  const workflow=make('accepted');workflow.steps=[{id:'start',type:'startOffboarding',to:[],cc:[],conditions:[],params:{exitReason:'Unsupported reason'}}];
  show(workflow);
  const reason=screen.getByRole('combobox',{name:messages.automation.editor.exitReason});
  expect(reason).toHaveValue('Unsupported reason');
  expect(screen.getByRole('button',{name:'Make it live'})).toBeDisabled();
  fireEvent.change(reason,{target:{value:'Retirement'}});
  expect(screen.getByRole('button',{name:'Make it live'})).toBeEnabled();
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce(),{timeout:2000});
  expect(mocks.save.mock.calls[0][0]).toMatchObject({expectedRevision:1,reason:'Automatically saved workflow changes',workflow:{status:'paused',steps:[{id:'start',params:{exitReason:'Retirement'}}]}});
  expect(await screen.findByText('Changes save automatically')).toBeVisible();
 });
 it('keeps deciders and FYI recipients separate when saving acceptance-only decisions',async()=>{
  show(make());
  expect(screen.getByRole('button',{name:'Who records the resignation decision'})).toHaveTextContent('Their Direct Superior');
  expect(screen.getByRole('button',{name:'Keep in the loop'})).toHaveTextContent('BP by business group');
  fireEvent.change(screen.getByRole('combobox',{name:'They can choose'}),{target:{value:'accept'}});
  fireEvent.change(screen.getByRole('spinbutton',{name:'Due within (working days)'}),{target:{value:'4'}});
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce(),{timeout:2000});
  expect(mocks.save.mock.calls[0][0]).toMatchObject({expectedRevision:1,reason:'Automatically saved workflow changes',workflow:{status:'paused',steps:[{to:[{kind:'role',role:'directSuperior'}],cc:[],params:{choices:'accept',watch:[{kind:'routing',routingId:'bp'}],canComment:true,dueDays:4}}]}});
  expect(await screen.findByText('Changes save automatically')).toBeVisible();
 });
 it('blocks Live for a reminder that is not shorter than the retention reply window',()=>{
  const workflow=make('retention');workflow.steps=[{id:'doc',type:'generateDocument',to:[],cc:[],conditions:[],params:{letterTemplateId:'retention',replyDays:5,remindDays:5}}];
  show(workflow);
  expect(screen.getByText('Step 1: The reminder must be fewer working days than the reply window.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Make it live'})).toBeDisabled();
  fireEvent.change(screen.getByRole('spinbutton',{name:'Remind before (working days)'}),{target:{value:'2'}});
  expect(screen.getByRole('button',{name:'Make it live'})).toBeEnabled();
 });
 it('opens read-only without save or activation controls when configuration authority is absent',()=>{
  show(make(),false);
  expect(screen.getByRole('textbox',{name:'Workflow name'})).toBeDisabled();
  expect(screen.queryByRole('button',{name:'Save changes'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Make it live'})).not.toBeInTheDocument();
 });
});
