import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { activationLoginHref } from '../lib/internal-auth/login-navigation';
vi.mock('../lib/internal-auth/config', () => ({ internalSelected: () => true, internalConfig: () => ({ organization: 'installation' }) }));
vi.mock('../lib/internal-auth/web-session', () => ({ currentInternalIdentity: async () => null }));
vi.mock('../lib/login-presentation-server', () => ({ publicLoginPresentation: async () => undefined }));
vi.mock('../lib/principals', () => ({ listPrincipals: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: vi.fn() }));
vi.mock('../app/auth-actions', () => ({ signOutUnlinkedAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), redirect: () => { throw new Error('unexpected redirect'); } }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => <img {...props}/> }));
import LoginPage from '../app/(auth)/login/page';
afterEach(cleanup);
async function show(organization?: string | string[]) {
  render(<NextIntlClientProvider locale="en" messages={en}>{await LoginPage({ searchParams: Promise.resolve({ organization }) })}</NextIntlClientProvider>);
}
describe('activation to login handoff', () => {
  it('prefills the customer organization carried by the activation destination, leaving credentials empty', async () => {
    const target = new URL(activationLoginHref('new-customer'), 'https://hr.test');
    expect(target.pathname).toBe('/login');
    await show(target.searchParams.get('organization')!);
    expect(screen.getByLabelText(en.internalAuth.organization)).toHaveValue('new-customer');
    expect(screen.getByLabelText(en.internalAuth.username)).toHaveValue('');
    expect(screen.getByLabelText(en.internalAuth.password)).toHaveValue('');
  });
  it.each([undefined, '', '//other.test', 'javascript:alert(1)', ['customer-a', 'customer-b']])('ignores an absent or malformed public organization hint: %j', async hint => {
    await show(hint);
    expect(screen.getByLabelText(en.internalAuth.organization)).toHaveValue('installation');
    expect(activationLoginHref(hint)).toBe('/login');
  });
  it('normalizes a valid hint without locking the organization field', async () => {
    await show(' New-Customer ');
    expect(screen.getByLabelText(en.internalAuth.organization)).toHaveValue('new-customer');
    expect(screen.getByLabelText(en.internalAuth.organization)).not.toHaveAttribute('readonly');
    expect(activationLoginHref(' New-Customer ')).toBe('/login?organization=new-customer');
  });
});
