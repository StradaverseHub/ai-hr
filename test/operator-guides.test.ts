import type { ProvisionRequestRow } from '../core/operator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ operator: true, demo: false, list: vi.fn<() => Promise<ProvisionRequestRow[]>>(async () => []) }));
vi.mock('../lib/session', () => ({ getSession: async () => ({ grants: state.operator ? [{ role: 'operator', companyId: null }] : [] }) }));
vi.mock('../lib/authz', () => ({ isOperator: (s: { grants: { role: string }[] }) => s.grants.some(g => g.role === 'operator') }));
vi.mock('../lib/demo-mode', () => ({ isDemoDeployment: () => state.demo }));
vi.mock('../core/operator-customers',()=>({listOperatorCustomers:async()=>[]}));
vi.mock('../app/(app)/operator/customer-forms',()=>({CustomerCreateForm:()=>null}));
vi.mock('../core/operator', () => ({ listProvisionRequests: state.list, PROVISION_STEPS: [] }));
vi.mock('../app/(app)/operator/actions', () => ({ createCustomerAction: vi.fn(), requestReissueAction: vi.fn() }));
vi.mock('../localization/registry', () => ({ countryPacks: () => [{ country: 'MY' }] }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); } }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en', getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import OperatorPage from '../app/(app)/operator/page';

beforeEach(() => { state.operator = true; state.demo = false; state.list.mockReset(); state.list.mockResolvedValue([]); });

describe('operator guide rendering and access', () => {
  it('renders the real catalog within the existing guarded console', async () => {
    const html = renderToStaticMarkup(await OperatorPage());
    expect(html).toContain('id="operator-knowledge-base"');
    expect(html).toContain('Operator Guide: Customer Provisioning');
    expect(html).toContain('operator-identity-email');
    expect(html).toContain('operator-maintenance');
    expect(html).toContain('lang="en"');
    expect(html).toContain('<details');
    expect((html.match(/data-guide-tour=/g) ?? []).length).toBe(4);
    expect(html).not.toContain('MISSING_MESSAGE');
  });

  it('displays request instants in Malaysia time with an explicit timezone', async () => {
    const instant = new Date('2026-10-26T03:37:00.000Z');
    state.list.mockResolvedValueOnce([{
      id: 'timezone-regression', customerName: 'Example Customer', adminEmail: 'admin@example.test',
      status: 'done', country: 'MY', plan: null, modules: [], currentStep: null, error: null,
      tenantId: null, claimedAt: null, reissueRequestedAt: null, requestedBy: null,
      createdAt: instant, updatedAt: instant,
    }]);
    const html = renderToStaticMarkup(await OperatorPage());
    const time = html.match(/<time datetime="2026-10-26T03:37:00\.000Z">([^<]+)<\/time>/i);
    expect(time, 'rendered request timestamp').not.toBeNull();
    expect(time![1].replace(/[\u00a0\u202f]/g, ' ')).toBe('Oct 26, 2026, 11:37 AM MYT');
  });

  it.each([{ operator: false, demo: false }, { operator: true, demo: true }])('refuses the console before data or documentation is rendered: %j', async flags => {
    Object.assign(state, flags);
    await expect(OperatorPage()).rejects.toThrow('redirect');
    expect(state.list).not.toHaveBeenCalled();
  });
});
