/** Actual posting components, fictional authorized native DTOs; no Personnel/Payroll mutation is performed. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NavIndexProvider,usePublishNavIndex,type NavIndexEntry} from '../components/nav-index-context';
import {SharedContractNavigation} from '../app/lifecycle/contracts/shared-case-ui';
import type {ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
import {ContractPostingEditor} from '../app/lifecycle/contracts/postings/posting-editor';
import {ContractPostingsWorkspace} from '../app/lifecycle/contracts/postings/postings-workspace';
import type {ContractSharedPosting} from '../packs/contracts/service';
import {bulkJobNoticeKeys,parseBulkJobNoticeKey} from '../lib/bulk-job';
const actions=vi.hoisted(()=>({approve:vi.fn(),pay:vi.fn(),save:vi.fn(async()=>null),router:{refresh:vi.fn()}}));
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/contracts/postings',useRouter:()=>actions.router}));
vi.mock('../app/lifecycle/contracts/postings/actions',()=>({approveContractPostingAction:actions.approve,confirmContractPayrollAction:actions.pay,saveContractPostingAction:actions.save}));
function posting(state:'queued'|'applying'|'needs_review'):ContractSharedPosting{return {
 id:'c3349db4-823d-4eb5-874c-4b7f58ff56fd',number:1041,label:'PP-1041',companyId:'887fb29d-4236-42f7-8f75-f560261a0475',companyName:'Fictional Company',employmentId:'2a8e9db2-9404-4777-b34a-1f5e4ba9c001',employeeName:'Fictional Alex Tan',employeeCode:'EXAMPLE-041',caseId:'f1210152-ab03-4b02-996d-84dd90849ab0',caseNumber:'CT-FICTIONAL-41',eventType:'contractRenewal',proposed:{effectiveDate:'2027-01-01',previousEndDate:'2026-12-31',endDate:'2027-06-30',contractNumber:'5'},edited:null,current:{effectiveDate:'2027-01-01',previousEndDate:'2026-12-31',endDate:'2027-06-30',contractNumber:'5'},status:'pending',revision:1,approverGroupName:'Fictional People Ops',createdAt:'2026-11-17T00:00:00Z',editedAt:null,approvedAt:null,movementAppliedAt:null,canApprove:true,canEdit:true,caseRevision:8,canConfirmPay:false,payChanges:true,sourceCurrent:true,workflowReady:true,approvalApplication:{jobId:'a3349db4-823d-4eb5-874c-4b7f58ff56fd',state},
};}
function mount(node:ReactNode){return render(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);}
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it.each(['queued','applying'] as const)('keeps the actual editor read-only while Personnel application is %s',state=>{
 const row=posting(state);mount(<ContractPostingEditor posting={row}/>);
 expect(screen.getByRole('status')).toHaveTextContent(en.contractPostings[state==='queued'?'applicationQueued':'applicationApplying']);
 expect(screen.getByRole('status')).toHaveTextContent(en.contractPostings.applicationPendingRule);
 expect(screen.getByLabelText(en.contractPostings.effectiveDate)).toBeDisabled();expect(screen.getByLabelText(en.contractPostings.endDate)).toBeDisabled();
 expect(screen.queryByRole('button',{name:en.contractPostings.saveChanges})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:en.contractPostings.saveApprove})).not.toBeInTheDocument();
 expect(screen.queryByText(/Posting approved/)).not.toBeInTheDocument();expect(actions.save).not.toHaveBeenCalled();
});
it.each(['queued','applying'] as const)('keeps the queue pending and offers no duplicate approval or Payroll action while %s',state=>{
 const row=posting(state);mount(<ContractPostingsWorkspace page={{rows:[row],total:1,offset:0,limit:50}} status="pending" today="2026-11-17" saved="queued"/>);
 const item=within(screen.getByRole('row',{name:/PP-1041/}));
 expect(item.getByText(en.contractPostings[state==='queued'?'applicationQueued':'applicationApplying'])).toBeVisible();expect(item.getByText(en.contractPostings.applicationPendingRule)).toBeVisible();
 expect(screen.getByText(en.contractPostings.savedQueued)).toBeVisible();expect(item.queryByText(en.contractPostings.approved)).not.toBeInTheDocument();expect(item.queryByText(en.contractPostings.inlineEdit)).not.toBeInTheDocument();
 expect(item.queryByRole('button',{name:en.contractPostings.approve})).not.toBeInTheDocument();expect(item.queryByRole('button',{name:en.contractPostings.confirmPay})).not.toBeInTheDocument();expect(actions.approve).not.toHaveBeenCalled();expect(actions.pay).not.toHaveBeenCalled();
});
it('shows the application review hold without claiming an approved posting or changing the agreement',()=>{
 const row=posting('needs_review');mount(<ContractPostingEditor posting={row}/>);
 expect(screen.getByRole('status')).toHaveTextContent(en.contractPostings.applicationNeedsReview);expect(screen.getByLabelText(en.contractPostings.effectiveDate)).toHaveValue('2027-01-01');
 expect(screen.getByLabelText(en.contractPostings.effectiveDate)).toBeEnabled();expect(screen.getByRole('button',{name:en.contractPostings.saveApprove})).toBeEnabled();expect(actions.save).not.toHaveBeenCalled();
});
it('labels the queue review hold separately from approval and manual Payroll confirmation',()=>{
 const row=posting('needs_review');mount(<ContractPostingsWorkspace page={{rows:[row],total:1,offset:0,limit:50}} status="pending" today="2026-11-17"/>);
 const item=within(screen.getByRole('row',{name:/PP-1041/}));expect(item.getByText(en.contractPostings.applicationNeedsReview,{selector:'small[role="status"]'})).toBeVisible();expect(item.getByText(en.contractPostings.pending)).toBeVisible();expect(item.queryByText(en.contractPostings.approved)).not.toBeInTheDocument();expect(item.queryByRole('button',{name:en.contractPostings.confirmPay})).not.toBeInTheDocument();
});
it('uses canonical approved status only after the application actually finishes',()=>{
 const row={...posting('applying'),status:'approved' as const,approvedAt:'2026-11-17T02:00:00Z',canApprove:false,canEdit:false,approvalApplication:null};
 mount(<ContractPostingsWorkspace page={{rows:[row],total:1,offset:0,limit:50}} status="approved" today="2026-11-17"/>);
 const item=within(screen.getByRole('row',{name:/PP-1041/}));expect(item.getByText(en.contractPostings.approved)).toBeVisible();expect(item.getByText('Scheduled for 01/01/2027')).toBeVisible();expect(item.queryByText(en.contractPostings.applicationApplying)).not.toBeInTheDocument();expect(actions.approve).not.toHaveBeenCalled();
});
it.each(['completed','failed','cancelled'] as const)('registers a fixed queue notice and complete six-catalog captions for %s',outcome=>{
 const notice=bulkJobNoticeKeys('contract_posting_apply',outcome);expect(notice).toEqual({title:`bulkJobs.notification.contractPosting.${outcome}.title`,body:`bulkJobs.notification.contractPosting.${outcome}.body`,linkPath:'/lifecycle/contracts/postings'});
 expect(parseBulkJobNoticeKey(notice!.title)).toEqual({group:'contractPosting',outcome,part:'title'});
 for(const catalogue of [en,ms,ta,th,viMessages,zh]){expect(catalogue.bulkJobs.notification.contractPosting[outcome].title.trim()).not.toBe('');expect(catalogue.bulkJobs.notification.contractPosting[outcome].body.trim()).not.toBe('');}
});

it('uses one page refresh timer for multiple pending applications instead of one timer per posting',()=>{
 const interval=vi.spyOn(globalThis,'setInterval');const first=posting('queued'),second={...posting('applying'),id:'d3349db4-823d-4eb5-874c-4b7f58ff56fd',label:'PP-1042'};
 mount(<ContractPostingsWorkspace page={{rows:[first,second],total:2,offset:0,limit:50}} status="pending" today="2026-11-17"/>);
 expect(interval).toHaveBeenCalledTimes(1);expect(interval).toHaveBeenCalledWith(expect.any(Function),5000);expect(actions.router.refresh).not.toHaveBeenCalled();
});
it('replaces a stale draft when the actual native posting revision changes during refresh',()=>{
 const row=posting('needs_review');const view=mount(<ContractPostingEditor posting={row}/>);
 fireEvent.change(screen.getByLabelText(en.contractPostings.remarks),{target:{value:'Unsaved older draft'}});
 const corrected={...row,revision:row.revision+1,current:{...row.current,remarks:'Newer saved correction'}};
 view.rerender(<NextIntlClientProvider locale="en" messages={en}><ContractPostingEditor posting={corrected}/></NextIntlClientProvider>);
 expect(screen.getByLabelText(en.contractPostings.remarks)).toHaveValue('Newer saved correction');
 expect(view.container.querySelector('input[name="revision"]')).toHaveValue(String(corrected.revision));
 expect(actions.save).not.toHaveBeenCalled();
});

function PublishActualNavigation({entries}:{entries:readonly NavIndexEntry[]}){usePublishNavIndex(entries,null);return null;}
function navigationEntry(href:string):NavIndexEntry{return {href,label:href,section:'Ops',parent:'Contract Management',parentHref:null};}
function withNavigation(entries:readonly NavIndexEntry[],children:ReactNode){return <NextIntlClientProvider locale="en" messages={en}><NavIndexProvider><PublishActualNavigation entries={entries}/>{children}</NavIndexProvider></NextIntlClientProvider>;}
it('renders the actual group-only posting workspace with only its published permitted posting destination',()=>{
 const row=posting('needs_review');render(withNavigation([navigationEntry('/lifecycle/contracts/postings')],<ContractPostingsWorkspace page={{rows:[row],total:1,offset:0,limit:50}} status="pending" today="2026-11-17"/>));
 const navigation=within(screen.getByRole('navigation',{name:'Contract Management'}));expect(navigation.getAllByRole('link')).toHaveLength(1);expect(navigation.getByRole('link',{name:'Personnel postings'})).toHaveAttribute('href','/lifecycle/contracts/postings');expect(navigation.getByRole('link',{name:'Personnel postings'})).toHaveClass('v9-button-primary');
 expect(navigation.queryByRole('link',{name:'Contract cases'})).not.toBeInTheDocument();expect(navigation.queryByRole('link',{name:'Settings and access'})).not.toBeInTheDocument();expect(navigation.queryByRole('link',{name:'HR Automation'})).not.toBeInTheDocument();
});
it('follows real navigation-index updates and uses the actual shared Automation destination without a forced module filter',()=>{
 const view=render(withNavigation([navigationEntry('/lifecycle/contracts')],<SharedContractNavigation/>));
 expect(screen.getByRole('link',{name:'Contract cases'})).toHaveAttribute('href','/lifecycle/contracts');expect(screen.queryByRole('link',{name:'Settings and access'})).not.toBeInTheDocument();
 view.rerender(withNavigation([navigationEntry('/lifecycle/contracts/settings'),navigationEntry('/automation/workflows')],<SharedContractNavigation/>));
 expect(screen.queryByRole('link',{name:'Contract cases'})).not.toBeInTheDocument();expect(screen.getByRole('link',{name:'Settings and access'})).toHaveAttribute('href','/lifecycle/contracts/settings');expect(screen.getByRole('link',{name:'HR Automation'})).toHaveAttribute('href','/automation/workflows');
 view.rerender(withNavigation([navigationEntry('/tasks'),navigationEntry('/approvals')],<SharedContractNavigation/>));
 expect(screen.queryByRole('navigation',{name:'Contract Management'})).not.toBeInTheDocument();expect(view.container.querySelector('.v9-tabs')).toHaveAttribute('aria-hidden','true');expect(view.container.querySelector('.v9-tabs')).toHaveStyle({minHeight:'44px'});expect(view.container.querySelector('.v9-tabs a')).toBeNull();
});
