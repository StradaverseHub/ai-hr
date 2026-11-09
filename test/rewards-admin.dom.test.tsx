import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { AuthRequiredError } from '../lib/auth-errors';

const ports = vi.hoisted(() => ({ scopedAdmin: vi.fn(), scopedSession: vi.fn(), scope: vi.fn(), visibleCompanies: vi.fn(), navigation: vi.fn(), requireModule: vi.fn(), list: vi.fn(), reviewStatus: vi.fn(), choices: vi.fn(), configuration: vi.fn(), shared: vi.fn(), memberships: vi.fn(), requests: vi.fn(), accessCompanies: vi.fn(), accessEntry: vi.fn(), accessAdministration: vi.fn(), accessPermissions: vi.fn(), accessPersonalPages: vi.fn(), accessActivity: vi.fn(), session: vi.fn(), isOperator: vi.fn(), isDemoDeployment: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en', getTranslations: async (namespace: keyof typeof en = 'rewards') => (key: string) => key.split('.').reduce((v: any, k) => v[k], en[namespace]) }));
const redirect = vi.hoisted(() => vi.fn(() => { throw new Error('redirect'); }));
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error('not found'); }));
vi.mock('next/navigation', async importOriginal => ({ ...await importOriginal<typeof import('next/navigation')>(), redirect, notFound, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('../lib/scope', () => ({ scopedAdmin: ports.scopedAdmin, scopedSession: ports.scopedSession, getScopeIds: ports.scope }));
vi.mock('../packs/rewards/access-policy', () => ({
  rewardVisibleCompanies: ports.visibleCompanies, rewardNavigation: ports.navigation, rewardAccessPageCompanies: ports.accessCompanies,
  rewardAccessPageEntry: ports.accessEntry, rewardPermissions: ports.accessPermissions, rewardPersonalPages: ports.accessPersonalPages,
  rewardSetupEntry: async () => ({ bootstrap: false }),
}));
vi.mock('../packs/rewards/activity', () => ({ rewardReviewActivity: ports.accessActivity }));
vi.mock('../packs/rewards/group-roles', () => ({ rewardWholeGroupPlans: async () => [], rewardReviewCompanyGroups: async () => ({}), rewardWholeGroupSetupCompanies: async () => [] }));
vi.mock('../lib/session', () => ({ getSession: ports.session }));
vi.mock('../lib/authz', () => ({ requireModule: ports.requireModule, isAdmin: () => false, isOperator: ports.isOperator }));
vi.mock('../lib/demo-mode', async importOriginal => ({ ...await importOriginal<typeof import('../lib/demo-mode')>(), isDemoDeployment: ports.isDemoDeployment }));
vi.mock('../packs/rewards/service', () => ({ listRewardUnits: ports.list, listRewardReviewStatus: ports.reviewStatus, rewardCoverageForUnits: async () => [], rewardSetupChoices: ports.choices, getRewardConfiguration: ports.configuration, getRewardSeniorMembership: vi.fn(), rewardSharedPolicyChoices: ports.shared, rewardPolicyMemberships: ports.memberships, getRewardCalendar: async () => ({ revision: 1, canEdit: true, values: { due: { bu: '2026-12-11' }, caseDue: null, offcycleDays: {} } }), rewardAccessRequests: ports.requests, rewardAccessAdministration: ports.accessAdministration, rewardCalendarStages: ['bu'], rewardOffcycleSlaStages: ['bg'] }));
vi.mock('../app/rewards/actions', () => ({ createRewardAction: vi.fn(), memberAction: vi.fn(), policyAction: vi.fn(), deleteRewardAction: vi.fn(), calendarAction: vi.fn() }));
vi.mock('../app/admin/rewards/actions', () => ({ cancelRewardAction: vi.fn() }));
import { GET as rewardsBookmark, HEAD as rewardsBookmarkHead } from '../app/admin/rewards/route';
import RewardAccessPage from '../app/admin/rewards/access/page';
import ConfigurationPage from '../app/admin/rewards/[unitId]/page';
import ReviewsPage from '../app/rewards/reviews/page';
import { PolicyForm, RewardPolicyFields } from '../app/rewards/[unitId]/policy-form';
import { defaultPolicy } from '../packs/rewards/model';
import { todayInKualaLumpur } from '../lib/hr-date';

const session = { tenantId: 'tenant' };
const show = (element: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
/** Resolve only the known nested server fields; keep the real form and visible controls. */
async function resolvePolicyFields(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolvePolicyFields));
  if (!isValidElement<{ children?: ReactNode; maintenanceActions?: ReadonlyMap<string, ReactNode> }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') return resolvePolicyFields(await (node.type as any)(node.props));
  if (node.type === RewardPolicyFields) return RewardPolicyFields(node.props as ComponentProps<typeof RewardPolicyFields>);
  const actions = node.props.maintenanceActions;
  return cloneElement(node, {
    children: await resolvePolicyFields(node.props.children),
    ...(actions ? { maintenanceActions: new Map(await Promise.all(
      [...actions].map(async ([key, value]) => [key, await resolvePolicyFields(value)] as const)
    )) } : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.session.mockResolvedValue(session);
  ports.isOperator.mockReturnValue(false);
  ports.isDemoDeployment.mockReturnValue(false);
  ports.scopedAdmin.mockResolvedValue({ s: session, scopeIds: ['company'] });
  ports.scopedSession.mockResolvedValue({ s: session, scopeIds: ['company'] });
  ports.choices.mockResolvedValue({ companies: [{ id: 'company', name: 'Company' }], units: [{ id: 'bu', companyId: 'company', name: 'Headquarters' }], users: [], cycles: [] });
  ports.list.mockResolvedValue([{ id: 'review', cycle: 'Annual review', kind: 'annual', year: 2026, company: 'Company', unit: 'Headquarters', status: 'draft',revision:1,canConfigure:true,deletionReason:null }]);
  ports.reviewStatus.mockResolvedValue({ rows: [{ id: 'review', cycleId: 'cycle', cycle: 'Annual review', kind: 'annual', year: 2026, companyId: 'company', company: 'Company', businessUnitId: 'bu', unit: 'Headquarters', status: 'draft', returnedTo: null, roles: ['bu'], seat: 'bu', holders: ['Fictional Reviewer'], due: null, daysUntilDue: null, waiting: true, salary: { poolShareBp: 700 }, bonus: { budgetShareBp: 1000 }, blocking: 0, exceptions: 0, laterSeats: [] }], emptyReason: null, year: 2026 });
  ports.shared.mockResolvedValue([]);
  ports.memberships.mockResolvedValue([{ companyId: 'company', businessUnitId: 'bu' }]);
  ports.requests.mockResolvedValue([]);
  ports.accessCompanies.mockResolvedValue([]);
  ports.visibleCompanies.mockResolvedValue([{ id: 'company' }]);
  ports.scope.mockResolvedValue(['company']);
  ports.navigation.mockResolvedValue(['/rewards', '/rewards/rules']);
});
afterEach(cleanup);

describe('Rewards administration and review destinations', () => {
  it.each([['GET', rewardsBookmark], ['HEAD', rewardsBookmarkHead]] as const)(
    'redirects legacy Review Cycles with an uncached HTTP 307 on %s', async (method, handle) => {
      const request = new Request('https://fixture.invalid/admin/rewards?version=approved&year=2026', { method });
      const response = await handle(request);
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('/admin/rewards/plans?version=approved&year=2026');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.text()).toBe('');
      expect(ports.session).toHaveBeenCalledTimes(1);
      expect(ports.requireModule).toHaveBeenCalledExactlyOnceWith('rewards', session);
      expect(ports.requireModule.mock.calls[0][1]).toBe(session);
      expect(ports.scopedAdmin).not.toHaveBeenCalled();
      expect(ports.list).not.toHaveBeenCalled();
    });
  it.each([
    ['?version=a&version=b&year=2026&year=2027&error=first&error=second&sharedError=ignored&next=https://foreign.invalid', ''],
    ['?sharedError=Needs+review&next=https://foreign.invalid', '?error=Needs+review'],
    ['?sharedError=ignored&error=', '?error='],
    ['?year=2026&sharedError=first&sharedError=second', '?year=2026'],
  ])('preserves the legacy scalar and error-precedence rules for %s', async (search, expected) => {
    const response = await rewardsBookmark(new Request(`https://fixture.invalid/admin/rewards${search}`));
    expect(response.headers.get('location')).toBe('/admin/rewards/plans' + expected);
  });
  it('runs identity, operator and Rewards module decisions before exposing the Plans target', async () => {
    const request = new Request('https://fixture.invalid/admin/rewards');
    ports.session.mockRejectedValueOnce(new AuthRequiredError('fictional missing session'));
    await expect(rewardsBookmark(request)).rejects.toThrow('redirect');
    expect(redirect).toHaveBeenLastCalledWith('/login');
    expect(ports.requireModule).not.toHaveBeenCalled();

    ports.isOperator.mockReturnValueOnce(true);
    await expect(rewardsBookmarkHead(request)).rejects.toThrow('redirect');
    expect(redirect).toHaveBeenLastCalledWith('/operator');
    expect(ports.requireModule).not.toHaveBeenCalled();

    ports.requireModule.mockImplementationOnce(() => redirect('/?moduleUnavailable=rewards'));
    await expect(rewardsBookmark(request)).rejects.toThrow('redirect');
    expect(redirect).toHaveBeenLastCalledWith('/?moduleUnavailable=rewards');

    ports.isOperator.mockReturnValueOnce(true);
    ports.isDemoDeployment.mockReturnValueOnce(true);
    expect((await rewardsBookmark(request)).status).toBe(307);
    expect(ports.requireModule).toHaveBeenLastCalledWith('rewards', session);
  });
  it('opens scoped access maintenance without loading policy, activity or exports', async () => {
    ports.accessEntry.mockResolvedValue({ companies: [{ id: 'company' }], groupRewards: false });
    ports.accessAdministration.mockResolvedValue({ reviews: [], members: [], users: [], candidates: [], suggestions: [] });

    show(await RewardAccessPage({ searchParams: Promise.resolve({ tab: 'activity', review: 'foreign-review' }) }));

    expect(ports.scope).toHaveBeenCalledWith(['company']);
    expect(ports.accessAdministration).toHaveBeenCalledWith(session, ['company']);
    expect(screen.getByRole('heading', { name: en.rewardsAccess.title })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: en.rewardAccessPolicy.tabs })).toBeNull();
    expect(screen.queryByText(en.rewardsAccess.permissionsTitle)).toBeNull();
    expect(document.querySelector('a[href="/admin/rewards/access/export"]')).toBeNull();
    expect(ports.accessPermissions).not.toHaveBeenCalled();
    expect(ports.accessPersonalPages).not.toHaveBeenCalled();
    expect(ports.accessActivity).not.toHaveBeenCalled();
  });
  it('rejects a direct access URL when there is no authorized company', async () => {
    ports.accessEntry.mockResolvedValue({ companies: [], groupRewards: false });
    await expect(RewardAccessPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('not found');
    expect(ports.accessAdministration).not.toHaveBeenCalled();
  });
  it('shows authorized review shortcuts and leaves configuration in the menu', async () => {
    show(await resolvePolicyFields(await ReviewsPage({ searchParams: Promise.resolve({}) })));
    expect(screen.getAllByRole('link', { name: 'Open review' }).map(link => link.getAttribute('href'))).toContain('/rewards/review');
    expect(screen.getByRole('heading', { name: en.nav.rewardsAllReviews })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Rules' })).toBeNull();
    expect(screen.getByRole('link', { name: 'View' }).getAttribute('href')).toBe('/admin/rewards/review?mode=view');
    expect(screen.queryByRole('link', { name: 'Rewards Analytics' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Review Cycles' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create unit review' })).toBeNull();
    expect(ports.scopedSession).toHaveBeenCalledOnce();
    expect(ports.visibleCompanies).toHaveBeenCalledWith(session);
    expect(ports.scope).toHaveBeenCalledWith(['company']);
    expect(ports.reviewStatus).toHaveBeenCalledWith(session, ['company'], { includeCreationPlan: false });
    expect(ports.choices).toHaveBeenCalledWith(session, ['company'], { fields: [] });
    expect(ports.list).not.toHaveBeenCalled();
  });
  it('renders View with disabled policy fields and no mutation forms, even for an authorised owner',async()=>{
    ports.configuration.mockResolvedValue({unit:{id:'review',kind:'annual',status:'draft',revision:1,policy:defaultPolicy(Number(todayInKualaLumpur().slice(0,4)))},cycle:{name:'Annual review'},name:'Operations',canConfigure:true,canManageMembers:true,members:[{id:'m',userId:'admin',role:'gr'}]});
    show(await resolvePolicyFields(await ConfigurationPage({params:Promise.resolve({unitId:'review'}),searchParams:Promise.resolve({mode:'view'})})));
    expect(document.querySelectorAll('input:not([type="hidden"]),textarea,select').length).toBeGreaterThan(30);
    expect(document.querySelectorAll('form')).toHaveLength(0);
    for(const field of document.querySelectorAll('input,textarea,select'))expect(field.matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button',{name:'Save policy'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Assign role'})).toBeNull();
  });
  it('says an assigned role waits for a second administrator and lists this review\'s pending role changes only',async()=>{
    ports.choices.mockResolvedValue({ companies: [{ id: 'company', name: 'Company' }], units: [], users: [{ id: 'admin', name: 'Fictional Admin' }, { id: 'ceo', name: 'Fictional CEO' }], cycles: [] });
    ports.configuration.mockResolvedValue({unit:{id:'review',kind:'annual',status:'draft',revision:1,policy:defaultPolicy(Number(todayInKualaLumpur().slice(0,4)))},cycle:{name:'Annual review'},name:'Operations',canConfigure:true,canManageMembers:true,members:[{id:'m',userId:'admin',role:'gr'}]});
    const change=(unitId:string,before:unknown,after:unknown)=>({unitId,revision:1,before,after});
    ports.requests.mockResolvedValue([
      {id:'r1',status:'pending',changes:[change('review',null,{userId:'ceo',role:'bu'}),change('other-review',null,{userId:'ceo',role:'bg'})]},
      {id:'r2',status:'pending',changes:[change('review',{userId:'admin',role:'gr'},null)]},
      {id:'r3',status:'rejected',changes:[change('review',null,{userId:'ceo',role:'ctro'})]},
    ]);
    show(await resolvePolicyFields(await ConfigurationPage({params:Promise.resolve({unitId:'review'}),searchParams:Promise.resolve({notice:'accessPending'})})));
    expect(screen.getAllByRole('status').some(s=>s.textContent?.includes(en.rewardsAccessControl.independent))).toBe(true);
    const pending=screen.getByRole('heading',{name:en.rewardsAccessControl.waiting}).parentElement!;
    expect([...pending.querySelectorAll('li')].map(li=>li.textContent)).toEqual([`${en.rewards.roles.bu} · Fictional CEO`,`${en.rewards.remove}: ${en.rewards.roles.gr} · Fictional Admin`]);
    expect(pending.querySelector('a')?.getAttribute('href')).toBe('/admin/rewards/access');
    // The current roles still show only what is in force.
    expect(screen.getByText(`${en.rewards.roles.gr} · Fictional Admin`)).toBeTruthy();
  });
  it('shows no pending list or notice when nothing waits, and never loads requests in View',async()=>{
    ports.configuration.mockResolvedValue({unit:{id:'review',kind:'annual',status:'draft',revision:1,policy:defaultPolicy(Number(todayInKualaLumpur().slice(0,4)))},cycle:{name:'Annual review'},name:'Operations',canConfigure:true,canManageMembers:true,members:[]});
    show(await resolvePolicyFields(await ConfigurationPage({params:Promise.resolve({unitId:'review'}),searchParams:Promise.resolve({})})));
    expect(screen.queryByRole('heading',{name:en.rewardsAccessControl.waiting})).toBeNull();expect(screen.queryByText(en.rewardsAccessControl.independent)).toBeNull();
    cleanup();ports.requests.mockClear();
    show(await resolvePolicyFields(await ConfigurationPage({params:Promise.resolve({unitId:'review'}),searchParams:Promise.resolve({mode:'view'})})));
    expect(ports.requests).not.toHaveBeenCalled();
  });
  it('makes a locked policy visible with every editable field disabled and no save command', async () => {
    const policy = defaultPolicy(Number(todayInKualaLumpur().slice(0, 4)));
    show(await resolvePolicyFields(await PolicyForm({ unitId: 'review', revision: 3, policy, readOnly: true })));
    expect(screen.getByLabelText('Standard plan · Merit (%)')).toBeTruthy();
    const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
    expect(inputs.length).toBeGreaterThan(30);
    for (const input of inputs) expect(input.matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
  });
});
