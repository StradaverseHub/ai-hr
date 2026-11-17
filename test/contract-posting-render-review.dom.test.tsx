/** Hosted Chromium evidence for actual posting components and authorized fictional DTOs.
 * This is component capture, not an authenticated installed route or release acceptance. */
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ContractPostingsWorkspace} from '../app/lifecycle/contracts/postings/postings-workspace';
import {ContractPostingEditor} from '../app/lifecycle/contracts/postings/posting-editor';
import {ContractPostingReceipt} from '../app/lifecycle/contracts/posting-receipt';
import {SharedContractNavigation} from '../app/lifecycle/contracts/shared-case-ui';
import type {ContractSharedPosting,ContractSharedPostingSummary} from '../packs/contracts/service';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/contracts/postings',useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/lifecycle/contracts/postings/actions',()=>({approveContractPostingAction:vi.fn(),confirmContractPayrollAction:vi.fn(),saveContractPostingAction:vi.fn(async()=>null)}));
vi.mock('../app/lifecycle/contracts/shared-actions',()=>({confirmSharedPay:vi.fn()}));
const id='c3349db4-823d-4eb5-874c-4b7f58ff56fd',caseId='f1210152-ab03-4b02-996d-84dd90849ab0';
function posting():ContractSharedPosting{return {id,number:1041,label:'PP-1041',companyId:'887fb29d-4236-42f7-8f75-f560261a0475',companyName:'Fictional Example Company',employmentId:'2a8e9db2-9404-4777-b34a-1f5e4ba9c001',employeeName:'Fictional Alex Tan',employeeCode:'EXAMPLE-041',caseId,caseNumber:'CT-FICTIONAL-41',eventType:'contractRenewal',proposed:{effectiveDate:'2027-01-01',previousEndDate:'2026-12-31',endDate:'2027-06-30',contractNumber:'5'},edited:null,current:{effectiveDate:'2027-01-01',previousEndDate:'2026-12-31',endDate:'2027-06-30',contractNumber:'5'},status:'pending',revision:1,approverGroupName:'Fictional People Ops',createdAt:'2026-11-17T00:00:00Z',editedAt:null,approvedAt:null,movementAppliedAt:null,canApprove:true,canEdit:true,caseRevision:8,canConfirmPay:false,payChanges:true};}
function mount(node:React.ReactNode){return render(<NextIntlClientProvider locale="en" messages={en}><main className="v9-workspace">{node}</main></NextIntlClientProvider>);}
async function capture(container:HTMLElement,section:'contract-postings'|'contract-posting-editor'|'contract-pay-confirmation'){
 expect(container.textContent).toContain('Fictional');
 await captureAiReviewScreenshots(aiReviewDomHtml(container),'en',section,'Actual posting React components and CSS; authorized fictional posting-group DTOs; no authentication, Personnel or Payroll action performed','atelier');
}
afterEach(cleanup);
it('captures pending inline corrections and approved scheduled pay work on desktop and mobile',async()=>{
 const row=posting(),approved={...row,id:'d3349db4-823d-4eb5-874c-4b7f58ff56fd',label:'PP-1042',number:1042,status:'approved' as const,canApprove:false,canEdit:false,canConfirmPay:true};
 const view=mount(<ContractPostingsWorkspace page={{rows:[row,approved],total:2,offset:0,limit:50}} status="all" today="2026-11-17"/>);
 const details=screen.getByText('Correct values here').closest('details')!;details.open=true;
 expect(screen.getByLabelText('New contract end')).toHaveValue('2027-06-30');
 expect(screen.getByText('Scheduled for 01/01/2027')).toBeInTheDocument();
 await capture(view.container,'contract-postings');
},120000);
it('captures the actual Personnel editor with agreement constraints and exact queue return link',async()=>{
 const row=posting(),view=mount(<ContractPostingEditor posting={row}/>);
 expect(screen.getByRole('link',{name:'Back to Personnel postings'})).toHaveAttribute('href',`/lifecycle/contracts/postings?status=pending&postingId=${id}`);
 expect(screen.getByText(/Dates and the contract number must match the released agreement/)).toBeInTheDocument();
 await capture(view.container,'contract-posting-editor');
},120000);
it('captures explicit manual Payroll attestation and links its exact historical posting',async()=>{
 const summary:ContractSharedPostingSummary={postingId:id,label:'PP-1041',eventType:'contractConversion',status:'approved',approverGroupName:'Fictional People Ops',approvedByName:'Fictional Approver',approvedAt:'2026-11-17T02:00:00Z',movementAppliedAt:'2026-11-17T02:00:00Z',effectiveDate:'2026-11-17',payConfirmedByName:null,payConfirmedAt:null,caseRevision:14,canConfirmPay:true};
 const view=mount(<div className="v9-content"><SharedContractNavigation/><header className="v9-heading"><h1>Contract Management</h1></header><ContractPostingReceipt caseId={caseId} summary={summary} today="2026-11-17" payChanges/></div>);
 expect(screen.getByRole('button',{name:'Confirm manual Payroll update'})).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:'I confirm that Payroll has been manually updated to match the approved terms.'}));
 expect(screen.getByRole('button',{name:'Confirm manual Payroll update'})).toBeEnabled();
 expect(screen.getByRole('link',{name:'Open Personnel postings'})).toHaveAttribute('href',`/lifecycle/contracts/postings?status=approved&postingId=${id}`);
 await capture(view.container,'contract-pay-confirmation');
},120000);
