import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { InternalAuthForm } from '../app/login/internal-form';
import { REMEMBERED_WORKSPACE_KEY, rememberedWorkspace, rememberWorkspace } from '../lib/internal-auth/remembered-workspace';
import enBase from '../messages/en.json';
import enEditorial from '../messages/login-editorial/en.json';
const en = { ...enBase, loginEditorial: enEditorial };
vi.mock('next/image', () => ({ default: ({ unoptimized: _unoptimized, ...props }: Record<string, unknown>) => <img {...props}/> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
const fetcher = vi.fn<typeof fetch>();
const availability = vi.fn<typeof fetch>();
function mount(props: Parameters<typeof InternalAuthForm>[0] = {}) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('/login/entra/options?') ? availability(input, init) : fetcher(input, init));
  return render(<NextIntlClientProvider locale="en" messages={enBase}><InternalAuthForm returnTo="/me" {...props}/></NextIntlClientProvider>);
}
const workspace = () => screen.getByLabelText(en.loginEditorial.workspaceLabel);
beforeEach(() => { window.localStorage.clear(); availability.mockResolvedValue(Response.json({ microsoft: false })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fetcher.mockReset(); availability.mockReset(); window.localStorage.clear(); });

describe('remembered login workspace', () => {
  it('starts empty when the browser has nothing remembered and the installation sets no default', async () => {
    mount();
    await waitFor(() => expect(workspace()).toBeEnabled());
    expect(workspace()).toHaveValue('');
  });

  it("replaces the installation default with this browser's last workspace", async () => {
    window.localStorage.setItem(REMEMBERED_WORKSPACE_KEY, 'chinhin');
    mount({ organization: 'operator' });
    await waitFor(() => expect(workspace()).toHaveValue('chinhin'));
  });

  it('keeps an explicit link workspace over the remembered one', async () => {
    window.localStorage.setItem(REMEMBERED_WORKSPACE_KEY, 'chinhin');
    mount({ organization: 'new-customer', organizationFromLink: true });
    await waitFor(() => expect(workspace()).toBeEnabled());
    expect(workspace()).toHaveValue('new-customer');
  });

  it('ignores a malformed remembered value and falls back to the installation default', async () => {
    window.localStorage.setItem(REMEMBERED_WORKSPACE_KEY, '//other.test');
    mount({ organization: 'installation' });
    await waitFor(() => expect(workspace()).toBeEnabled());
    expect(workspace()).toHaveValue('installation');
  });

  it('still renders the form when browser storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(rememberedWorkspace()).toBe('');
    expect(() => rememberWorkspace('chinhin')).not.toThrow();
    mount({ organization: 'installation' });
    await waitFor(() => expect(workspace()).toBeEnabled());
    expect(workspace()).toHaveValue('installation');
  });

  it('remembers the workspace only after a successful sign-in, not after a refusal', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    fetcher.mockResolvedValueOnce(Response.json({ error: 'invalidLogin' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ step: 'complete' }));
    mount(); const user = userEvent.setup();
    await waitFor(() => expect(workspace()).toBeEnabled());
    await user.type(workspace(), ' ChinHin ');
    await user.keyboard('{Enter}');
    await user.type(screen.getByLabelText(en.internalAuth.username), 'employee');
    await user.type(screen.getByLabelText(en.internalAuth.password), 'Wrong fixture password');
    await user.click(screen.getByRole('button', { name: en.internalAuth.signIn }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.internalAuth.errors.invalidLogin);
    expect(window.localStorage.getItem(REMEMBERED_WORKSPACE_KEY)).toBeNull();
    await user.clear(screen.getByLabelText(en.internalAuth.password));
    await user.type(screen.getByLabelText(en.internalAuth.password), 'Private fixture password');
    await user.click(screen.getByRole('button', { name: en.internalAuth.signIn }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/me'));
    expect(window.localStorage.getItem(REMEMBERED_WORKSPACE_KEY)).toBe('chinhin');
  });

  it('remembers the workspace when Microsoft sign-in starts', async () => {
    availability.mockResolvedValue(Response.json({ microsoft: true }));
    mount({ organization: 'chinhin' }); const user = userEvent.setup();
    await waitFor(() => expect(workspace()).toBeEnabled());
    await user.keyboard('{Enter}');
    const microsoft = (await screen.findByRole('button', { name: en.internalAuth.microsoft })).closest('form')!;
    microsoft.addEventListener('submit', event => event.preventDefault());
    await user.click(screen.getByRole('button', { name: en.internalAuth.microsoft }));
    expect(window.localStorage.getItem(REMEMBERED_WORKSPACE_KEY)).toBe('chinhin');
  });

  it('offers the remembered workspace on the password reset request too', async () => {
    window.localStorage.setItem(REMEMBERED_WORKSPACE_KEY, 'chinhin');
    mount({ mode: 'recovery', organization: 'operator' });
    await waitFor(() => expect(screen.getByLabelText(en.internalAuth.organization)).toHaveValue('chinhin'));
  });
});
