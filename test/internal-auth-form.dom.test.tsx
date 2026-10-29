import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { InternalAuthForm } from '../app/login/internal-form';
import en from '../messages/en.json';
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => <img {...props}/> }));
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
const fetcher = vi.fn<typeof fetch>();
function view(props: Parameters<typeof InternalAuthForm>[0] = {},locale='en') {
  vi.stubGlobal('fetch', fetcher);
  return render(<NextIntlClientProvider locale={locale} messages={en}><InternalAuthForm organization="alpha" {...props}/></NextIntlClientProvider>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetcher.mockReset(); navigation.replace.mockReset(); window.history.replaceState(null, '', '/'); });
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
  it('binds a public recovery request to the language selected on the login page',async()=>{
    fetcher.mockResolvedValue(Response.json({step:'sent'}));view({mode:'recovery'},'ms');const user=userEvent.setup();
    await user.type(screen.getByLabelText(en.internalAuth.username),'employee');await user.click(screen.getByRole('button',{name:en.internalAuth.sendLink}));
    await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());const [url,init]=fetcher.mock.calls[0];expect(url).toBe('/login/api/recovery');expect(JSON.parse(String(init?.body))).toMatchObject({locale:'ms',organization:'alpha',username:'employee'});
  });
  it('finishes activation at login with the organization filled after recovery codes are saved', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ step: 'enroll', challenge: 'a'.repeat(43), secret: 'MANUALKEY', qr: 'data:image/png;base64,fixture' }))
      .mockResolvedValueOnce(Response.json({ step: 'activated', organization: 'new-customer', recoveryCodes: Array.from({ length: 8 }, (_, i) => 'PRIVATE-CODE-' + i) }));
    view({ mode: 'invite', invitation: 'i'.repeat(43) }); const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.internalAuth.username), 'new.user');
    await user.type(screen.getByLabelText(en.internalAuth.newPassword), 'A private secure phrase 775!');
    await user.type(screen.getByLabelText(en.internalAuth.confirmation), 'A private secure phrase 775!');
    await user.click(screen.getByRole('button', { name: en.internalAuth.continue }));
    expect(await screen.findByText('MANUALKEY')).toBeInTheDocument(); expect(screen.getByAltText(en.internalAuth.qrAlt)).toBeInTheDocument();
    await user.type(screen.getByLabelText(en.internalAuth.code), '123456');
    await user.click(screen.getByRole('button', { name: en.internalAuth.continue }));
    expect(await screen.findByRole('heading', { name: en.internalAuth.codesTitle })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: en.internalAuth.codesSaved })).toBeRequired();
    expect(navigation.replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: en.internalAuth.signIn }));
    expect(navigation.replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: en.internalAuth.codesSaved }));
    await user.click(screen.getByRole('button', { name: en.internalAuth.signIn }));
    expect(navigation.replace).toHaveBeenCalledExactlyOnceWith('/login?organization=new-customer');
    expect(fetcher.mock.calls[1][0]).toBe('/login/api/mfa');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ code: '123456', challenge: 'a'.repeat(43), token: 'i'.repeat(43) });
  });
  it('routes an accepted existing account straight to login without an extra continue screen', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ step: 'activated', organization: 'new-customer' }));
    view({ mode: 'accept', invitation: 'i'.repeat(43), returnTo: '/operator' });
    await userEvent.setup().click(screen.getByRole('button', { name: en.internalAuth.continue }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledExactlyOnceWith('/login?organization=new-customer'));
    expect(fetcher.mock.calls[0][0]).toBe('/login/api/accept-invite');
  });
  it('8e830f17: a correct authenticator code shows "Signing you in…" with nothing to press, then opens AIHR', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    fetcher.mockResolvedValueOnce(Response.json({ step: 'mfa', challenge: 'c'.repeat(43) }))
      .mockResolvedValueOnce(Response.json({ step: 'complete' }));
    view({ returnTo: '/home' }); const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.internalAuth.username), 'employee');
    await user.type(screen.getByLabelText(en.internalAuth.password), 'Private fixture password');
    await user.click(screen.getByRole('button', { name: en.internalAuth.signIn }));
    await user.type(await screen.findByLabelText(en.internalAuth.codeOrRecovery), '123456');
    await user.click(screen.getByRole('button', { name: en.internalAuth.continue }));
    expect(await screen.findByRole('heading', { name: en.internalAuth.signingInTitle })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(en.internalAuth.signingInHelp);
    // The stray screen this replaces: a "Sign in" heading with a Continue button that POSTed /login/api/complete.
    const auth = screen.getByRole('region', { name: en.internalAuth.signingInTitle });
    expect(within(auth).queryByRole('button')).toBeNull();
    expect(auth.querySelector('form')).toBeNull();
    expect(screen.getByRole('region', { name: en.loginTour.label })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: en.internalAuth.loginTitle })).toBeNull();
    expect(assign).toHaveBeenCalledExactlyOnceWith('/home');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/login/api/login', '/login/api/mfa']);
  });
  it('8e830f17: an activation without recovery codes shows the same status, not the generic form', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ step: 'activated', organization: 'new-customer' }));
    view({ mode: 'accept', invitation: 'i'.repeat(43) });
    await userEvent.setup().click(screen.getByRole('button', { name: en.internalAuth.continue }));
    expect(await screen.findByRole('heading', { name: en.internalAuth.signingInTitle })).toBeInTheDocument();
    const auth = screen.getByRole('region', { name: en.internalAuth.signingInTitle });
    expect(within(auth).queryByRole('button')).toBeNull();
    expect(auth.querySelector('form')).toBeNull();
    expect(screen.getByRole('region', { name: en.loginTour.label })).toBeInTheDocument();
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
