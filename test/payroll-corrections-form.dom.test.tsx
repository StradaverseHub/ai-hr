import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ save: vi.fn(), revalidate: vi.fn(), session: { tenantId: 'actual-tenant' } }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/authz', () => ({ requireAdmin: async () => mocks.session }));
vi.mock('@/core/tenant-settings', () => ({ setTenantSetting: mocks.save, TenantSettingError: class extends Error { reason = 'not_group_admin'; } }));
import { PayrollCorrectionsForm } from '../app/(app)/payroll/setup/corrections-form';
import { savePayrollCorrections } from '../app/(app)/payroll/setup/corrections-actions';
const labels = { title: 'Payroll correction controls', label: 'Allow payroll reset and employee removal', description: 'Show both buttons on unpublished runs.', scope: 'Applies to all companies.', readOnly: 'Only group admins can change this setting.', save: 'Save correction setting', saving: 'Saving…', saved: 'Setting saved.' };
beforeEach(() => { vi.clearAllMocks(); mocks.save.mockResolvedValue(undefined); });
afterEach(cleanup);

describe('payroll correction settings form', () => {
  it('renders the saved switch, saves off and reports success', async () => {
    render(<PayrollCorrectionsForm enabled canEdit labels={labels} />);
    const toggle = screen.getByRole('switch', { name: labels.label });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: labels.save }));
    await screen.findByText(labels.saved);
    expect(mocks.save).toHaveBeenCalledWith(mocks.session, { key: 'payroll.reset_enabled', value: false });
    expect(toggle).not.toBeChecked();
    expect(mocks.revalidate).toHaveBeenCalledWith('/payroll', 'layout');
  });
  it('saves on without trusting posted tenant or setting key', async () => {
    const data = new FormData(); data.set('enabled', 'on'); data.set('tenantId', 'other'); data.set('key', 'payroll.unlock_enabled');
    expect(await savePayrollCorrections({}, data)).toEqual({ saved: true });
    expect(mocks.save).toHaveBeenCalledWith(mocks.session, { key: 'payroll.reset_enabled', value: true });
  });
  it('shows company admins the current value without an editable switch or save button', () => {
    render(<PayrollCorrectionsForm enabled canEdit={false} labels={labels} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(labels.readOnly)).toBeVisible();
  });
  it('shows a recoverable error and retains the selection when saving fails', async () => {
    mocks.save.mockRejectedValue(new Error('private backend failure'));
    render(<PayrollCorrectionsForm enabled={false} canEdit labels={labels} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: labels.save }));
    expect(await screen.findByRole('alert')).toHaveTextContent('failed');
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.queryByText(labels.saved)).toBeNull();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it('disables controls while saving', async () => {
    let finish!: () => void;
    mocks.save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<PayrollCorrectionsForm enabled={false} canEdit labels={labels} />);
    fireEvent.click(screen.getByRole('button', { name: labels.save }));
    await waitFor(() => expect(screen.getByRole('button', { name: labels.saving })).toBeDisabled());
    expect(screen.getByRole('switch')).toBeDisabled();
    finish();
    await screen.findByText(labels.saved);
  });
  it('rejects malformed or duplicate switch values without writing', async () => {
    for (const values of [['true'], ['on', 'on']]) {
      const data = new FormData(); values.forEach(value => data.append('enabled', value));
      expect(await savePayrollCorrections({}, data)).toEqual({ error: 'invalid' });
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
