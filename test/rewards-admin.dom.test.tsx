import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

const ports = vi.hoisted(() => ({ scopedAdmin: vi.fn(), scopedSession: vi.fn(), requireModule: vi.fn(), list: vi.fn(), reviewStatus: vi.fn(), choices: vi.fn(), configuration: vi.fn(), shared: vi.fn(), memberships: vi.fn(), requests: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en', getTranslations: async (namespace: keyof typeof en = 'rewards') => (key: string) => key.split('.').reduce((v: any, k) => v[k], en[namespace]) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('../lib/scope', () => ({ scopedAdmin: ports.scopedAdmin, scopedSession: ports.scopedSession }));
vi.mock('../lib/authz', () => ({ requireModule: ports.requireModule }));
vi.mock('../packs/rewards/service', () => ({ listRewardUnits: ports.list, listRewardReviewStatus: ports.reviewStatus, rewardCoverageForUnits: async () => [], rewardSetupChoices: ports.choices, getRewardConfiguration: ports.configuration, getRewardSeniorMembership: vi.fn(), rewardSharedPolicyChoices: ports.shared, rewardPolicyMemberships: ports.memberships, getRewardCalendar: async () => ({ revision: 1, canEdit: true, values: { due: { bu: '2026-12-11' }, caseDue: null, offcycleDays: {} } }), rewardAccessRequests: ports.requests, rewardCalendarStages: ['bu'], rewardOffcycleSlaStages: ['bg'] }));
vi.mock('../app/rewards/actions', () => ({ createRewardAction: vi.fn(), memberAction: vi.fn(), policyAction: vi.fn(), deleteRewardAction: vi.fn(), calendarAction: vi.fn() }));
vi.mock('../app/admin/rewards/actions', () => ({ cancelRewardAction: vi.fn() }));
import AdminPage from '../app/admin/rewards/page';
import ConfigurationPage from '../app/admin/rewards/[unitId]/page';
import ReviewsPage from '../app/rewards/page';
import { PolicyForm, RewardPolicyFields } from '../app/rewards/[unitId]/policy-form';
import { defaultPolicy } from '../packs/rewards/model';
import { todayInKualaLumpur } from '../lib/hr-date';

const session = { tenantId: 'tenant' };
const show = (element: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
/** Resolve only the known nested server fields; keep the real form and visible controls. */
async function resolvePolicyFields(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolvePolicyFields));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') return resolvePolicyFields(await (node.type as any)(node.props));
  if (node.type === RewardPolicyFields) return RewardPolicyFields(node.props as ComponentProps<typeof RewardPolicyFields>);
  return cloneElement(node, { children: await resolvePolicyFields(node.props.children) });
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.scopedAdmin.mockResolvedValue({ s: session, scopeIds: ['company'] });
  ports.scopedSession.mockResolvedValue({ s: session, scopeIds: ['company'] });
  ports.choices.mockResolvedValue({ companies: [{ id: 'company', name: 'Company' }], units: [{ id: 'bu', companyId: 'company', name: 'Headquarters' }], users: [], cycles: [] });
  ports.list.mockResolvedValue([{ id: 'review', cycle: 'Annual review', kind: 'annual', year: 2026, company: 'Company', unit: 'Headquarters', status: 'draft',revision:1,canConfigure:true,deletionReason:null }]);
  ports.reviewStatus.mockResolvedValue({ rows: [{ id: 'review', cycleId: 'cycle', cycle: 'Annual review', kind: 'annual', year: 2026, companyId: 'company', company: 'Company', businessUnitId: 'bu', unit: 'Headquarters', status: 'draft', returnedTo: null, roles: ['bu'], seat: 'bu', holders: ['Fictional Reviewer'], due: null, daysUntilDue: null, waiting: true, salary: { poolShareBp: 700 }, bonus: { budgetShareBp: 1000 }, blocking: 0, exceptions: 0, laterSeats: [] }], emptyReason: null, year: 2026 });
  ports.shared.mockResolvedValue([]);
  ports.memberships.mockResolvedValue([{ companyId: 'company', businessUnitId: 'bu' }]);
  ports.requests.mockResolvedValue([]);
});
afterEach(cleanup);

describe('Rewards administration and review destinations', () => {
  it('puts cycle creation and configuration links in the admin hub, scoped to administrative companies', async () => {
    show(await resolvePolicyFields(await AdminPage({ searchParams: Promise.resolve({}) })));
    expect(screen.getByRole('heading', { name: 'Rewards configuration' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View' }).getAttribute('href')).toBe('/admin/rewards/review?mode=view');
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe('/admin/rewards/review');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create unit review' })).toBeTruthy();
    expect(screen.getByLabelText('Snapshot date').getAttribute('max')).toBe(todayInKualaLumpur());
    expect(ports.scopedAdmin).toHaveBeenCalledOnce();
    expect(ports.requireModule).toHaveBeenCalledWith('rewards');
    expect(ports.list).toHaveBeenCalledWith(session, ['company']);
    expect(ports.shared).toHaveBeenCalledWith(session, ['company']);
    expect(ports.memberships).toHaveBeenCalledWith(session, ['company']);
  });
  it('keeps review links in Manage and directs setup to Administration', async () => {
    show(await ReviewsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('link', { name: 'Open review' }).getAttribute('href')).toBe('/rewards/review');
    expect(screen.getByRole('link', { name: 'Rewards configuration' }).getAttribute('href')).toBe('/admin/rewards');
    expect(screen.queryByRole('button', { name: 'Create unit review' })).toBeNull();
    expect(ports.scopedSession).toHaveBeenCalledOnce();
    expect(ports.reviewStatus).toHaveBeenCalledWith(session, ['company']);
    expect(ports.choices).toHaveBeenCalledWith(session, ['company']);
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
