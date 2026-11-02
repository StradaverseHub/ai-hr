import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { rememberedMfaCopy } from '../lib/remembered-mfa-copy';
import { RememberedMfaForm } from '../app/admin/settings/login/remembered-mfa-form';
import { InternalAuthForm } from '../app/login/internal-form';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('next/image', () => ({ default: ({ unoptimized: _u, ...props }: Record<string, unknown>) => <img {...props}/> }));
const saved = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ status: 'saved', revision: 1 })));
vi.mock('../app/admin/settings/login/remembered-mfa-actions', () => ({ saveRememberedMfaAction: (...args: unknown[]) => saved(...args) }));
const wrap = (child: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{child}</NextIntlClientProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); saved.mockClear(); });
const copy = rememberedMfaCopy('en');
describe('remembered MFA controls', () => {
  it('saves an administrator interval with its concurrency revision', async () => {
    const user = userEvent.setup(); wrap(<RememberedMfaForm policy={{ rememberDays: 30 }} revision={0}/>);
    const days = screen.getByRole('spinbutton', { name: copy.days });
    expect(days).toHaveAttribute('min', '0'); expect(days).toHaveAttribute('max', '90');
    await user.clear(days); await user.type(days, '7'); await user.click(screen.getByRole('button', { name: copy.save }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(copy.saved));
    const form = (saved.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(form.get('rememberDays')).toBe('7'); expect(form.get('revision')).toBe('0');
  });
  it('offers remembering only after a server MFA challenge and sends opt-in with the code', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ step: 'mfa', challenge: 'c'.repeat(43), rememberDays: 7 }))
      .mockResolvedValueOnce(Response.json({ error: 'invalidCode' }, { status: 400 }));
    vi.stubGlobal('fetch', fetcher); const user = userEvent.setup(); wrap(<InternalAuthForm organization="alpha"/>);
    expect(screen.queryByRole('checkbox', { name: copy.rememberWeb.replace('{days}', '7') })).toBeNull();
    await user.type(screen.getByLabelText(en.internalAuth.username), 'employee');
    await user.type(screen.getByLabelText(en.internalAuth.password), 'Private test password');
    await user.click(screen.getByRole('button', { name: en.internalAuth.signIn }));
    const choice = await screen.findByRole('checkbox', { name: copy.rememberWeb.replace('{days}', '7') });
    expect(choice).not.toBeChecked(); await user.click(choice);
    await user.type(screen.getByLabelText(en.internalAuth.codeOrRecovery), '123456');
    await user.click(screen.getByRole('button', { name: en.internalAuth.continue }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe('/login/api/mfa');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ code: '123456', rememberDevice: 'on' });
  });
});
