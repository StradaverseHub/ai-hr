/** Exercise the actual root layout with deferred owner reads: no database or wall-clock budget. */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';
import en from '../messages/en.json';
const state = vi.hoisted(() => ({
  path: '/', admin: true, modules: new Set(['notifications', 'lifecycle', 'employees']),
  session: {tenantId: 'tenant-a', userId: 'user-a', roles: ['hr_admin']},
  companies: [{id: 'company-a'}], scope: ['company-a'],
  dispatch: vi.fn(), count: vi.fn(), list: vi.fn(), pending: vi.fn(),
  nav: vi.fn(), tasks: vi.fn(), notices: vi.fn(), noticeCount: vi.fn(),
}));
vi.mock('next/font/google', () => ({Plus_Jakarta_Sans: () => ({variable: ''}), Geist_Mono: () => ({variable: ''}), DM_Mono: () => ({variable: ''})}));
vi.mock('next/font/local', () => ({default: () => ({variable: ''})}));
vi.mock('next/headers', () => ({headers: async () => new Map([['x-pathname', state.path]]), cookies: async () => new Map()}));
vi.mock('next-intl', () => ({NextIntlClientProvider: 'Intl'}));
vi.mock('next-intl/server', () => ({getLocale: async () => 'en',getMessages:async()=>en}));
vi.mock('next/navigation', () => ({redirect: (path: string) => {throw Error(`redirect:${path}`);}}));
vi.mock('../lib/login-presentation-server', () => ({publicLoginPresentation: async () => ({})}));
vi.mock('../lib/identity/email-settings', () => ({canConfigureIdentityEmail: async () => false}));
vi.mock('../lib/session', () => ({getSession: async () => state.session}));
vi.mock('../lib/viewer', () => ({viewerIdentity: async () => ({name: 'Viewer', employeeCode: 'E001'})}));
vi.mock('../lib/authz', () => ({isAdmin: () => state.admin, isOperator: () => false, isGroupAdmin: () => false,
  canAdminOnehr: () => false, canManagePayroll: () => false, canManagePerfComp: () => false, hasTeamAccess: () => false}));
vi.mock('../lib/principals', () => ({listPrincipals: async () => []}));
vi.mock('../lib/demo-mode', () => ({demoSwitcherEnabled: () => false, isDemoDeployment: () => false}));
vi.mock('../core/read', () => ({allowedCompanies: async () => state.companies, listApprovalHistory: async () => []}));
vi.mock('../core/access-configuration-editor', () => ({canConfigureAccess: async () => false}));
vi.mock('../core/workforce-access', () => ({workforceViewScope: async () => ({canOpen: false})}));
vi.mock('../lib/scope', () => ({getScopeIds: async () => state.scope}));
vi.mock('../core/onboarding', () => ({getOnboardingStatus: async () => true}));
vi.mock('../core/letter-navigation', () => ({letterNavigation: async () => []}));
vi.mock('../core/approvals-inbox', () => ({pendingTaskSummary:async(...args:unknown[])=>({items:await state.pending(...args),total:0,approvalCount:0})}));
vi.mock('../packs/lifecycle/service', () => ({onboardingNavigation: state.nav, onboardingTasks: state.tasks,
  onboardingNotices: state.notices, onboardingUnreadNoticeCount: state.noticeCount}));
