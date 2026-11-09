import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({session:{tenantId:'fictional-tenant',userId:'fictional-viewer'},preview:vi.fn(),full:vi.fn(),onboarding:vi.fn(),view:vi.fn()}));
vi.mock('@/lib/scope',()=>({scopedSession:async()=>({s:state.session,scopeIds:['selected-company']})}));
vi.mock('@/core/entitlements',()=>({isModuleEnabledOrFalse:(_ctx:unknown,module:string)=>module==='claims'||module==='lifecycle'}));
vi.mock('@/core/approvals-inbox',()=>({pendingTaskSummary:state.preview,listPendingTasks:state.full}));
vi.mock('@/packs/lifecycle/service',()=>({onboardingTasks:state.onboarding}));
vi.mock('../app/lifecycle/workflow-availability',()=>({lifecycleModuleNavigation:async()=>({})}));
vi.mock('../app/lifecycle/module-inbox',()=>({lifecycleModuleInbox:async()=>({items:[],count:0})}));
vi.mock('../app/tasks/tasks-view',()=>({TasksView:(props:{existing:unknown[];existingTotal:number;claimTotal:number})=>{
 state.view(props);return React.createElement('div',{'data-preview-rows':props.existing.length,'data-task-total':props.existingTotal,'data-claim-total':props.claimTotal});
}}));
import Page from '../app/tasks/page';
beforeEach(()=>{vi.clearAllMocks();state.full.mockImplementation(()=>{throw Error('Unbounded task transport must not run.');});state.onboarding.mockResolvedValue([]);});
it('keeps the global assigned-work scope and transports a counted Claims preview rather than every request',async()=>{
 const items=Array.from({length:25},(_,i)=>({id:'claim-'+i,kind:'claim'}));
 state.preview.mockResolvedValue({items,total:500000,claimTotal:500000});
 const html=renderToStaticMarkup(await Page());
 expect(state.preview).toHaveBeenCalledWith(state.session,undefined,{attendance:false,claims:true,performance:false,rewards:false});
 expect(state.full).not.toHaveBeenCalled();expect(state.view).toHaveBeenCalledWith(expect.objectContaining({existing:items,existingTotal:500000,claimTotal:500000}));
 expect(html).toContain('data-preview-rows="25"');expect(html).toContain('data-task-total="500000"');
});
