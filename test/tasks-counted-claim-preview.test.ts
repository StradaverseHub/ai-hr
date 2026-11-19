import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import {TaskDocuments} from '../components/lifecycle-v9/task-documents';
import type {LifecycleTaskDocument} from '../lib/lifecycle-task-documents';
import messages from '../messages/en.json';
const state=vi.hoisted(()=>({session:{tenantId:'fictional-tenant',userId:'fictional-viewer'},recruitment:false,preview:vi.fn(),full:vi.fn(),onboarding:vi.fn(),resignations:vi.fn(),contracts:vi.fn(),documents:vi.fn(),cardDocuments:vi.fn(),view:vi.fn()}));
vi.mock('@/lib/scope',()=>({scopedSession:async()=>({s:state.session,scopeIds:['selected-company']})}));
vi.mock('@/core/entitlements',()=>({isModuleEnabledOrFalse:(_ctx:unknown,module:string)=>module==='claims'||module==='lifecycle'||module==='recruitment'&&state.recruitment}));
vi.mock('@/core/approvals-inbox',()=>({myTaskSummary:state.preview,pendingTaskSummary:state.full,listPendingTasks:state.full}));
vi.mock('@/packs/contracts/service',()=>({contractSharedWorkPage:state.contracts}));
vi.mock('@/packs/lifecycle/service',()=>({onboardingTasks:state.onboarding,resignationInbox:state.resignations,lifecycleTaskDocuments:state.documents,lifecycleTaskCardDocuments:state.cardDocuments}));
vi.mock('../app/lifecycle/workflow-availability',()=>({lifecycleModuleNavigation:async()=>({})}));
vi.mock('../app/lifecycle/module-inbox',()=>({lifecycleModuleInbox:async()=>({items:[],count:0,myTasksCount:0,queueLinks:[],approvalCount:0})}));
vi.mock('../app/tasks/tasks-view',()=>({TasksView:(props:{existing:unknown[];existingTotal:number;claimTotal:number})=>{
 state.view(props);return React.createElement('div',{'data-preview-rows':props.existing.length,'data-task-total':props.existingTotal,'data-claim-total':props.claimTotal});
}}));
import Page from '../app/tasks/page';
beforeEach(()=>{vi.clearAllMocks();state.recruitment=false;state.documents.mockResolvedValue({items:[],total:0,offset:0,limit:50});state.cardDocuments.mockResolvedValue([]);state.contracts.mockResolvedValue({items:[],total:0,countsByKind:{},approvalTotal:0,taskTotal:0,limit:25,offset:0,hasMore:false});state.full.mockImplementation(()=>{throw Error('Unbounded task transport must not run.');});state.onboarding.mockResolvedValue([]);state.resignations.mockResolvedValue({items:[],cases:[],total:0,actionableTotal:0,fyiTotal:0,counts:{all:0,assigned:0,tagged:0,team:0,overdue:0}});});
it('keeps the global assigned-work scope and transports a counted Claims preview rather than every request',async()=>{
 const items=Array.from({length:25},(_,i)=>({id:'claim-'+i,kind:'claim'}));
 state.preview.mockResolvedValue({items,total:500000,claimTotal:500000});
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
 expect(state.preview).toHaveBeenCalledWith(state.session,['selected-company'],{attendance:false,claims:true,performance:false,rewards:false,recruitment:false,probation:true});
 expect(state.resignations).toHaveBeenCalledWith(state.session,{kind:'tasks',companyIds:['selected-company'],limit:25,offset:0,filter:'all'});
 expect(state.full).not.toHaveBeenCalled();expect(state.view).toHaveBeenCalledWith(expect.objectContaining({existing:items,existingTotal:500000,claimTotal:500000}));
 expect(html).toContain('data-preview-rows="25"');expect(html).toContain('data-task-total="500000"');
});

it('preserves Recruitment company scope and independent counted resignation totals alongside bounded previews',async()=>{
 state.recruitment=true;
 const existing=[{id:'screening-1',kind:'recruitmentScreening'}],resignations=[{id:'letter-1:ceo',kind:'sign'}];
 state.preview.mockResolvedValue({items:existing,total:700,claimTotal:0});
 state.resignations.mockResolvedValue({items:resignations,total:900,cases:[],counts:{all:900,assigned:100,tagged:0,team:800,overdue:12}});
 renderToStaticMarkup(await Page());
 expect(state.preview).toHaveBeenCalledWith(state.session,['selected-company'],expect.objectContaining({recruitment:true}));
 expect(state.resignations).toHaveBeenCalledWith(state.session,{kind:'tasks',companyIds:['selected-company'],limit:25,offset:0,filter:'all'});
 expect(state.view).toHaveBeenCalledWith(expect.objectContaining({existing,existingTotal:700,resignationTasks:resignations,resignationTotal:900,resignationCounts:{all:900,assigned:100,tagged:0,team:800,overdue:12}}));
 expect(state.full).not.toHaveBeenCalled();
});