vi.mock('../packs/performance/service', () => ({latestOnehrAdminCycleId: async () => null, adminSectionHref: () => ''}));
vi.mock('../core/notifications', () => ({dispatchNotifications: state.dispatch, unreadNotificationCount: state.count, listNotifications: state.list}));
vi.mock('../core/assistant-launcher', () => ({assistantLauncherFor: async () => null}));
vi.mock('../core/assistant-grant', () => ({mayUseAssistant: async () => ({allowed: false})}));
vi.mock('../core/entitlements', () => ({isModuleEnabledOrFalse: (_: unknown, module: string) => state.modules.has(module), settingEnabledOrDefault: () => true}));
vi.mock('../lib/nav-entitlements', () => ({visibleModuleCodes: () => [...state.modules]}));
vi.mock('../lib/ui-theme-server', () => ({currentUiTheme: async () => 'atelier'}));
vi.mock('../lib/onboarding-tour', () => ({toursForRoles: () => [], WELCOME_TOUR_ID: 'welcome'}));
vi.mock('../app/providers', () => ({Providers: 'Providers'}));
vi.mock('../components/operator-shell', () => ({OperatorShell: 'OperatorShell'}));
vi.mock('../components/sidebar', () => ({Sidebar: 'Sidebar'}));
vi.mock('../components/theme-toggle', () => ({ThemeToggle: 'ThemeToggle'}));
vi.mock('../components/language-switcher', () => ({LanguageSwitcher: 'LanguageSwitcher'}));
vi.mock('../components/ui/sonner', () => ({Toaster: 'Toaster'}));
vi.mock('../components/ui/toast-trigger', () => ({ToastFromQuery: 'ToastFromQuery'}));
vi.mock('../components/dev-identity-switcher', () => ({DevIdentitySwitcher: 'DevIdentitySwitcher'}));
vi.mock('../components/user-menu', () => ({UserMenu: 'UserMenu'}));
vi.mock('../components/company-switcher', () => ({CompanySwitcher: 'CompanySwitcher'}));
vi.mock('../components/onboarding-tour', () => ({OnboardingTour: 'OnboardingTour'}));
vi.mock('../components/assistant/assistant-launcher', () => ({AssistantLauncher: 'AssistantLauncher'}));
vi.mock('../components/notice/notice-surfaces', () => ({NoticePopupSlot: 'NoticePopupSlot'}));
vi.mock('../components/assistant/import-handoff', () => ({AssistantImportHandoffProvider: 'AssistantImportHandoffProvider'}));
vi.mock('../components/notification-center', () => ({NotificationCenter: 'NotificationCenter'}));
vi.mock('../components/command-bar', () => ({CommandBar: 'CommandBar'}));
vi.mock('../components/ui-theme-context', () => ({UiThemeProvider: 'UiThemeProvider'}));
vi.mock('../components/nav-index-context', () => ({NavIndexProvider: 'NavIndexProvider'}));
vi.mock('../components/intent-bar', () => ({IntentBar: 'IntentBar'}));
vi.mock('../components/shell-top-line', () => ({ShellRoutePath: 'ShellRoutePath', ShellLiveClock: 'ShellLiveClock', ShellStatusLine: 'ShellStatusLine'}));
import RootLayout from '../app/layout';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
function propsOf(node: ReactNode, name: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map(child => propsOf(child, name)).find(Boolean);
  if (!isValidElement<{children?: ReactNode}>(node)) return;
  if (node.type === name) return node.props;
  return propsOf(node.props.children, name);
}
beforeEach(() => {
  vi.resetAllMocks();
  state.path = '/'; state.admin = true;
  state.modules = new Set(['notifications', 'lifecycle', 'employees']);
  state.dispatch.mockResolvedValue({}); state.count.mockResolvedValue(0); state.list.mockResolvedValue([]);
  state.pending.mockResolvedValue([]); state.nav.mockResolvedValue({module: true, master: false, requisitions: false, joiners: 2, checklists: 1});
  state.tasks.mockResolvedValue([]); state.notices.mockResolvedValue([]); state.noticeCount.mockResolvedValue(0);
});

