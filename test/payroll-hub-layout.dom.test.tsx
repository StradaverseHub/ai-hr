import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import messages from '../messages/en.json';

const state = vi.hoisted(() => ({ group: true, enabled: true, denied: false, typed: true }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => {
  const root = namespace.split('.').reduce((value: any, key) => value[key], messages);
  return (key: string) => key.split('.').reduce((value: any, part) => value[part], root);
} }));
vi.mock('../lib/scope', () => ({ scopedAdmin: async () => {
  if (state.denied) throw new Error('forbidden');
  return { s: { tenantId: 'fixture' }, scopeIds: [] };
} }));
vi.mock('../lib/authz', () => ({ requireAdmin: async () => {
  if (state.denied) throw new Error('forbidden');
  return { tenantId: 'fixture' };
} }));
vi.mock('../lib/authz-model', () => ({ isGroupAdmin: () => state.group }));
vi.mock('../core/entitlements', () => ({
  settingEnabledOrDefault: () => state.enabled,
  isModuleEnabledOrFalse: () => state.typed,
}));
vi.mock('../core/read', () => ({ listCompanies: async () => [] }));
vi.mock('../core/payroll-readiness', () => ({ payrollCycleReadiness: async () => [], payrollReadiness: vi.fn() }));
vi.mock('../lib/statutory-readiness', () => ({ statutoryPackStale: vi.fn() }));
vi.mock('../app/payroll/setup/corrections-form', () => ({ PayrollCorrectionsForm: (props: { enabled: boolean; canEdit: boolean }) =>
  <div data-testid="correction-form" data-enabled={String(props.enabled)} data-can-edit={String(props.canEdit)}/> }));

import Setup from '../app/payroll/setup/page';
import Corrections from '../app/payroll/setup/correction-controls/page';
import Transactions from '../app/payroll/transactions/page';

afterEach(() => { cleanup(); Object.assign(state, { group: true, enabled: true, denied: false, typed: true }); });

describe('approved payroll navigation changes', () => {
  it('opens corrections from one settings tile and leaves the inline editor off the hub', async () => {
    render(await Setup({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('link', { name: messages.payroll.setup.corrections.cta })).toHaveAttribute('href', '/payroll/setup/correction-controls');
    expect(screen.queryByTestId('correction-form')).toBeNull();
    expect(screen.getByRole('link', { name: messages.payroll.setup.cycles.cta })).toHaveAttribute('href', '/admin/payroll-cycle');
  });

  it.each([[true, true], [false, false]])('passes stored value %s and edit authority %s to the same form', async (enabled, group) => {
    Object.assign(state, { enabled, group });
    render(await Corrections());
    expect(screen.getByTestId('correction-form')).toHaveAttribute('data-enabled', String(enabled));
    expect(screen.getByTestId('correction-form')).toHaveAttribute('data-can-edit', String(group));
    expect(screen.getByRole('link', { name: new RegExp(messages.payroll.setup.title) })).toHaveAttribute('href', '/payroll/setup');
  });

  it('refuses the dedicated route when the existing administrator guard refuses', async () => {
    state.denied = true;
    await expect(Corrections()).rejects.toThrow('forbidden');
  });

  it.each([true, false])('retains seven transaction links and removes both duplicated tiles with typed-components=%s', async typed => {
    state.typed = typed;
    render(await Transactions());
    const links = screen.getAllByRole('link');
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '/payroll/transactions/fixed', '/payroll/transactions/individual', '/payroll/transactions/tp1',
      '/payroll/transactions/tp3', '/payroll/transactions/zakat', '/admin/loans', '/payroll/history-import',
    ]);
    expect(screen.queryByRole('heading', { name: messages.payroll.transactions.hub.adjustmentsTitle })).toBeNull();
    expect(screen.queryByRole('heading', { name: messages.payroll.transactions.hub.componentImportTitle })).toBeNull();
    if (!typed) expect(screen.getByText(messages.payroll.transactions.gatedTitle)).toBeVisible();
  });
});
