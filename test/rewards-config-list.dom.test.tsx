// @vitest-environment jsdom
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import { todayInKualaLumpur } from '../lib/hr-date';

const ports = vi.hoisted(() => ({ list: vi.fn(), choices: vi.fn(), shared: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en-GB', getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as 'rewards' }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('../lib/scope', () => ({ scopedAdmin: async () => ({ s: { tenantId: 'tenant', userId: 'actor' }, scopeIds: ['company'] }) }));
vi.mock('../lib/authz', () => ({ requireModule: vi.fn() }));
vi.mock('../packs/rewards/service', async () => ({ listRewardUnits: ports.list, rewardCoverageForUnits: async () => [], rewardPolicyMemberships:vi.fn(async()=>[{companyId:'company',businessUnitId:'bu-1'},{companyId:'company',businessUnitId:'bu-2'}]),rewardSetupChoices: ports.choices, rewardSharedPolicyChoices: ports.shared, rewardDueWording: (await import('../packs/rewards/calendar')).rewardDueWording }));
vi.mock('../app/(app)/rewards/actions', () => ({ createRewardAction: vi.fn(), deleteRewardAction: vi.fn() }));
vi.mock('../app/(app)/admin/rewards/actions', () => ({ cancelRewardAction: vi.fn() }));
import AdminPage from '../app/(app)/admin/rewards/page';
import { RewardReviewCreateForm } from '../app/(app)/admin/rewards/create-review-form';

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
/** Resolve nested async server components (the row actions) before rendering. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') return resolve(await (node.type as any)(node.props));
  return node.props.children === undefined ? node : cloneElement(node, { children: await resolve(node.props.children) });
}
const page = async (searchParams: Record<string, string>) => resolve(await AdminPage({ searchParams: Promise.resolve(searchParams) }));
const wrap = (node: ReactNode) => <NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;
const base = { kind: 'annual', year: 2026, cycleId: 'cycle-1', cycle: '2026 Annual Compensation Review', companyId: 'company', company: 'Sample Trading Sdn Bhd', returnedTo: null, revision: 2, canConfigure: true, deletionReason: 'recommendations', bgOrigin: false, effectiveFrom: '2027-01-01', due: null, daysUntilDue: null, policyOrigin: null, canCancel: true, cancellation: null };
const rows = [
  { ...base, id: 'r1', businessUnitId: 'bu-1', unit: 'Northern Sales', status: 'draft', people: 42, verified: 30, seat: 'bu', holders: ['Abel Lim'], due: '2026-11-15', daysUntilDue: 18 },
  { ...base, id: 'r2', businessUnitId: 'bu-2', unit: 'Precast', company: 'Sample Industries Sdn Bhd', companyId: 'company-2', status: 'bg', people: 18, verified: 18, seat: 'bg', holders: [] },
];
beforeEach(() => {
  ports.list.mockResolvedValue(rows);
  ports.choices.mockResolvedValue({ companies: [{ id: 'company', name: 'Sample Trading Sdn Bhd' }], units: [{ id: 'bu-1', companyId: 'company', name: 'Northern Sales', global: false }], users: [], memberships:[{companyId:'company',businessUnitId:'bu-1'}],cycles: [{ id: 'cycle-1', name: '2026 Annual Compensation Review', year }] });
  ports.shared.mockResolvedValue([]);
});
afterEach(cleanup);

describe('Rewards configuration list (7a8102a7)', () => {
  it('shows the cycle once with its subline, people, the seat holders, due date and data check', async () => {
    render(wrap(await page({})));
    const [first, second] = screen.getAllByRole('row').slice(1);
    expect(within(first).getAllByText('2026 Annual Compensation Review')).toHaveLength(1);
    expect(within(first).queryByText(/Annual review/)).toBeNull();
    expect(within(first).getByText('Reward year 2026 · effective 01/01/2027')).toBeTruthy();
    expect(within(first).getByText('42')).toBeTruthy();
    expect(within(first).getByText('With BU CEO: Abel Lim')).toBeTruthy();
    expect(within(first).getByText('15/11/2026')).toBeTruthy();
    expect(within(first).getByText('in 18 days')).toBeTruthy();
    expect(within(first).getByText('30 of 42 verified')).toBeTruthy();
    expect(within(second).getByText('With BG CEO / authorised proxy: nobody holds this seat')).toBeTruthy();
    expect(within(second).getByText('All verified')).toBeTruthy();
    for (const name of ['Review cycle', 'Company / Business unit', 'People', 'Approval stage / with', 'Stage due', 'Data check']) expect(screen.getByRole('columnheader', { name })).toBeTruthy();
  });
  it('filters the list by company, business unit, cycle and stage through the URL', async () => {
    render(wrap(await page({ stage: 'bg' })));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    // The unit name also appears as a filter option; the filtered row is the one that matters.
    expect(within(screen.getAllByRole('row')[1]).getByText('Precast')).toBeTruthy();
    cleanup();
    render(wrap(await page({ company: 'company', unit: 'bu-2' })));
    expect(screen.getByText('No reviews match these filters.')).toBeTruthy();
    const filters = screen.getByRole('form', { name: 'Filter reviews' });
    for (const name of ['Review cycle', 'Company', 'Business unit', 'Approval stage']) expect(within(filters).getByRole('combobox', { name })).toBeTruthy();
    expect(within(filters).getByRole<HTMLSelectElement>('combobox', { name: 'Business unit' }).value).toBe('bu-2');
  });
});

describe('Create unit review cycle name (7a8102a7)', () => {
  const props = { actorUserId: 'actor', today, companies: [{ id: 'company', name: 'Company' }], units: [{ id: 'bu-1', companyId: 'company', name: 'Unit', global: false }], memberships:[{companyId:'company',businessUnitId:'bu-1'}],cycles: [{ id: 'cycle-1', name: 'Existing cycle', year }], shared: [] };
  it('suggests the default name, follows the year until edited, and hides it for an existing cycle', () => {
    render(wrap(<RewardReviewCreateForm {...props} />));
    const name = () => screen.queryByRole<HTMLInputElement>('textbox', { name: 'Review cycle' });
    expect(name()!.value).toBe(`${year} Annual Compensation Review`);
    expect(screen.getByLabelText<HTMLInputElement>('Salary effective date').value).toBe(`${year + 1}-01-01`);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Reward year' }), { target: { value: String(year + 1) } });
    expect(name()!.value).toBe(`${year + 1} Annual Compensation Review`);
    expect(screen.getByLabelText<HTMLInputElement>('Salary effective date').value).toBe(`${year + 2}-01-01`);
    fireEvent.change(name()!, { target: { value: 'My own cycle' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Reward year' }), { target: { value: String(year) } });
    expect(name()!.value).toBe('My own cycle');
    fireEvent.change(screen.getByRole('combobox', { name: 'Add to an existing cycle' }), { target: { value: 'cycle-1' } });
    expect(name()).toBeNull();
    expect(document.querySelector('input[name="name"]')).toBeNull();
  });
  it('reads the salary effective date from the matching shared configuration', () => {
    const policy = { effectiveFrom: `${year + 1}-04-01`, meritMatrix: { SSTAR: [1, 1, 1], STAR: [1, 1, 1], SCORE: [1, 1, 1], IMPRO: [0, 0, 0], PIP: [0, 0, 0] }, standardPools: [500, 100, 100], hPools: [500, 100, 100], targetMonthsBp: 20000, bonusMatrix: { '12': [0, 1, 2, 3, 4] }, exemptReason: '' };
    render(wrap(<RewardReviewCreateForm {...props} shared={[{ groupId: 'g', versionId: 'v', revision: 3, name: 'Group Standard', year, companyId: 'company', businessUnitId: 'bu-1', policy: policy as any }]} />));
    expect(screen.getByLabelText<HTMLInputElement>('Salary effective date').value).toBe(`${year + 1}-04-01`);
  });
});

describe('Row actions by stage (62e743ed)', () => {
  const actionsOf = async (row: Record<string, unknown>) => {
    ports.list.mockResolvedValue([{ ...rows[0], ...row }]);
    render(wrap(await page({})));
    const cell = within(screen.getAllByRole('row')[1]).getAllByRole('cell').at(-1)!;
    return [...cell.querySelectorAll('a,button')].map(e => e.textContent);
  };
  it.each([
    ['unused draft', { status: 'draft', deletionReason: null, canConfigure: true }, ['View', 'Edit', 'Delete']],
    ['draft in use', { status: 'draft', deletionReason: 'recommendations', canConfigure: true }, ['View', 'Edit', 'Cancel review']],
    ['approval stage', { status: 'bg', deletionReason: 'locked', canConfigure: false }, ['View', 'Edit deadlines', 'Cancel review']],
    ['approved', { status: 'approved', deletionReason: 'locked', canConfigure: false }, ['View', 'Edit deadlines', 'Cancel review']],
    ['posted', { status: 'posted', deletionReason: 'locked', canConfigure: false, canCancel: false }, ['View']],
    ['cancelled', { status: 'withdrawn', deletionReason: 'locked', canConfigure: false, canCancel: false }, ['View']],
  ])('%s offers only its allowed actions', async (_label, row, expected) => {
    expect(await actionsOf(row)).toEqual(expected);
  });
  it('hides Cancel without cancel authority and shows who cancelled, when and why', async () => {
    expect(await actionsOf({ status: 'bg', deletionReason: 'locked', canConfigure: false, canCancel: false })).toEqual(['View', 'Edit deadlines']);
    cleanup();
    await actionsOf({ status: 'withdrawn', deletionReason: 'locked', canCancel: false, cancellation: { on: '2026-11-12', by: 'A. Admin', reason: 'Unit merged into Northern Sales review' } });
    expect(screen.getByText('Cancelled 12/11/2026 by A. Admin: Unit merged into Northern Sales review')).toBeTruthy();
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
  });
  it('asks for a reason in the cancel confirmation', async () => {
    await actionsOf({ status: 'bg', deletionReason: 'locked' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel review' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Cancel this review?')).toBeTruthy();
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel review' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Unit merged into another review' } });
    expect(confirm.disabled).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Keep review' })).toBeTruthy();
  });
});

describe('Shared configuration visibility (56595838)', () => {
  const props = { actorUserId: 'actor', today, companies: [{ id: 'company', name: 'Company' }], units: [{ id: 'bu-1', companyId: 'company', name: 'Unit', global: false }], memberships:[{companyId:'company',businessUnitId:'bu-1'}],cycles: [], shared: [] };
  const policy = { effectiveFrom: `${year + 1}-01-01`, meritMatrix: { SSTAR: [1000, 800, 800], STAR: [800, 600, 600], SCORE: [600, 450, 300], IMPRO: [0, 0, 0], PIP: [0, 0, 0] }, standardPools: [500, 100, 100], hPools: [400, 100, 50], targetMonthsBp: 20000, bonusMatrix: { '12': [0, 1, 2, 3, 4], H: [0, 1, 2, 3, 4] }, exemptReason: '' };
  it('names the version and opens its settings read-only', () => {
    render(wrap(<RewardReviewCreateForm {...props} shared={[{ groupId: 'g', versionId: 'v', revision: 3, name: 'Group Standard 2026', year, companyId: 'company', businessUnitId: 'bu-1', policy: policy as any }]} />));
    expect(screen.getAllByText('Group Standard 2026 · Version 3').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'View settings' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Group Standard 2026 · Version 3/)).toBeTruthy();
    expect(within(dialog).getByText('read only')).toBeTruthy();
    expect(within(dialog).getByText('SSTAR')).toBeTruthy();
    expect(within(dialog).getByRole('row', { name: /Standard plan pools/ }).textContent).toContain('5% / 1% / 1%');
    expect(within(dialog).getByRole('row', { name: /JG H plan pools/ }).textContent).toContain('4% / 1% / 0.5%');
    expect(within(dialog).queryByRole('row', { name: /Target bonus months/ })).toBeNull();
    expect(within(dialog).getByText(en.rewardsConfig.summary.unitInputs)).toBeTruthy();
    expect(dialog.querySelectorAll('input,select,textarea')).toHaveLength(0);
  });
  it('says plainly when no shared configuration exists, links to create one and shows the standard settings', () => {
    render(wrap(<RewardReviewCreateForm {...props} />));
    expect(screen.getByText(/None for this company, business unit and year/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create a shared configuration' }).getAttribute('href')).toBe('/admin/rewards/shared');
    fireEvent.click(screen.getByRole('button', { name: 'View settings' }));
    expect(within(screen.getByRole('dialog')).getByText(`Standard settings for ${year}`)).toBeTruthy();
  });
  it('shows the origin version and the changed badge in the list', async () => {
    ports.list.mockResolvedValue([{ ...rows[0], policyOrigin: { versionId: 'v', revision: 3, name: 'Group Standard 2026', changed: true } }]);
    render(wrap(await page({})));
    const row = screen.getAllByRole('row')[1];
    expect(within(row).getByText(/Group Standard 2026 · Version 3/)).toBeTruthy();
    expect(within(row).getByText('changed in this review')).toBeTruthy();
  });
});
