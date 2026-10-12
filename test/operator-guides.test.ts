import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ operator: true, demo: false, list: vi.fn(async () => []) }));
vi.mock('../lib/session', () => ({ getSession: async () => ({ grants: state.operator ? [{ role: 'operator', companyId: null }] : [] }) }));
vi.mock('../lib/authz', () => ({ isOperator: (s: { grants: { role: string }[] }) => s.grants.some(g => g.role === 'operator') }));
vi.mock('../lib/demo-mode', () => ({ isDemoDeployment: () => state.demo }));
vi.mock('../core/operator', () => ({ listProvisionRequests: state.list, PROVISION_STEPS: [] }));
vi.mock('../app/operator/actions', () => ({ createCustomerAction: vi.fn(), requestReissueAction: vi.fn() }));
vi.mock('../localization/registry', () => ({ countryPacks: () => [{ country: 'MY' }] }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); } }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en', getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import OperatorPage from '../app/operator/page';

beforeEach(() => { state.operator = true; state.demo = false; state.list.mockClear(); });

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

  it.each([{ operator: false, demo: false }, { operator: true, demo: true }])('refuses the console before data or documentation is rendered: %j', async flags => {
    Object.assign(state, flags);
    await expect(OperatorPage()).rejects.toThrow('redirect');
    expect(state.list).not.toHaveBeenCalled();
  });
});
