import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { PasswordPolicyForm } from '../app/admin/settings/login/password-policy-form';
import { DEFAULT_PASSWORD_POLICY } from '../lib/password-policy';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vietnamese from '../messages/vi.json';
const save = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ status: 'saved', revision: 1 })));
vi.mock('../app/admin/settings/login/password-policy-actions', () => ({ savePasswordPolicyAction: (...args: unknown[]) => save(...args) }));
afterEach(() => { cleanup(); save.mockReset(); save.mockResolvedValue({ status: 'saved', revision: 1 }); });
function wrap(locale = 'en', messages = en) {
  return render(<NextIntlClientProvider locale={locale} messages={messages} onError={error => { throw error; }}><PasswordPolicyForm policy={DEFAULT_PASSWORD_POLICY} revision={0}/></NextIntlClientProvider>);
}
describe('password security settings', () => {
  it.each(Object.entries({ en, ms, zh, ta, th, vi: vietnamese }))('renders accessible policy fields in %s', (locale, messages) => {
    wrap(locale, messages);
    expect(screen.getByRole('heading', { name: messages.passwordPolicy.title })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: messages.passwordPolicy.enabled })).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: messages.passwordPolicy.interval })).toHaveValue(90);
    expect(screen.getByRole('combobox', { name: messages.passwordPolicy.unit })).toHaveValue('days');
    expect(screen.getByText(messages.passwordPolicy.reuse)).toBeInTheDocument();
  });
  it('shows the existing-account effect and submits an exact calendar-month policy with revision', async () => {
    wrap();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(en.passwordPolicy.effect)).toBeInTheDocument();
    const interval = screen.getByRole('spinbutton');
    await userEvent.clear(interval); await userEvent.type(interval, '3');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'months');
    expect(interval).toHaveAttribute('max', '120');
    await userEvent.click(screen.getByRole('button', { name: en.passwordPolicy.save }));
    expect(await screen.findByRole('status')).toHaveTextContent(en.passwordPolicy.result.saved);
    const data = save.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(data)).toMatchObject({ enabled: 'on', interval: '3', unit: 'months', revision: '0' });
    await userEvent.click(screen.getByRole('button', { name: en.passwordPolicy.save }));
    expect((save.mock.calls[1][1] as FormData).get('revision')).toBe('1');
  });
  it('shows a stale-save refusal and keeps the form editable', async () => {
    save.mockResolvedValueOnce({ status: 'conflict', revision: 0 }); wrap();
    await userEvent.click(screen.getByRole('button', { name: en.passwordPolicy.save }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.passwordPolicy.result.conflict);
    expect(screen.getByRole('button', { name: en.passwordPolicy.save })).toBeEnabled();
  });
});
