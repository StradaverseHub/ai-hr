/** Selection hints never fetch a new definition or save merely by opening an existing builder. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {contractTemplateEditorTarget,contractWorkflowEditorId} from '../app/automation/editor-target';
import {TemplatesWorkspace} from '../app/automation/templates/templates-workspace';
import {WorkflowsWorkspace} from '../app/automation/workflows/workflows-workspace';
import type {ContractTemplatesData} from '../app/automation/templates/contract-templates';
import type {AutomationWorkflow} from '../lib/automation/workflow';
import type {WorkflowEditorReferences} from '../app/automation/workflows/workflow-editor';
import type {ReactNode} from 'react';
const native=vi.hoisted(()=>({usage:vi.fn(),saveDoc:vi.fn(),saveEmail:vi.fn(),saveWorkflow:vi.fn(),test:vi.fn(),act:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/automation/actions',()=>({documentTemplateUsageAction:native.usage,saveDocumentTemplateAction:native.saveDoc,saveEmailTemplateAction:native.saveEmail,saveWorkflowAction:native.saveWorkflow,sendTestEmailAction:native.test,documentTemplateAction:native.act,searchContractTemplateCasesAction:vi.fn(),loadContractTemplatePreviewAction:vi.fn(),searchPeopleAction:vi.fn(),dryRunWorkflowAction:vi.fn(),searchProbationCasesAction:vi.fn(),dryRunContractWorkflowAction:vi.fn(),searchContractCasesAction:vi.fn(),searchOffboardingCasesAction:vi.fn(),dryRunOffboardingWorkflowAction:vi.fn(),installProbationDefaultsAction:vi.fn(),installOffboardingDefaultsAction:vi.fn(),moveProbationWorkflowsAction:vi.fn()}));
// This suite checks the native editor host's selection/read-only/save boundaries. Rich editor behavior has its own fixtures.
vi.mock('../components/email-body-editor',async()=>{const React=await import('react');return {EmailBodyEditor:React.forwardRef((_props,ref)=>{React.useImperativeHandle(ref,()=>({focusTableCell:vi.fn()}));return <div aria-label="Native rich message editor"/>;})};});
const docId='a1111111-1111-4111-8111-111111111111',emailId='b2222222-2222-4222-8222-222222222222',flowId='c3333333-3333-4333-8333-333333333333',foreignId='d4444444-4444-4444-8444-444444444444';
const data:ContractTemplatesData={documents:[{template:{id:docId,module:'contract_staff',name:'Fictional retired letter',description:'Original retained wording',rules:{},blocks:[{id:'text',type:'text',text:'Saved native wording',section:''}],fields:[],routing:[{id:'owner',action:'review',order:1,owner:true,who:{kind:'directSuperior'}}]},revision:7,currentVersion:2,liveVersion:1,retired:true}],emails:[{template:{id:emailId,module:'contract_staff',name:'Fictional retired email',active:false,subject:'Original saved subject',body:'Original saved message',cc:[]},revision:4,retired:true}],refs:{groups:[],people:[],routings:[],conditions:{}}};
const refs:WorkflowEditorReferences={groups:[],people:[],routings:[],emailTemplates:[],letterTemplates:[],conditionValues:{businessGroup:[{value:docId,label:'Fictional Services'}]}};
const workflow:AutomationWorkflow={id:flowId,module:'contract_staff',name:'Fictional retired workflow',description:'Saved definition',status:'retired',required:false,trigger:{event:'manual',days:0,workdays:false,repeat:false},conditions:[],skipWhen:'never',steps:[]};
const access={any:true,contractStaff:true,legacy:false,probation:false};
const wrap=(children:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>);
const templates=(query:Parameters<typeof contractTemplateEditorTarget>[0],value=data)=>wrap(<TemplatesWorkspace filter="contract_staff" access={access} emails={[]} letters={null} refs={data.refs} contract={value} initialContractTarget={contractTemplateEditorTarget(query)}/>);
const workflows=(query:Parameters<typeof contractWorkflowEditorId>[0],value=workflow)=>wrap(<WorkflowsWorkspace filter="contract_staff" access={access} workflows={[]} refs={refs} defaultsMissing={0} contract={{workflows:[{workflow:value,revision:3}],refs}} initialContractWorkflowId={contractWorkflowEditorId(query)}/>);
const originalShow=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal'),originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close');
beforeAll(()=>{Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}});Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}});});
afterAll(()=>{for(const [name,descriptor]of [['showModal',originalShow],['close',originalClose]] as const){if(descriptor)Object.defineProperty(HTMLDialogElement.prototype,name,descriptor);else Reflect.deleteProperty(HTMLDialogElement.prototype,name);}});
beforeEach(()=>{vi.clearAllMocks();native.usage.mockResolvedValue({ok:true,result:{documents:0,usedByWorkflow:false,deleteReason:null,versions:[{version:2,template:data.documents[0].template,savedAt:'2026-11-17T00:00:00Z',note:'Native retained wording',documents:0,state:'draft',canDelete:false}]}});});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('Contract setup review links to actual shared builders',()=>{
 it('validates one exact Contract target and rejects arrays, malformed IDs, ambiguous targets and other modules',()=>{
  expect(contractTemplateEditorTarget({module:'contract_staff',document:docId.toUpperCase()})).toEqual({kind:'document',id:docId});
  for(const query of [{module:'off',document:docId},{module:'contract_staff',document:[docId]},{module:'contract_staff',document:'not-an-id'},{module:'contract_staff',document:docId,email:emailId}])expect(contractTemplateEditorTarget(query)).toBeUndefined();
  expect(contractWorkflowEditorId({module:'contract_staff',workflow:flowId})).toBe(flowId);
  expect(contractWorkflowEditorId({module:'contract_staff',workflow:[flowId]})).toBeUndefined();expect(contractWorkflowEditorId({module:'probation',workflow:flowId})).toBeUndefined();
 });
 it('opens the exact authorized retired document in its native read-only state with the real separate content/CAS versions',async()=>{
  templates({module:'contract_staff',document:docId});
  const dialog=await screen.findByRole('dialog',{name:'Edit document template'});
  expect(within(dialog).getByRole('textbox',{name:'Template name'})).toHaveValue('Fictional retired letter');expect(within(dialog).getByRole('textbox',{name:'Template name'})).toBeDisabled();
  expect(within(dialog).getByText('Latest version 2 · In use: 1')).toBeVisible();expect(within(dialog).getByRole('button',{name:'Restore template'})).toBeVisible();
  await waitFor(()=>expect(native.usage).toHaveBeenCalledWith(docId));expect(native.saveDoc).not.toHaveBeenCalled();expect(native.act).not.toHaveBeenCalled();
 });
 it('retains an authorized unpublished document draft without marking it dirty or saving on arrival',async()=>{
  templates({module:'contract_staff',document:docId},{...data,documents:data.documents.map(row=>({...row,retired:false,template:{...row.template,name:'Fictional saved draft'}}))});
  const dialog=await screen.findByRole('dialog',{name:'Edit document template'});expect(within(dialog).getByRole('textbox',{name:'Template name'})).toBeEnabled();
  expect(within(dialog).getByRole('button',{name:messages.automation.contract.saveDraft})).toBeDisabled();expect(native.saveDoc).not.toHaveBeenCalled();
 });
 it('opens only the selected saved email and preserves retirement instead of creating or saving a replacement',async()=>{
  templates({module:'contract_staff',email:emailId});const dialog=await screen.findByRole('dialog',{name:'Edit email template'});
  expect(within(dialog).getByRole('textbox',{name:'Template name'})).toHaveValue('Fictional retired email');expect(within(dialog).getByRole('textbox',{name:'Template name'})).toBeDisabled();
  expect(native.usage).not.toHaveBeenCalled();expect(native.saveEmail).not.toHaveBeenCalled();expect(native.test).not.toHaveBeenCalled();
 });
 it('never opens or reads an unknown/foreign document, email or workflow ID',()=>{
  for(const kind of ['document','email'] as const){templates({module:'contract_staff',[kind]:foreignId});expect(screen.queryByRole('dialog')).toBeNull();expect(native.usage).not.toHaveBeenCalled();cleanup();}
  workflows({module:'contract_staff',workflow:foreignId});expect(screen.queryByRole('textbox',{name:'Workflow name'})).toBeNull();expect(native.saveWorkflow).not.toHaveBeenCalled();
 });
 it('opens the actual retired workflow read-only without writing it',()=>{
  workflows({module:'contract_staff',workflow:flowId});expect(screen.getByRole('textbox',{name:'Workflow name'})).toHaveValue(workflow.name);expect(screen.getByRole('textbox',{name:'Workflow name'})).toBeDisabled();expect(native.saveWorkflow).not.toHaveBeenCalled();
 });
 it('does not auto-save a saved workflow merely because its legacy condition label has a unique native ID',async()=>{
  vi.useFakeTimers();workflows({module:'contract_staff',workflow:flowId},{...workflow,name:'Fictional saved workflow',status:'paused',conditions:[{field:'businessGroup',op:'is',values:['Fictional Services']}]});
  expect(screen.getByRole('textbox',{name:'Workflow name'})).toHaveValue('Fictional saved workflow');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(native.saveWorkflow).not.toHaveBeenCalled();
 });
});
