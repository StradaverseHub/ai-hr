import {readFileSync} from 'node:fs';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {expect,it,vi} from 'vitest';
import {OffboardingRequisitionView} from '../app/lifecycle/requisitions/offboarding/[id]/view';
import {RequestRecords} from '../app/lifecycle/v9/request-records';
import type {OffboardingRequisition} from '../lib/offboarding-requisition';
import type {Case} from '../lib/lifecycle-v9-model';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import messages from '../messages/en.json';
const update=vi.hoisted(()=>vi.fn());vi.mock('../app/lifecycle/requisitions/offboarding/[id]/actions',()=>({updateRequisitionItem:update}));
const item={id:'access',name:'Microsoft 365',kind:'system' as const,status:'todo' as const,reason:'',dueOn:'2026-12-01',groupId:'it',team:'IT',assigneeId:'person',assignee:'Alex Tan',canAct:true,catalogueId:'catalogue',providedBy:null};
const detail:OffboardingRequisition={id:'fictional-case',revision:4,number:'RVK-0042',caseNumber:'OFB9-0042',state:'submitted',fullView:true,exceptionsReviewed:false,name:'Sample leaver',businessGroup:'Fictional Group',position:'Analyst',lastDay:'2026-12-18',noticeDate:'2026-11-18',caseType:'Resignation',revokeMode:'date',revokeDate:'2026-12-01',items:[item,{...item,id:'laptop',name:'Laptop',kind:'device',status:'progress',dueOn:'2026-12-18'},{...item,id:'card',name:'Access card',kind:'device',status:'notReturned',reason:'HR review required',dueOn:'2026-12-18'}],clearedAt:null,activity:[{id:'activity',at:'2026-11-18T10:00:00Z',action:'requisition.itemAdded',detail:'Microsoft 365',itemStatus:'todo',actor:'Alex Tan'}]};
const wrap=(d=detail)=><NextIntlClientProvider locale="en" messages={messages}><OffboardingRequisitionView initial={d} today="2026-11-18"/></NextIntlClientProvider>;
it('shows the dedicated record, canonical dates, exception review and scoped case link',()=>{
 render(wrap());expect(screen.getByRole('heading',{name:'RVK-0042'})).toBeInTheDocument();expect(screen.getByRole('link',{name:'View offboarding case'})).toHaveAttribute('href','/lifecycle/v9?view=leavers&case=fictional-case');expect(screen.getByText('1 not returned — HR review required.')).toBeInTheDocument();expect(screen.getAllByText(/2026-12-01/).length).toBeGreaterThan(0);
});
it('submits the displayed revision and retains the page on a failed status update',async()=>{
 update.mockResolvedValue({ok:false});render(wrap({...detail,fullView:false,items:[item]}));expect(screen.queryByRole('link',{name:'View offboarding case'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Save item'}));await waitFor(()=>expect(update).toHaveBeenCalledWith({caseId:detail.id,revision:4,itemId:'access',status:'todo',reason:''}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('not saved'));expect(screen.getByRole('heading',{name:'Microsoft 365'})).toBeInTheDocument();
});
it('links existing RVK Request Records by canonical case UUID and uses the item completion timestamp',()=>{
 const c={id:'case-uuid',module:'off',number:'OFB9-0042',state:'submitted',facts:{name:'Sample leaver',title:'',businessGroup:'',company:'company',lastDay:'2026-12-18'},items:[{...item,status:'notReturned'}],tasks:[],itemsClearedAt:null,closedAt:'2030-01-01T00:00:00Z',review:null} as unknown as Case;
 render(<RequestRecords cases={[c]} native={null} labels={{}} company="" search="" openCase={()=>{throw Error('Must not open the case');}}/>);expect(screen.getByRole('link',{name:'RVK-0042'})).toHaveAttribute('href','/lifecycle/requisitions/offboarding/case-uuid');expect(screen.getByText('0 of 1 done')).toBeInTheDocument();expect(screen.queryByText('01/01/2030')).not.toBeInTheDocument();
});
it.each(['light','dark'] as const)('captures the actual RVK requisition component in %s on phone and desktop',async mode=>{
 const {container}=render(wrap());await captureAiReviewScreenshots(aiReviewDomHtml(container)+'<style>'+readFileSync('app/lifecycle/v9/workspace.css','utf8')+'</style>','en',`feedback-b472a445-rvk-${mode}`,'Actual requisition component, fictional record; canonical authorization and writes tested separately','classic',mode);
},30000);


it('keeps entered values and reports transport rejection while locking controls during submission',async()=>{
 let reject:(reason:Error)=>void=()=>{throw Error('Submission did not start');};
 update.mockImplementation(()=>new Promise((_resolve,rejectPromise)=>{reject=rejectPromise;}));
 render(wrap({...detail,fullView:false,items:[item]}));
 const reason=screen.getByRole('textbox',{name:'Reason / note (required for exceptions)'}),status=screen.getByRole('combobox',{name:'Status'});
 fireEvent.change(reason,{target:{value:'Keep this entered note'}});fireEvent.change(status,{target:{value:'progress'}});fireEvent.click(screen.getByRole('button',{name:'Save item'}));
 await waitFor(()=>expect(reason).toBeDisabled());expect(status).toBeDisabled();
 reject(Error('Connection lost'));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('not saved'));expect(reason).toHaveValue('Keep this entered note');expect(status).toHaveValue('progress');expect(reason).not.toBeDisabled();
});
