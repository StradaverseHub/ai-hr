import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({scope:vi.fn(),enabled:vi.fn(),markAll:vi.fn(),markOne:vi.fn(),bell:vi.fn(),onboarding:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:m.scope}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:m.enabled}));
vi.mock('../core/notifications',()=>({markAllNotificationsRead:m.markAll,markNotificationRead:m.markOne,notificationBellSummary:m.bell}));
vi.mock('../packs/lifecycle/service',()=>({onboardingReadNotice:m.onboarding}));
vi.mock('next/cache',()=>({revalidatePath:m.revalidate}));
import {markAllNotificationsReadAction,markNotificationReadAction} from '../app/notification-actions';
const ctx={tenantId:'fixture',userId:'account-only-reviewer'},active='00000000-0000-4000-8000-000000000001',inactive='00000000-0000-4000-8000-000000000002';
beforeEach(()=>{vi.clearAllMocks();m.scope.mockResolvedValue({s:ctx,scopeIds:[active,inactive]});m.enabled.mockReturnValue(false);m.bell.mockReset().mockResolvedValue({unread:0,items:[],tasks:[],read:[],taskCount:0});});
it('marks only the current entitled companies when Letters uses company-scoped notifications',async()=>{
 m.enabled.mockImplementation((_ctx:unknown,code:string,companyId?:string)=>code==='notifications'&&companyId===active);await markAllNotificationsReadAction();expect(m.markAll).toHaveBeenCalledExactlyOnceWith(ctx,undefined,{letterCompanyIds:[active]});expect(m.onboarding).not.toHaveBeenCalled();expect(m.bell).toHaveBeenCalledExactlyOnceWith(ctx,{letterCompanyIds:[active]});expect(m.revalidate).not.toHaveBeenCalled();
});
it('keeps the established all-category behavior when the tenant-wide module is enabled',async()=>{
 m.enabled.mockImplementation((_ctx:unknown,code:string,companyId?:string)=>code==='notifications'&&!companyId);await markAllNotificationsReadAction();expect(m.markAll).toHaveBeenCalledExactlyOnceWith(ctx);
});
it('does not update notification rows when no selected company has an entitlement',async()=>{
 await markAllNotificationsReadAction();expect(m.markAll).not.toHaveBeenCalled();
});

it('returns the post-commit bell snapshot for one read without invalidating the entire layout',async()=>{
 m.enabled.mockImplementation((_ctx:unknown,code:string)=>code==='notifications');
 const result=await markNotificationReadAction('fictional-notification');
 expect(m.markOne).toHaveBeenCalledExactlyOnceWith(ctx,'fictional-notification');
 expect(m.markOne.mock.invocationCallOrder[0]).toBeLessThan(m.bell.mock.invocationCallOrder[0]);
 expect(result).toEqual({unread:0,items:[],taskNotifications:[],notificationTaskCount:0,readItems:[]});
 expect(m.revalidate).not.toHaveBeenCalled();
});
it('can refresh the shell if a committed write succeeds and its narrow read fails',async()=>{
 m.enabled.mockImplementation((_ctx:unknown,code:string)=>code==='notifications');
 m.bell.mockRejectedValueOnce(Error('Fictional read failure'));
 expect(await markAllNotificationsReadAction()).toBeNull();
 expect(m.markAll).toHaveBeenCalledExactlyOnceWith(ctx);
 expect(m.revalidate).toHaveBeenCalledExactlyOnceWith('/','layout');
});
