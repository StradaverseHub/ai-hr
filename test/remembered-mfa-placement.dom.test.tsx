import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import PasswordPolicyPage from '../app/admin/security-center/password-policy/page';
import {DEFAULT_PASSWORD_POLICY} from '../lib/password-policy';
import {rememberedMfaCopy} from '../lib/remembered-mfa-copy';
import en from '../messages/en.json';

const state = vi.hoisted(() => ({
  internal: true,
  read: vi.fn(async (_session: unknown) => ({policy: {rememberDays: 7}, revision: 3})),
}));

vi.mock('../lib/security-center-authz', () => ({
  requireGroupAdministration: vi.fn(async () => ({tenantId: 'tenant', userId: 'admin'})),
}));
vi.mock('../core/password-policy', () => ({
  readPasswordPolicy: vi.fn(async () => ({policy: DEFAULT_PASSWORD_POLICY, revision: 0})),
}));
vi.mock('../core/remembered-mfa-policy', () => ({
  readRememberedMfaPolicyEditor: (session: unknown) => state.read(session),
}));
vi.mock('../lib/internal-auth/config', () => ({internalSelected: () => state.internal}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key === 'title' ? en.passwordPolicy.title : key),
}));
vi.mock('../app/admin/users/security-page', () => ({
  SecurityPageHeader: ({title}: {title: string}) => <h1>{title}</h1>,
}));
vi.mock('../app/admin/security-center/password-policy/actions', () => ({
  saveFullPasswordPolicy: vi.fn(),
}));
vi.mock('../app/admin/settings/login/remembered-mfa-actions', () => ({
  saveRememberedMfaAction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  state.internal = true;
  state.read.mockClear();
});

describe('authenticator frequency on the Password page', () => {
  it('loads the saved policy after the existing password form', async () => {
    render(<NextIntlClientProvider locale="en" messages={en}>{await PasswordPolicyPage()}</NextIntlClientProvider>);
    const copy = rememberedMfaCopy('en');
    const frequency = screen.getByRole('spinbutton', {name: copy.days});
    expect(frequency).toHaveValue(7);
    expect(frequency).toHaveAttribute('min', '0');
    expect(frequency).toHaveAttribute('max', '90');
    expect(frequency.closest('form')?.querySelector('input[name="revision"]')).toHaveValue('3');
    const forms = [...document.querySelectorAll('form')];
    expect(forms).toHaveLength(2);
    expect(forms[1]).toBe(frequency.closest('form'));
    expect(state.read).toHaveBeenCalledTimes(1);
  });

  it('keeps the provider-specific editor hidden for compatibility providers', async () => {
    state.internal = false;
    render(<NextIntlClientProvider locale="en" messages={en}>{await PasswordPolicyPage()}</NextIntlClientProvider>);
    expect(screen.queryByRole('heading', {name: rememberedMfaCopy('en').title})).not.toBeInTheDocument();
    expect(state.read).not.toHaveBeenCalled();
  });
});
