import {beforeEach,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {SharedApprovalPage} from '../app/lifecycle/contracts/approvals/[approvalId]/review';
import {ContractPostingReceipt} from '../app/lifecycle/contracts/posting-receipt';
import {ContractDecline} from '../app/lifecycle/contracts/record-decline';
import {ContractStartingSetup} from '../app/lifecycle/contracts/settings/starting-setup';
import {SharedLetterPage} from '../app/lifecycle/contracts/letters/[letterId]/review';
import type {ContractSharedApproval,ContractSharedLetter} from '../packs/contracts/service';
import {automationDocument} from '../lib/automation-document';
const actions=vi.hoisted(()=>({approval:vi.fn(),letter:vi.fn(),edit:vi.fn(),bind:vi.fn(),setup:vi.fn(),startSetup:vi.fn(),decline:vi.fn(),pay:vi.fn()}));
vi.mock('../app/lifecycle/contracts/shared-actions',()=>({actSharedApproval:actions.approval,actSharedLetter:actions.letter,editSharedLetter:actions.edit,bindSharedEmployee:actions.bind,readSharedSetup:actions.setup,startSharedSetup:actions.startSetup,recordSharedDecline:actions.decline,confirmSharedPay:actions.pay}));
vi.mock('next/navigation',()=>({usePathname:()=>'/tasks',useRouter:()=>({refresh:vi.fn()})}));
const caseId='b1fa7485-70d8-4403-9dab-815da20b2e01',id='aab5d59c-c75f-4dc2-9d4a-45865ea8ff81',hash='a'.repeat(64);
function approval():ContractSharedApproval{return {id,caseId,decisionRevision:3,employeeName:'Fictional Contract Employee',employeeCode:'FC-7',company:'Fictional Company',decision:{kind:'renew',startOn:'2027-01-01',endOn:'2027-12-31',months:12,payChanges:true,salaryCents:'521012',reason:'Retain specialist work',endReason:null,submittedBy:'proposer',submittedAt:'2026-11-16T00:00:00Z',revision:3},period:{id:'period',startOn:'2026-01-01',endOn:'2026-12-31',number:'4',sourceRevision:hash},contentRevision:1,contentHash:hash,pendingLayerId:'ceo',canAct:true,status:'pending',layers:[{id:'ceo',label:'CEO',stage:1,assigneeName:'Fictional CEO',fulfilled:false}],history:[]};}
function letter():ContractSharedLetter{return {id,caseId,decisionRevision:3,templateId:'template',templateVersion:2,name:'Fictional renewal letter',generatedOn:'2026-11-16T00:00:00Z',state:'routing',valuesFixed:false,releasedAt:null,contentRevision:1,contentHash:hash,returned:false,canEdit:false,canResend:false,pendingAction:{stepId:'employee',kind:'sign'},layers:[{id:'employee',label:'Employee',stage:2,kind:'sign',owner:false,assigneeName:'Fictional Employee',unavailable:false,fulfilled:false}],history:[],body:null};}
const document=automationDocument({id,name:'Fictional renewal letter',templateId:'template',templateVersion:2,blocks:[{id:'intro',type:'text',text:'Dear Fictional Employee',section:''}],fields:[],merge:{},createdAt:'2026-11-16T00:00:00Z'});
function mount(ui:React.ReactNode){return render(<NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();});
it('requires a rejection reason, posts the exact displayed revision and retains a failed reason',async()=>{
 actions.approval.mockResolvedValue({ok:false,error:'The decision changed. Reload before acting.'});
 mount(<SharedApprovalPage approval={approval()}/>);
 expect(screen.getByRole('button',{name:'Reject and return decision'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Comment / reason for rejection'),{target:{value:'Please explain the new term.'}});
 fireEvent.click(screen.getByRole('button',{name:'Reject and return decision'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('The decision changed.');
 expect(screen.getByLabelText('Comment / reason for rejection')).toHaveValue('Please explain the new term.');
 expect(actions.approval).toHaveBeenCalledWith(expect.objectContaining({id,layerId:'ceo',revision:1,hash,action:'reject',reason:'Please explain the new term.'}));
 expect(Object.keys(actions.approval.mock.calls[0][0]).sort()).toEqual(['action','actionId','hash','id','layerId','reason','revision']);
});
it('keeps the employee portal focused on the assigned letter and requires signature consent',async()=>{
 const value=letter();actions.letter.mockResolvedValue({ok:true,value:{letter:{...value,state:'released',valuesFixed:true,pendingAction:null,releasedAt:'2026-11-17T00:00:00Z'},document}});
 mount(<SharedLetterPage letter={value} document={document}/>);
 expect(screen.queryByRole('link',{name:'Open Personnel record'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Accept and sign contract'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Type your full name'),{target:{value:'Fictional Employee'}});
 expect(screen.getByRole('button',{name:'Accept and sign contract'})).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:'I confirm this is my signature and agree to sign this contract.'}));
 fireEvent.click(screen.getByRole('button',{name:'Accept and sign contract'}));
 await waitFor(()=>expect(actions.letter).toHaveBeenCalledOnce());
 expect(actions.letter).toHaveBeenCalledWith(expect.objectContaining({id,stepId:'employee',revision:1,hash,action:'signed',method:'typed',value:'Fictional Employee',consent:true}));
 expect(await screen.findByText(/Released 17\/11\/2026/)).toBeInTheDocument();
});
it('requires a send-back reason and offers owner resend only after the native owner grants it',async()=>{
 const value={...letter(),pendingAction:{stepId:'reviewer',kind:'review' as const}};
 actions.letter.mockResolvedValue({ok:true,value:{letter:{...value,returned:true,pendingAction:null},document}});
 const mounted=mount(<SharedLetterPage letter={value} document={document}/>);
 expect(screen.getByRole('button',{name:'Send back to owner'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Comment / reason for sending back'),{target:{value:'Please correct the wording.'}});
 fireEvent.click(screen.getByRole('button',{name:'Send back to owner'}));
 await waitFor(()=>expect(actions.letter).toHaveBeenCalledWith(expect.objectContaining({action:'returned',comment:'Please correct the wording.'})));
 expect(screen.queryByRole('button',{name:'Resend letter'})).not.toBeInTheDocument();
 mounted.unmount();
 mount(<SharedLetterPage letter={{...value,returned:true,canResend:true,pendingAction:null,layers:[{id:'owner',label:'People BP',stage:1,kind:'review',owner:true,assigneeName:'Fictional BP',fulfilled:false,unavailable:false}]}} document={document}/>);
 expect(screen.getByRole('button',{name:'Resend letter'})).toBeEnabled();
});
it('does not expose wording or actions while the body is held for a later routing step',()=>{
 mount(<SharedLetterPage letter={{...letter(),pendingAction:null,contentHash:null}} document={null}/>);
 expect(screen.getByText(/body becomes available when your routing step is active/)).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Accept and sign contract'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Edit wording for this case'})).not.toBeInTheDocument();
 expect(screen.queryByRole('link',{name:'Download PDF'})).not.toBeInTheDocument();
});
it('reuses the same approval command after a transport failure while keeping the reason',async()=>{
 actions.approval.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({ok:false,error:'Already received; refresh the current decision.'});
 mount(<SharedApprovalPage approval={approval()}/>);
 fireEvent.change(screen.getByLabelText('Comment / reason for rejection'),{target:{value:'Please confirm these dates.'}});
 fireEvent.click(screen.getByRole('button',{name:'Reject and return decision'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Your entries are still here.');
 fireEvent.click(screen.getByRole('button',{name:'Reject and return decision'}));
 await waitFor(()=>expect(actions.approval).toHaveBeenCalledTimes(2));
 expect(actions.approval.mock.calls[1][0]).toEqual(actions.approval.mock.calls[0][0]);
 expect(screen.getByLabelText('Comment / reason for rejection')).toHaveValue('Please confirm these dates.');
});
it('submits wording and completing review as one command and retains both after a transport failure',async()=>{
 const value:ContractSharedLetter={...letter(),canEdit:true,pendingAction:{stepId:'reviewer',kind:'review'},body:{definition:{name:'Fictional renewal letter',blocks:[{id:'intro',type:'text',text:'Original wording',section:''}],fields:[]},blocks:{intro:'Original wording'},values:{},receipts:[],fingerprintSource:'native'}};
 actions.letter.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({ok:true,value:{letter:{...value,canEdit:false,pendingAction:null},document}});
 mount(<SharedLetterPage letter={value} document={document}/>);
 fireEvent.click(screen.getByRole('button',{name:'Edit wording for this case'}));
 fireEvent.change(screen.getByLabelText('Letter text'),{target:{value:'Reviewed wording'}});
 expect(screen.queryByRole('button',{name:'Save wording'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Complete review and save wording'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Your entries are still here.');
 expect(screen.getByLabelText('Letter text')).toHaveValue('Reviewed wording');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Complete review and save wording'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Complete review and save wording'}));
 await waitFor(()=>expect(actions.letter).toHaveBeenCalledTimes(2));
 expect(actions.letter.mock.calls[0][0]).toMatchObject({action:'reviewed',blocks:{intro:'Reviewed wording'},revision:1,hash});
 expect(actions.letter.mock.calls[1][0]).toEqual(actions.letter.mock.calls[0][0]);expect(actions.edit).not.toHaveBeenCalled();
});
it('uses company signature consent only for the current native company step',()=>{
 mount(<SharedLetterPage letter={{...letter(),pendingAction:{stepId:'bp',kind:'sign'},layers:[{id:'bp',label:'People BP',stage:1,kind:'sign',owner:true,assigneeName:'Fictional BP',fulfilled:false,unavailable:false}]}} document={document} capabilities={{canBindEmployee:false,pendingRole:'company'}}/>);
 expect(screen.getByRole('checkbox',{name:'I confirm this is my signature and approve this letter on behalf of the company.'})).not.toBeChecked();
 expect(screen.getByRole('button',{name:'Sign letter'})).toBeDisabled();expect(screen.getByText('Fictional BP',{selector:'strong'})).toBeInTheDocument();
});

it('releases setup controls after a failed native job instead of showing installation forever',async()=>{
 vi.useFakeTimers();
 const setup={installed:false,v9Ready:true,jobId:id,canInstall:true,missing:[],groups:[{id:'ops',name:'Actual People Ops'}],routings:[]};
 actions.setup.mockResolvedValue({ok:true,value:{...setup,jobState:'failed'}});
 try{
  mount(<ContractStartingSetup initial={setup} companyId={caseId} fallbackGroupId="ops" postingApproverGroupId="ops"/>);
  expect(screen.getByLabelText('Fallback / People Ops group')).toBeDisabled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
  expect(screen.getByRole('alert')).toHaveTextContent('stopped before completion');
  expect(screen.getByLabelText('Fallback / People Ops group')).toBeEnabled();
  expect(screen.queryByRole('button',{name:'Installing starting configuration…'})).not.toBeInTheDocument();
 }finally{vi.useRealTimers();}
});

it('records employee decline with the current case revision and retains notes after a rejected action',async()=>{
 actions.decline.mockResolvedValue({ok:false,error:'The employee already signed. Reload the current case.'});
 mount(<ContractDecline caseId={caseId} revision={9} reasons={[{code:'contract_expiry',label:'Contract expiry'}]}/>);
 expect(screen.getByRole('button',{name:'Record employee decline'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Personnel termination reason'),{target:{value:'contract_expiry'}});
 fireEvent.change(screen.getByLabelText('Decline notes'),{target:{value:'Employee confirmed they will leave.'}});
 fireEvent.click(screen.getByRole('button',{name:'Record employee decline'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('already signed');
 expect(actions.decline).toHaveBeenCalledWith({caseId,revision:9,reason:'contract_expiry',notes:'Employee confirmed they will leave.'});
 expect(screen.getByLabelText('Decline notes')).toHaveValue('Employee confirmed they will leave.');
});

it('holds Form completion while the real response and receipt owner is unavailable',()=>{
 const value:ContractSharedLetter={...letter(),canEdit:true,body:{definition:{name:'Held Form',blocks:[{id:'answers',type:'fields',text:'',section:''}],fields:[]},blocks:{},values:{},receipts:[],fingerprintSource:'native'}};
 mount(<SharedLetterPage letter={value} document={document}/>);
 expect(screen.getByText('Form response capture and signing are on hold. This Form cannot be completed yet.')).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Accept and sign contract'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Edit wording for this case'})).not.toBeInTheDocument();
});

it('requires manual Payroll attestation and uses the exact native case receipt revision',async()=>{
 const summary={postingId:id,label:'PP-42',eventType:'contractRenewal' as const,status:'approved' as const,approverGroupName:'Actual posting approvers',approvedByName:'Recorded Approver',approvedAt:'2026-11-17T02:00:00Z',movementAppliedAt:null,effectiveDate:'2027-01-01',payConfirmedByName:null,payConfirmedAt:null,caseRevision:14,canConfirmPay:true};
 actions.pay.mockResolvedValue({ok:false,error:'The Contract posting changed. Review the latest receipt.'});
 mount(<ContractPostingReceipt caseId={caseId} summary={summary} today="2026-11-17" payChanges/>);
 expect(screen.getByText(/Current Personnel dates, contract number and employment type remain unchanged/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Confirm manual Payroll update'})).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:'I confirm that Payroll has been manually updated to match the approved terms.'}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm manual Payroll update'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('posting changed');expect(actions.pay).toHaveBeenCalledWith({caseId,expectedRevision:14,confirmed:true});
 expect(screen.getByRole('checkbox')).toBeChecked();
});
