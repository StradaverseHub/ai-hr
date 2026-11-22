import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {ContractWorkflowEditor} from '../app/lifecycle/contracts/workflows/editor';
import ContractWorkflowPage from '../app/lifecycle/contracts/workflows/page';
import {defaultContractWorkflows} from '../lib/contract-management-workflow';
const owners=vi.hoisted(()=>({session:{tenantId:'fictional',userId:'group-hr'},workspace:vi.fn(),
 legacyDirectory:vi.fn(),search:vi.fn(),availability:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('@/lib/scoped-lifecycle-page',()=>({requireScopedLifecycleModule:()=>owners.session}));
vi.mock('@/packs/contracts/service',()=>({canConfigureContractWorkflows:()=>true,
 contractWorkflowWorkspace:owners.workspace,contractDirectory:owners.legacyDirectory}));
vi.mock('../app/lifecycle/workflow-availability',()=>({lifecycleWorkflowAvailability:owners.availability}));
vi.mock('../app/lifecycle/workflow-module-navigation',()=>({WorkflowModuleNavigation:()=>null}));
vi.mock('../app/lifecycle/contracts/workflows/actions',()=>({saveWorkflowAction:vi.fn(),previewWorkflowAction:vi.fn(),
 searchContractReviewersAction:owners.search}));
let counter=0;const id=()=>`10000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`;
it('loads reviewers only for the selected Contract company and searches through its owner',async()=>{
 const companyA=id(),companyB=id(),ids=[id(),id(),id(),id(),id()],reviewer=id();
 const drafts=defaultContractWorkflows(ids,id),load=vi.fn().mockResolvedValue({ok:true,result:[]});
 const notice=drafts[0].steps.find(step=>step.type==='notify');
 if(notice)notice.to=[{type:'named_employee',userIds:[reviewer]}];
 const rows=drafts.slice(0,2).map((draft,index)=>({id:draft.id,companyId:index?companyB:companyA,revision:1,draft,publishedVersion:null,enabled:true,required:true}));
 render(<NextIntlClientProvider locale="en" messages={messages}><ContractWorkflowEditor embedded workflows={rows} companies={[{id:companyA,name:'Company A'},{id:companyB,name:'Company B'}]} cases={[]} directories={[]} loadDirectory={load}/></NextIntlClientProvider>);
 await waitFor(()=>expect(load).toHaveBeenCalledOnce());
 expect(load.mock.calls[0][0]).toEqual({companyId:companyA,query:'',selectedUserIds:[reviewer]});
 fireEvent.change(screen.getByRole('textbox',{name:'Find named reviewers'}),{target:{value:'Fictional'}});
 fireEvent.click(screen.getByRole('button',{name:'Find reviewers'}));
 await waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
 expect(load.mock.calls[1][0]).toMatchObject({companyId:companyA,query:'Fictional'});
 expect(load.mock.calls.some(call=>call[0].companyId===companyB)).toBe(false);
});

it('renders the direct route for 70 companies without reading every reviewer directory',async()=>{
 const companies=Array.from({length:70},(_,index)=>({id:id(),name:`Fictional Company ${index+1}`}));
 const draft=defaultContractWorkflows([id(),id(),id(),id(),id()],id)[0];
 const row={id:draft.id,companyId:companies[0].id,revision:1,draft,publishedVersion:null,enabled:true,required:true};
 owners.workspace.mockResolvedValue({workflows:[row],companies,cases:[],businessGroups:[]});
 owners.availability.mockResolvedValue({});
 owners.search.mockResolvedValue({ok:true,result:[]});

 const view=await ContractWorkflowPage();
 expect(owners.workspace).toHaveBeenCalledExactlyOnceWith(owners.session);
 expect(owners.legacyDirectory).not.toHaveBeenCalled();
 expect(owners.search).not.toHaveBeenCalled();

 render(<NextIntlClientProvider locale="en" messages={messages}>{view}</NextIntlClientProvider>);
 expect(owners.search).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole('textbox',{name:'Find named reviewers'}),{target:{value:'Fictional'}});
 fireEvent.click(screen.getByRole('button',{name:'Find reviewers'}));
 await waitFor(()=>expect(owners.search).toHaveBeenCalledExactlyOnceWith({
  companyId:companies[0].id,query:'Fictional',selectedUserIds:[],
 }));
});
