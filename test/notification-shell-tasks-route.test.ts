import {beforeEach,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';

const owner=vi.hoisted(()=>({
 session:vi.fn(),scope:vi.fn(),approval:vi.fn(),contract:vi.fn(),onboarding:vi.fn(),
 inbox:vi.fn(),enabled:vi.fn(),admission:vi.fn(),
}));
vi.mock('../db/client',()=>({
 withBackgroundReadWork:owner.admission,
 withSharedReadSnapshot:(_session:unknown,work:()=>Promise<unknown>)=>work(),
}));
vi.mock('../lib/session',()=>({getSession:owner.session}));
vi.mock('../lib/scope',()=>({companyContextForPage:owner.scope}));
vi.mock('../lib/shell-task-summary',()=>({readShellTaskSummary:owner.approval}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:owner.enabled}));
vi.mock('../packs/contracts/service',()=>({contractNavigationAccess:owner.contract}));
vi.mock('../packs/lifecycle/service',()=>({onboardingTasks:owner.onboarding}));
vi.mock('../app/lifecycle/module-inbox',()=>({lifecycleModuleInbox:owner.inbox}));

import {GET} from '../app/api/notifications/shell-tasks/route';

const session={tenantId:'tenant',userId:'viewer',roles:['employee']};
const request=()=>new Request('https://example.test/api/notifications/shell-tasks?company=ignored');

beforeEach(()=>{
 vi.resetAllMocks();
 owner.session.mockResolvedValue(session);
 owner.scope.mockResolvedValue({scopeIds:['selected-company']});
 owner.approval.mockResolvedValue({items:[{kind:'attendance'}],total:5,approvalCount:1,claimTotal:4});
 owner.contract.mockResolvedValue({page:true});
 owner.enabled.mockImplementation((_session,name)=>name==='claims'||name==='lifecycle');
 owner.onboarding.mockResolvedValue([{id:'onboarding',title:'Task',joiner:'Employee'}]);
 owner.inbox.mockResolvedValue({items:[],count:3,myTasksCount:2,approvalCount:1,queueLinks:[]});
 owner.admission.mockImplementation(async (_tenant,work,signal)=>{signal.throwIfAborted();return work();});
});

it('uses the current company selection and one cancellable passive permit with private counts',async()=>{
 const incoming=request();
 const response=await GET(incoming);
 expect(response.status).toBe(200);
 expect(response.headers.get('Cache-Control')).toBe('private, no-store');
 expect(owner.admission).toHaveBeenCalledExactlyOnceWith('tenant',expect.any(Function),incoming.signal);
 expect(owner.approval).toHaveBeenCalledExactlyOnceWith(session,['selected-company'],expect.objectContaining({claims:true}));
 expect(owner.inbox).toHaveBeenCalledExactlyOnceWith(session,{contractStaff:{page:true}});
 const payload=await response.json();
 expect(payload).toMatchObject({
  approvals:{state:'ready',total:5,claimTotal:4,lifecycleMyTasksCount:3,approvalCount:2,
   hasAssignedAttendanceApproval:true,hasAssignedApproval:true},
  lifecycle:{count:4,items:[{id:'onboarding',kind:'onboarding'}],queueLinks:[]},
 });
});

it('keeps the Lifecycle preview available if the approval owner fails',async()=>{
 owner.approval.mockRejectedValue(new Error('Fixture failure'));
 const response=await GET(request());
 expect(await response.json()).toMatchObject({approvals:{state:'unavailable'},lifecycle:{count:4}});
});

it('refuses requests with no authenticated session and skips disconnected reads',async()=>{
 owner.session.mockRejectedValueOnce(new AuthRequiredError());
 expect((await GET(request())).status).toBe(401);
 const controller=new AbortController();
 controller.abort();
 expect((await GET(new Request(request(),{signal:controller.signal}))).status).toBe(503);
 expect(owner.approval).not.toHaveBeenCalled();
 expect(owner.inbox).not.toHaveBeenCalled();
});
