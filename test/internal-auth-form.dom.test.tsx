import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { InternalAuthForm } from '../app/login/internal-form';
import en from '../messages/en.json';
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => <img {...props}/> }));
const fetcher = vi.fn<typeof fetch>();
function view(props: Parameters<typeof InternalAuthForm>[0] = {}) {
  vi.stubGlobal('fetch', fetcher);
  return render(<NextIntlClientProvider locale="en" messages={en}><InternalAuthForm organization="alpha" {...props}/></NextIntlClientProvider>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetcher.mockReset(); window.history.replaceState(null, '', '/'); });
describe('embedded browser forms', () => {
  it('submits organization + username without exposing credentials in the URL and renders a safe refusal', async () => {
    fetcher.mockResolvedValue(Response.json({ error: 'invalidLogin' }, { status: 401 }));
    view(); const user = userEvent.setup();
    expect(screen.getByLabelText(en.internalAuth.password).closest('form')).toHaveAttribute('method','post');
    await user.type(screen.getByLabelText(en.internalAuth.username), 'employee');
    await user.type(screen.getByLabelText(en.internalAuth.password), 'Private fixture password');
    await user.click(screen.getByRole('button', { name: en.internalAuth.signIn }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.internalAuth.errors.invalidLogin);
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe('/login/api/login');
    expect(JSON.parse(String(init?.body))).toEqual({ organization: 'alpha', username: 'employee', password: 'Private fixture password' });
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error' });
  });
  it('keeps partial MFA setup in the form and requires a confirmation before leaving the backup-code screen', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ step: 'enroll', challenge: 'a'.repeat(43), secret: 'MANUALKEY', qr: 'data:image/png;base64,fixture' }))
      .mockResolvedValueOnce(Response.json({ step: 'complete', recoveryCodes: Array.from({ length: 8 }, (_, i) => 'PRIVATE-CODE-' + i) }));
    view({ mode: 'invite', invitation: 'i'.repeat(43) }); const user = userEvent.setup();
    expect(screen.getByText('alpha')).toBeVisible();
    await user.type(screen.getByLabelText(en.internalAuth.username), 'new.user');
    await user.type(screen.getByLabelText(en.internalAuth.newPassword), 'A private secure phrase 775!');
    await user.type(screen.getByLabelText(en.internalAuth.confirmation), 'A private secure phrase 775!');
    await user.click(screen.getByRole('button', { name: en.internalAuth.continue }));
    expect(await screen.findByText('MANUALKEY')).toBeInTheDocument(); expect(screen.getByText('alpha')).toBeVisible(); expect(screen.getByAltText(en.internalAuth.qrAlt)).toBeInTheDocument();
    await user.type(screen.getByLabelText(en.internalAuth.code), '123456');
    await user.click(screen.getByRole('button', { name: en.internalAuth.continue }));
    expect(await screen.findByRole('heading', { name: en.internalAuth.codesTitle })).toBeInTheDocument(); expect(screen.getByText('alpha')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: en.internalAuth.codesSaved })).toBeRequired();
    expect(fetcher.mock.calls[1][0]).toBe('/login/api/mfa');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ code: '123456', challenge: 'a'.repeat(43), token: 'i'.repeat(43) });
  });
  it('removes a recovery token from browser history and submits it only in the reset POST body', async () => {
    const token = 'r'.repeat(43); window.history.replaceState(null, '', '/reset-password#token=' + token);
    fetcher.mockResolvedValue(Response.json({ step: 'resetDone' })); view({ mode: 'recovery' });
    await waitFor(() => expect(window.location.hash).toBe(''));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.internalAuth.newPassword), 'A replacement private phrase 881!');
    await user.type(screen.getByLabelText(en.internalAuth.confirmation), 'A replacement private phrase 881!');
    await user.type(screen.getByLabelText(/Authenticator or recovery code/), 'RECOVERY-CODE');
    await user.click(screen.getByRole('button', { name: en.internalAuth.resetSubmit }));
    expect(await screen.findByRole('heading', { name: en.internalAuth.resetDoneTitle })).toBeInTheDocument();
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe('/login/api/reset');
    expect(JSON.parse(String(init?.body))).toMatchObject({ token, code: 'RECOVERY-CODE' });
    expect(window.location.href).not.toContain(token);
  });
});