describe('shared page shell read scheduling', () => {
  it('starts all five bell reads together and preserves each tab and exact counts', async () => {
    const gate = deferred();
    state.count.mockImplementation(async (_ctx, _employment, opts) => {await gate.promise; return opts.action ? 7 : 3;});
    state.list.mockImplementation(async (_ctx, _employment, opts) => {await gate.promise; return [{id: opts.read ? 'read' : opts.action ? 'action' : 'info'}];});
    const layout = RootLayout({children: 'Page'});
    try {
      await vi.waitFor(() => {
        expect(state.count).toHaveBeenCalledTimes(2);
        expect(state.list).toHaveBeenCalledTimes(3);
      });
    } finally {gate.resolve();}
    const bell = propsOf(await layout, 'NotificationCenter');
    expect(bell).toMatchObject({unread: 3, taskCount: 7, items: [{id: 'info'}], taskNotifications: [{id: 'action'}], readItems: [{id: 'read'}]});
    for (const call of [...state.count.mock.calls, ...state.list.mock.calls]) expect(call[0]).toBe(state.session);
    expect(state.list.mock.calls.map(call => call[2])).toEqual([
      {limit: 12, read: false, action: false}, {limit: 12, read: false, action: true}, {limit: 12, read: true},
    ]);
  });
  it('starts independent lifecycle reads together', async () => {
    const gate = deferred();
    state.nav.mockImplementation(async () => {await gate.promise; return {module: true, joiners: 2};});
    state.tasks.mockImplementation(async () => {await gate.promise; return [];});
    state.notices.mockImplementation(async () => {await gate.promise; return [];});
    state.noticeCount.mockImplementation(async () => {await gate.promise; return 4;});
    const layout = RootLayout({children: 'Page'});
    try {
      await vi.waitFor(() => {
        expect(state.nav).toHaveBeenCalledTimes(1); expect(state.tasks).toHaveBeenCalledTimes(1);
        expect(state.notices).toHaveBeenCalledTimes(2); expect(state.noticeCount).toHaveBeenCalledTimes(1);
      });
    } finally {gate.resolve();}
    expect(propsOf(await layout, 'NotificationCenter')).toMatchObject({unread: 4});
  });
  it('finishes two independent read batches in two latency windows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    const slow = <T,>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 20));
    state.nav.mockImplementation(() => slow({module: true, joiners: 0}));
    state.tasks.mockImplementation(() => slow([])); state.notices.mockImplementation(() => slow([]));
    state.noticeCount.mockImplementation(() => slow(0));
    state.count.mockImplementation(() => slow(0)); state.list.mockImplementation(() => slow([]));
    try {
      const started = Date.now();
      const layout = RootLayout({children: 'Page'});
      await vi.runAllTimersAsync();
      await layout;
      expect(Date.now() - started).toBe(40);
    } finally {vi.useRealTimers();}
  });
  it('waits for dispatch before reading the bell', async () => {
    const gate = deferred(); state.dispatch.mockReturnValue(gate.promise);
    const layout = RootLayout({children: 'Page'});
    try {
      await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce());
      expect(state.count).not.toHaveBeenCalled(); expect(state.list).not.toHaveBeenCalled();
    } finally {gate.resolve();}
    await layout;
    expect(state.list).toHaveBeenCalledTimes(3);
  });
  it('keeps dispatch failure best-effort and skips it for ordinary employees', async () => {
    state.dispatch.mockRejectedValueOnce(Error('dispatch unavailable'));
    await RootLayout({children: 'Page'});
    expect(state.list).toHaveBeenCalledTimes(3);
    state.admin = false; state.dispatch.mockClear();
    await RootLayout({children: 'Page'});
    expect(state.dispatch).not.toHaveBeenCalled();
  });
  it('does no notification or lifecycle reads when their modules are unavailable', async () => {
    state.modules = new Set(['employees']);
    await RootLayout({children: 'Page'});
    for (const fn of [state.dispatch, state.count, state.list, state.nav, state.tasks, state.notices, state.noticeCount]) expect(fn).not.toHaveBeenCalled();
  });
  it('keeps the bare login shell free of authenticated owner reads', async () => {
    state.path = '/login';
    const tree = await RootLayout({children: 'Login'});
    expect(propsOf(tree, 'Sidebar')).toBeUndefined();
    for (const fn of [state.dispatch, state.count, state.list, state.pending, state.nav]) expect(fn).not.toHaveBeenCalled();
  });
});