it('keeps Contract and Resignation counted work independently paged without reloading the full inbox',async()=>{
 const existing=[{id:'claim-1',kind:'claim'}],contractItems=[{id:'contract-sign-1',kind:'signature'}],resignationItems=[{id:'resignation-sign-1',kind:'sign'}];
 state.preview.mockResolvedValue({items:existing,total:400,claimTotal:400});
 state.contracts.mockResolvedValue({items:contractItems,total:850});
 state.resignations.mockResolvedValue({items:resignationItems,total:930,counts:{all:930,assigned:300,tagged:20,team:610,overdue:12}});
 renderToStaticMarkup(await Page({searchParams:Promise.resolve({contractPage:'3',contractSize:'50',resignationPage:'2',resignationSize:'25',taskView:'assigned'})}));
 expect(state.contracts).toHaveBeenCalledWith(state.session,{category:'tasks',limit:50,offset:150});
 expect(state.resignations).toHaveBeenCalledWith(state.session,{kind:'tasks',companyIds:['selected-company'],limit:25,offset:50,filter:'assigned'});
 expect(state.view).toHaveBeenCalledWith(expect.objectContaining({existing,existingTotal:400,contractTotal:850,resignationTasks:resignationItems,resignationTotal:930,initialFilter:'assigned'}));
 const props=state.view.mock.calls[0][0];
 expect(props.contractSection.props).toMatchObject({items:contractItems,total:850});
 expect(props.contractSection.props.pager.props).toMatchObject({basePath:'/tasks',params:{taskView:'assigned',resignationPage:'2',resignationSize:'25',documentsPage:undefined},paramNames:{page:'contractPage',size:'contractSize'}});
 expect(props.resignationPager.props).toMatchObject({basePath:'/tasks',params:{taskView:'assigned',contractPage:'3',contractSize:'50',documentsPage:undefined},paramNames:{page:'resignationPage',size:'resignationSize'}});
 expect(state.full).not.toHaveBeenCalled();

});

it('loads exact native card links independently of document-list pagination without changing other task totals',async()=>{
 const items=Array.from({length:61},(_,i)=>({id:'case:checklist:task-'+i,kind:'checklist',caseId:'case',taskId:'task-'+i,documentTemplate:'template-'+i}));
 const cards=items.map((item,i)=>({caseId:item.caseId,taskId:item.taskId,documentId:'saved-'+i,state:i===60?'unreleased':'released'}));
 state.onboarding.mockResolvedValue(items);state.cardDocuments.mockResolvedValue(cards);state.preview.mockResolvedValue({items:[],total:13,claimTotal:7});
 state.documents.mockImplementation((_ctx:unknown,input:{offset:number})=>Promise.resolve({items:cards.slice(input.offset,input.offset+50),total:cards.length,offset:input.offset,limit:50}));
 renderToStaticMarkup(await Page({searchParams:Promise.resolve({documentsPage:'0'})}));
 const first=state.view.mock.calls.at(-1)![0] as {cardDocuments:unknown[];documents:{items:unknown[]}};
 renderToStaticMarkup(await Page({searchParams:Promise.resolve({documentsPage:'1'})}));
 const second=state.view.mock.calls.at(-1)![0] as {cardDocuments:unknown[];documents:{items:unknown[]}};
 expect(state.cardDocuments).toHaveBeenNthCalledWith(1,state.session,{companyIds:['selected-company'],refs:items.map(item=>({caseId:item.caseId,taskId:item.taskId}))});
 expect(first.cardDocuments).toEqual(cards);expect(second.cardDocuments).toEqual(cards);expect(first.documents.items).toHaveLength(50);expect(second.documents.items).toHaveLength(11);
 expect(state.view).toHaveBeenLastCalledWith(expect.objectContaining({existingTotal:13,claimTotal:7,items}));
});

it('preserves Contract, Resignation and task filters across every document page link',async()=>{
 state.preview.mockResolvedValue({items:[],total:400,claimTotal:400});
 state.contracts.mockResolvedValue({items:[],total:850});state.resignations.mockResolvedValue({items:[],total:930,counts:{all:930,assigned:300,tagged:20,team:610,overdue:12}});
 renderToStaticMarkup(await Page({searchParams:Promise.resolve({contractPage:'3',contractSize:'50',resignationPage:'2',resignationSize:'25',taskView:'assigned',documentsPage:'1'})}));
 const props=state.view.mock.calls[0]?.[0];if(!props)throw Error('Expected the actual My tasks page props');
 expect(props.contractSection.props.pager.props.params).toEqual({taskView:'assigned',resignationPage:'2',resignationSize:'25',documentsPage:'1'});
 expect(props.resignationPager.props.params).toEqual({taskView:'assigned',contractPage:'3',contractSize:'50',documentsPage:'1'});
 expect(props.documentPaginationParams).toEqual({taskView:'assigned',contractPage:'3',contractSize:'50',resignationPage:'2',resignationSize:'25'});
 const items:LifecycleTaskDocument[]=Array.from({length:50},(_,index)=>({caseId:'fictional-case',module:'onb',caseNumber:'ONB-FICTIONAL',revision:1,taskId:null,taskName:null,taskStatus:null,dueOn:null,action:null,sourceName:'Documents from HR',sourceKind:'document',documentId:'saved-'+index,documentName:'Released document '+index,documentStatus:'sent',state:'released'}));
 const html=renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale:'en',timeZone:'Asia/Kuala_Lumpur',messages,children:React.createElement(TaskDocuments,{page:{items,total:151,offset:50,limit:50},paginationParams:props.documentPaginationParams})}));
 for(const page of ['0','2'])expect(html).toContain('href="/tasks?taskView=assigned&amp;contractPage=3&amp;contractSize=50&amp;resignationPage=2&amp;resignationSize=25&amp;documentsPage='+page+'"');
 expect(state.documents).toHaveBeenCalledWith(state.session,{companyIds:['selected-company'],offset:50});expect(state.full).not.toHaveBeenCalled();
});
