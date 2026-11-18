import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({session:{tenantId:'fictional-tenant',userId:'fictional-viewer'},preview:vi.fn(),full:vi.fn(),onboarding:vi.fn(),documents:vi.fn(),cardDocuments:vi.fn(),view:vi.fn()}));
vi.mock('@/lib/scope',()=>({scopedSession:async()=>({s:state.session,scopeIds:['selected-company']})}));
vi.mock('@/core/entitlements',()=>({isModuleEnabledOrFalse:(_ctx:unknown,module:string)=>module==='claims'||module==='lifecycle'}));
// Recruitment slice 9: the page reads myTaskSummary, which is pendingTaskSummary for every company (undefined scope) plus the
// recruitment to-dos for the switcher's selection; its own scope behaviour is proved in test/recruitment-tasks.test.ts.
vi.mock('@/core/approvals-inbox',()=>({myTaskSummary:state.preview,pendingTaskSummary:state.full,listPendingTasks:state.full}));
vi.mock('@/packs/lifecycle/service',()=>({onboardingTasks:state.onboarding,lifecycleTaskDocuments:state.documents,lifecycleTaskCardDocuments:state.cardDocuments}));
vi.mock('../app/lifecycle/workflow-availability',()=>({lifecycleModuleNavigation:async()=>({})}));
vi.mock('../app/lifecycle/module-inbox',()=>({lifecycleModuleInbox:async()=>({items:[],count:0})}));
vi.mock('../app/tasks/tasks-view',()=>({TasksView:(props:{existing:unknown[];existingTotal:number;claimTotal:number})=>{
 state.view(props);return React.createElement('div',{'data-preview-rows':props.existing.length,'data-task-total':props.existingTotal,'data-claim-total':props.claimTotal});
}}));
import Page from '../app/tasks/page';
beforeEach(()=>{vi.clearAllMocks();state.full.mockImplementation(()=>{throw Error('Unbounded task transport must not run.');});state.onboarding.mockResolvedValue([]);state.documents.mockResolvedValue({items:[],total:0,offset:0,limit:50});state.cardDocuments.mockResolvedValue([]);});
it('keeps the global assigned-work scope and transports a counted Claims preview rather than every request',async()=>{
 const items=Array.from({length:25},(_,i)=>({id:'claim-'+i,kind:'claim'}));
 state.preview.mockResolvedValue({items,total:500000,claimTotal:500000});
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
 expect(state.preview).toHaveBeenCalledWith(state.session,['selected-company'],{attendance:false,claims:true,performance:false,rewards:false,recruitment:false,probation:true});
 expect(state.full).not.toHaveBeenCalled();expect(state.view).toHaveBeenCalledWith(expect.objectContaining({existing:items,existingTotal:500000,claimTotal:500000}));
 expect(html).toContain('data-preview-rows="25"');expect(html).toContain('data-task-total="500000"');
});

it('loads exact native card links independently of document-list pagination without changing other task totals',async()=>{
 const items=Array.from({length:61},(_,i)=>({id:'case:checklist:task-'+i,kind:'checklist',caseId:'case',taskId:'task-'+i,documentTemplate:'template-'+i}));
 const cards=items.map((item,i)=>({caseId:item.caseId,taskId:item.taskId,documentId:'saved-'+i,state:i===60?'unreleased':'released'}));
 state.onboarding.mockResolvedValue(items);state.cardDocuments.mockResolvedValue(cards);state.preview.mockResolvedValue({items:[],total:13,claimTotal:7});
 state.documents.mockImplementation((_ctx:unknown,input:{offset:number})=>Promise.resolve({items:cards.slice(input.offset,input.offset+50),total:cards.length,offset:input.offset,limit:50}));
 await Page({searchParams:Promise.resolve({documentsPage:'0'})});
 const first=state.view.mock.calls.at(-1)![0] as {cardDocuments:unknown[];documents:{items:unknown[]}};
 await Page({searchParams:Promise.resolve({documentsPage:'1'})});
 const second=state.view.mock.calls.at(-1)![0] as {cardDocuments:unknown[];documents:{items:unknown[]}};
 expect(state.cardDocuments).toHaveBeenNthCalledWith(1,state.session,{companyIds:['selected-company'],refs:items.map(item=>({caseId:item.caseId,taskId:item.taskId}))});
 expect(first.cardDocuments).toEqual(cards);expect(second.cardDocuments).toEqual(cards);expect(first.documents.items).toHaveLength(50);expect(second.documents.items).toHaveLength(11);
 expect(state.view).toHaveBeenLastCalledWith(expect.objectContaining({existingTotal:13,claimTotal:7,items}));
});
