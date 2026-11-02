import type {ReactNode} from 'react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import {newContractCase,DEFAULT_CONTRACT_SETTINGS} from '../lib/contract-management-model';
import type {ContractCaseView,ContractSource} from '../packs/contracts/service';
import {ContractCases} from '../app/lifecycle/contracts/cases';
import {ContractCaseDetail} from '../app/lifecycle/contracts/[caseId]/detail';
import {ContractSettingsEditor} from '../app/lifecycle/contracts/settings/settings';
const mocks=vi.hoisted(()=>({command:vi.fn(),refresh:vi.fn(),push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh,push:mocks.push}),usePathname:()=>'/lifecycle/contracts'}));
vi.mock('../app/lifecycle/contracts/actions',()=>({runContractCommand:mocks.command,readContractLetterEditor:vi.fn()}));
vi.mock('../components/letters/rich-editor',()=>({LetterRichEditor:()=>null}));
const companyId='11111111-1111-4111-8111-111111111111',employeeId='22222222-2222-4222-8222-222222222222',caseId='33333333-3333-4333-8333-333333333333',documentId='44444444-4444-4444-8444-444444444444';
const source:ContractSource={employmentId:employeeId,companyId,personId:employeeId,name:'Fictional Employee',employeeId:'FIX-001',designation:'Coordinator',grade:'G',department:'Operations',businessGroup:'Fictional Group',company:'Fictional Company',manager:'Fictional Manager',signatoryName:'Verified Signatory',signatoryTitle:'Director',startOn:'2026-01-01',endOn:'2026-12-31',salaryCents:'500000',allowanceCents:'10000',allowanceComponentId:employeeId,sourceRevision:'a'.repeat(64),ended:false};
function record(){return newContractCase({id:caseId,number:'CT-2026-0001',term:{id:caseId,employmentId:employeeId,companyId,kind:'project',version:1,startOn:source.startOn,endOn:source.endOn,salaryCents:'500000',allowanceCents:'10000',sourceRevision:source.sourceRevision},settings:DEFAULT_CONTRACT_SETTINGS,today:'2026-11-03'});}
function view():ContractCaseView{return{record:record(),source,sourceConflict:null,manager:false,pbp:false,gbs:false,employee:true,configure:false,choices:{routes:[],approvalStepIds:[],holders:[]},documents:[],activity:[],effects:[]};}
const localeMessages={en:messages,ms,zh,vi:viMessages,th,ta};
const companies=[{id:companyId,name:source.company,configure:false,gbs:false,pbp:false,canIntake:false,canCapturePbp:false}];
const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
beforeEach(()=>{mocks.command.mockReset();mocks.refresh.mockReset();mocks.command.mockResolvedValue({ok:true,result:{}});});
describe('Contract Management scoped interactions',()=>{
 it('filters the real assigned list and keeps expiry unsigned distinct from an end decision',async()=>{
  const r=record();r.term.endOn='2026-10-31';wrap(<ContractCases today="2026-11-03" companies={companies} rows={[{record:r,source,sourceConflict:null,lastSyncedAt:'2026-11-03T06:00:00+08:00'}]}/>);
  expect(screen.getByRole('link',{name:source.name})).toBeInTheDocument();expect(screen.getByRole('cell',{name:'Expired – unsigned'})).toBeInTheDocument();expect(screen.queryByRole('link',{name:'Settings'})).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole('searchbox'),'unmatched');expect(screen.getByText(/No cases match/)).toBeInTheDocument();await userEvent.click(screen.getByRole('button',{name:'Clear filters'}));expect(screen.getByRole('link',{name:source.name})).toBeInTheDocument();
 });
 it('shows no decision or approval controls to an employee and binds acceptance to the exact reviewed document',async()=>{
  const v=view();v.record.state='e_acceptance';v.documents=[{id:documentId,type:'renewal',templateId:caseId,templateVersion:4,decisionRevision:2,hash:'b'.repeat(64),issuedAt:'2026-11-03T06:00:00Z',releasedAt:null,supersededAt:null,accepted:false,employeeDocumentId:null}];
  wrap(<ContractCaseDetail view={v} today="2026-11-03" editorLabels={null}/>);
  expect(screen.queryByRole('button',{name:'Submit for approval'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Approve',exact:true})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Accept and sign contract'})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('checkbox',{name:'I have reviewed this exact current document.'}));const accept=screen.getByRole('button',{name:'Accept and sign contract'});expect(accept).toBeDisabled();await userEvent.type(screen.getByLabelText('Type your full name'),'Fictional Employee');expect(accept).toBeDisabled();await userEvent.click(screen.getByRole('checkbox',{name:/I confirm this is my signature/}));await userEvent.click(accept);
  await waitFor(()=>expect(mocks.command).toHaveBeenCalledWith('accept',expect.objectContaining({caseId,revision:1,documentId,hash:'b'.repeat(64),signature:{method:'typed',value:'Fictional Employee',consent:true}})));
 });
 it('keeps the refusal reason when a server authority check fails',async()=>{
  mocks.command.mockResolvedValue({ok:false,error:'The contract changed. Review it again.'});const v=view();v.record.state='e_acceptance';v.documents=[{id:documentId,type:'renewal',templateId:caseId,templateVersion:1,decisionRevision:1,hash:'c'.repeat(64),issuedAt:'2026-11-03T06:00:00Z',releasedAt:null,supersededAt:null,accepted:false,employeeDocumentId:null}];wrap(<ContractCaseDetail view={v} today="2026-11-03" editorLabels={null}/>);
  await userEvent.click(screen.getByRole('checkbox',{name:/I have reviewed/}));const reason=screen.getByLabelText('Reason for declining the renewal');await userEvent.type(reason,'I need to discuss the proposed terms.');await userEvent.click(screen.getByRole('button',{name:'Decline renewal'}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('The contract changed'));expect(reason).toHaveValue('I need to discuss the proposed terms.');expect(mocks.refresh).not.toHaveBeenCalled();
 });
 it('keeps template review discoverable without granting case setup to a template-only reviewer',()=>{
  wrap(<ContractCases today="2026-11-03" companies={[]} rows={[]} templatesAvailable/>);expect(screen.getByRole('link',{name:'Templates'})).toHaveAttribute('href','/lifecycle/contracts/templates');expect(screen.queryByRole('link',{name:'Settings'})).not.toBeInTheDocument();
 });
 it('shows a bounded retry message and never renders raw stored record-update diagnostics',()=>{
  const v=view();v.employee=false;v.gbs=true;v.record.state='records_pending';v.effects=[{kind:'records',status:'failed',error:'private SQL params sensitive failure',receipt:null}];wrap(<ContractCaseDetail view={v} today="2026-11-03" editorLabels={null}/>);expect(screen.queryByText(/private SQL params/)).not.toBeInTheDocument();expect(screen.getByRole('alert')).toHaveTextContent(messages.contractManagement.failed);expect(screen.getByRole('button',{name:'Retry pending record updates'})).toBeInTheDocument();
 });
 it.each(Object.entries(localeMessages))('renders translated case status and safeguards in %s',(locale,catalog)=>{
  const r=record();r.term.endOn='2026-10-31';render(<NextIntlClientProvider locale={locale} messages={catalog}><ContractCases today="2026-11-03" companies={companies} rows={[{record:r,source,sourceConflict:null,lastSyncedAt:'2026-11-03T06:00:00+08:00'}]}/></NextIntlClientProvider>);expect(screen.getByRole('cell',{name:catalog.contractManagement.state.expired_unsigned})).toBeInTheDocument();expect(screen.getByText(catalog.contractManagement.neverAutoEnd)).toBeInTheDocument();
 });
 it('saves an incomplete manager draft without submitting a decision or stopping the approval flow',async()=>{
  const v=view();v.employee=false;v.manager=true;wrap(<ContractCaseDetail view={v} today="2026-11-03" editorLabels={null}/>);await userEvent.clear(screen.getByLabelText('Proposed basic salary (RM)'));expect(screen.getByRole('button',{name:'Submit for approval'})).toBeDisabled();await userEvent.click(screen.getByRole('button',{name:'Save decision draft'}));await waitFor(()=>expect(mocks.command).toHaveBeenCalledWith('saveDecisionDraft',expect.objectContaining({caseId,revision:1,kind:'renew',basicSalary:'',reason:''})));expect(mocks.command.mock.calls.some(c=>c[0]==='decision')).toBe(false);
 });
 it('keeps a conditionally skipped Rewards step visible without blocking submission for missing unused holders',async()=>{
  const v=view();v.employee=false;v.manager=true;mocks.command.mockImplementation(async(command:string)=>({ok:true,result:command==='previewDecision'?{routes:[{workflowId:documentId,name:'Published renewal route',version:3,approvals:[{id:'rewards',name:'Conditional Rewards',stage:0,holderIds:[],quorum:'all',when:'pay_changed',state:'skipped',actions:[]},{id:'ceo',name:'Actual CEO',stage:1,holderIds:[caseId],quorum:'any',when:'always',state:'pending',actions:[]}]}]}:{}}));wrap(<ContractCaseDetail view={v} today="2026-11-03" editorLabels={null}/>);await userEvent.type(screen.getByLabelText('Reason'),'Continue the approved project.');await waitFor(()=>expect(screen.getByRole('button',{name:'Submit for approval'})).toBeEnabled(),{timeout:2000});expect(screen.getByText(/Conditional Rewards/)).toBeInTheDocument();expect(screen.queryByText(/Required approver is missing/)).not.toBeInTheDocument();
 });
 it('blocks runtime activation until policy owners, date and real record-update nominee are selected',async()=>{
  wrap(<ContractSettingsEditor today="2026-11-03" companies={[{...companies[0],configure:true,gbs:true,canIntake:true}]} choices={[{companyId,units:[],payItems:[{id:employeeId,code:'FIX',name:'Fixed allowance'}],effectNominees:[{id:caseId,name:'Actual approved nominee'}],users:[]}]} settings={{roles:[],configurations:[{companyId,revision:2,data:{...DEFAULT_CONTRACT_SETTINGS,allowanceComponentId:employeeId,ownersConfirmed:false,dailyHour:6},runtimeEnabled:false,activationOn:null,effectPrincipalId:null}]}}/>);
  await userEvent.click(screen.getByRole('checkbox',{name:'Enable daily contract processing'}));expect(screen.getByRole('button',{name:'Save settings'})).toBeDisabled();await userEvent.click(screen.getByRole('checkbox',{name:/responsible policy owners/}));fireEvent.change(screen.getByLabelText('Activation date'),{target:{value:'2026-11-04'}});expect(screen.getByRole('button',{name:'Save settings'})).toBeDisabled();await userEvent.selectOptions(screen.getByLabelText('Authorised record-update nominee'),caseId);await userEvent.click(screen.getByRole('button',{name:'Save settings'}));await waitFor(()=>expect(mocks.command).toHaveBeenCalledWith('configure',expect.objectContaining({companyId,expectedRevision:2,runtimeEnabled:true,effectPrincipalId:caseId,activationOn:'2026-11-04'})));
 });
});
