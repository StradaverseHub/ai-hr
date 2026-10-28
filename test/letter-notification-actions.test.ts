import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({scope:vi.fn(),enabled:vi.fn(),markAll:vi.fn(),onboarding:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:m.scope}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:m.enabled}));
vi.mock('../core/notifications',()=>({markAllNotificationsRead:m.markAll,markNotificationRead:vi.fn()}));
vi.mock('../packs/lifecycle/service',()=>({onboardingReadNotice:m.onboarding}));
vi.mock('next/cache',()=>({revalidatePath:m.revalidate}));
import {markAllNotificationsReadAction} from '../app/notification-actions';
const ctx={tenantId:'fixture',userId:'account-only-reviewer'},active='00000000-0000-4000-8000-000000000001',inactive='00000000-0000-4000-8000-000000000002';
beforeEach(()=>{vi.clearAllMocks();m.scope.mockResolvedValue({s:ctx,scopeIds:[active,inactive]});m.enabled.mockReturnValue(false);});
it('marks only the current entitled companies when Letters uses company-scoped notifications',async()=>{
 m.enabled.mockImplementation((_ctx:unknown,code:string,companyId?:string)=>code==='notifications'&&companyId===active);await markAllNotificationsReadAction();expect(m.markAll).toHaveBeenCalledExactlyOnceWith(ctx,undefined,{letterCompanyIds:[active]});expect(m.onboarding).not.toHaveBeenCalled();expect(m.revalidate).toHaveBeenCalledWith('/','layout');
});
it('keeps the established all-category behavior when the tenant-wide module is enabled',async()=>{
 m.enabled.mockImplementation((_ctx:unknown,code:string,companyId?:string)=>code==='notifications'&&!companyId);await markAllNotificationsReadAction();expect(m.markAll).toHaveBeenCalledExactlyOnceWith(ctx);
});
it('does not update notification rows when no selected company has an entitlement',async()=>{
 await markAllNotificationsReadAction();expect(m.markAll).not.toHaveBeenCalled();
});
