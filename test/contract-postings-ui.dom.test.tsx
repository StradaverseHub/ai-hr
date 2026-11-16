import {beforeEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ContractPostingsWorkspace} from '../app/lifecycle/contracts/postings/postings-workspace';
import {ContractPostingEditor} from '../app/lifecycle/contracts/postings/posting-editor';
import type {ContractSharedPosting} from '../packs/contracts/service';
const actions=vi.hoisted(()=>({approve:vi.fn(),pay:vi.fn(),save:vi.fn()}));
vi.mock('../app/lifecycle/contracts/postings/actions',()=>({approveContractPostingAction:actions.approve,confirmContractPayrollAction:actions.pay,saveContractPostingAction:actions.save}));
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/contracts/postings'}));
function posting():ContractSharedPosting{return {id:'c3349db4-823d-4eb5-874c-4b7f58ff56fd',number:1001,label:'PP-1001',companyId:'887fb29d-4236-42f7-8f75-f560261a0475',companyName:'Fictional Contract Company',employmentId:'2a8e9db2-9404-4777-b34a-1f5e4ba9c001',employeeName:'Fictional Contract Employee',employeeCode:'CON-4',caseId:'f1210152-ab03-4b02-996d-84dd90849ab0',caseNumber:'CT-19',eventType:'contractRenewal',proposed:{effectiveDate:'2027-01-01',previousEndDate:'2026-12-31',endDate:'2027-06-30',contractNumber:'5'},edited:null,current:{effectiveDate:'2027-01-01',previousEndDate:'2026-12-31',endDate:'2027-06-30',contractNumber:'5'},status:'pending',revision:1,approverGroupName:'Fictional People Ops',createdAt:'2026-11-17T00:00:00Z',editedAt:null,approvedAt:null,movementAppliedAt:null,canApprove:true,canEdit:true,caseRevision:8,canConfirmPay:false,payChanges:true};}
function mount(ui:React.ReactNode){return render(<NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>);}
function queue(row:ContractSharedPosting){return <ContractPostingsWorkspace page={{rows:[row],total:1,offset:0,limit:50}} status={row.status} today="2026-11-17"/>;}
beforeEach(()=>{vi.clearAllMocks();actions.approve.mockResolvedValue(undefined);actions.pay.mockResolvedValue(undefined);actions.save.mockResolvedValue(null);});
it('opens the native Personnel Movement editor and submits only the displayed posting identity/revision',async()=>{
 const row=posting();mount(queue(row));
 expect(screen.getByRole('link',{name:'Edit event'})).toHaveAttribute('href',`/admin/personnel/${row.employmentId}/movement/new?posting=${row.id}`);
 expect(screen.queryByRole('button',{name:'Confirm Payroll entry'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Approve posting'}));
 await waitFor(()=>expect(actions.approve).toHaveBeenCalledOnce());
 const form=actions.approve.mock.calls[0][0] as FormData;
 expect([...form.entries()]).toEqual([['postingId',row.id],['revision','1']]);
 expect(screen.queryByText(/salaryCents|4976\.21|5200\.12/)).not.toBeInTheDocument();
});
it('separates scheduled Personnel application from the required manual Payroll attestation',async()=>{
 const row={...posting(),status:'approved' as const,revision:2,approvedAt:'2026-11-17T00:00:00Z',canApprove:false,canEdit:false,canConfirmPay:true};mount(queue(row));
 expect(screen.getByText('Scheduled for 01/01/2027')).toBeInTheDocument();
 expect(screen.getByText('Pay confirmation pending')).toBeInTheDocument();
 const declaration=screen.getByRole('checkbox',{name:'I have entered the agreed basic salary separately in Payroll.'});
 expect(declaration).toBeRequired();expect(declaration).not.toBeChecked();
 fireEvent.click(screen.getByRole('button',{name:'Confirm Payroll entry'}));expect(actions.pay).not.toHaveBeenCalled();
 fireEvent.click(declaration);fireEvent.click(screen.getByRole('button',{name:'Confirm Payroll entry'}));
 await waitFor(()=>expect(actions.pay).toHaveBeenCalledOnce());
 const form=actions.pay.mock.calls[0][0] as FormData;
 expect([...form.entries()]).toEqual([['postingId',row.id],['caseRevision','8'],['confirmed','on']]);
 expect(actions.approve).not.toHaveBeenCalled();
});
it('retains corrected values after a refused save and exposes no generic salary input',async()=>{
 actions.save.mockResolvedValue('The posting must match the released agreement.');mount(<ContractPostingEditor posting={posting()}/>);
 fireEvent.change(screen.getByLabelText('New contract end'),{target:{value:'2027-09-30'}});
 fireEvent.click(screen.getByRole('button',{name:'Save changes for approval'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('must match the released agreement');
 expect(screen.getByLabelText('New contract end')).toHaveValue('2027-09-30');
 expect(screen.queryByRole('spinbutton',{name:/salary/i})).not.toBeInTheDocument();
 const form=actions.save.mock.calls[0][1] as FormData;
 expect(form.get('postingId')).toBe(posting().id);expect(form.get('revision')).toBe('1');expect(form.get('endDate')).toBe('2027-09-30');
});
it('a conversion has no contract end/counter or new probation controls and a view-only posting cannot submit',()=>{
 const row={...posting(),eventType:'contractConversion' as const,current:{effectiveDate:'2027-01-01',previousEndDate:'2026-12-31'},canApprove:false,canEdit:false};mount(<ContractPostingEditor posting={row}/>);
 expect(screen.queryByLabelText('New contract end')).not.toBeInTheDocument();expect(screen.queryByLabelText('Contract number')).not.toBeInTheDocument();
 expect(screen.getByText(/does not create a new probation case/)).toBeInTheDocument();
 expect(screen.getByLabelText('New start / effective date')).toBeDisabled();expect(screen.queryByRole('button',{name:/Save/})).not.toBeInTheDocument();
});
