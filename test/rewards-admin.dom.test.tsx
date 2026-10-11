import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

const ports = vi.hoisted(() => ({ scopedAdmin: vi.fn(), scopedSession: vi.fn(), requireModule: vi.fn(), list: vi.fn(), choices: vi.fn(), configuration: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key.split('.').reduce((v: any, k) => v[k], en.rewards) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('../lib/scope', () => ({ scopedAdmin: ports.scopedAdmin, scopedSession: ports.scopedSession }));
vi.mock('../lib/authz', () => ({ requireModule: ports.requireModule }));
vi.mock('../packs/rewards/service', () => ({ listRewardUnits: ports.list, rewardSetupChoices: ports.choices, getRewardConfiguration: ports.configuration }));
vi.mock('../app/rewards/actions', () => ({ createRewardAction: vi.fn(), memberAction: vi.fn(), policyAction: vi.fn() }));
import AdminPage from '../app/admin/rewards/page';
import ReviewsPage from '../app/rewards/page';
import { PolicyForm } from '../app/rewards/[unitId]/policy-form';
import { defaultPolicy } from '../packs/rewards/model';
import { todayInKualaLumpur } from '../lib/hr-date';

const session = { tenantId: 'tenant' };
const show = (element: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
beforeEach(() => {
  vi.clearAllMocks();
  ports.scopedAdmin.mockResolvedValue({ s: session, scopeIds: ['company'] });
  ports.scopedSession.mockResolvedValue({ s: session, scopeIds: ['company'] });
  ports.choices.mockResolvedValue({ companies: [{ id: 'company', name: 'Company' }], units: [{ id: 'bu', companyId: 'company', name: 'Headquarters' }], users: [], cycles: [] });
  ports.list.mockResolvedValue([{ id: 'review', cycle: 'Annual review', kind: 'annual', year: 2026, company: 'Company', unit: 'Headquarters', status: 'draft' }]);
});
afterEach(cleanup);

describe('Rewards administration and review destinations', () => {
  it('puts cycle creation and configuration links in the admin hub, scoped to administrative companies', async () => {
    show(await AdminPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Rewards configuration' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Configure' }).getAttribute('href')).toBe('/admin/rewards/review');
    expect(screen.getByRole('button', { name: 'Create unit review' })).toBeTruthy();
    expect(screen.getByLabelText('Snapshot date').getAttribute('max')).toBe(todayInKualaLumpur());
    expect(ports.scopedAdmin).toHaveBeenCalledOnce();
    expect(ports.requireModule).toHaveBeenCalledWith('rewards');
    expect(ports.list).toHaveBeenCalledWith(session, ['company']);
  });
  it('keeps review links in Manage and directs setup to Administration', async () => {
    show(await ReviewsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('link', { name: 'Open review' }).getAttribute('href')).toBe('/rewards/review');
    expect(screen.getByRole('link', { name: 'Rewards configuration' }).getAttribute('href')).toBe('/admin/rewards');
    expect(screen.queryByRole('button', { name: 'Create unit review' })).toBeNull();
  });
  it('makes a locked policy visible with every editable field disabled and no save command', async () => {
    const policy = defaultPolicy(Number(todayInKualaLumpur().slice(0, 4)));
    show(await PolicyForm({ unitId: 'review', revision: 3, policy, readOnly: true }));
    expect(screen.getByLabelText('Standard plan · Merit (%)')).toBeTruthy();
    const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
    expect(inputs.length).toBeGreaterThan(30);
    for (const input of inputs) expect(input.matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
  });
});
