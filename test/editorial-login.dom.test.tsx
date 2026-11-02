import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { InternalAuthForm } from '../app/login/internal-form';
import { loginStoryAt, loginSwirlPoint, LOGIN_STORY } from '../lib/login-story';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viCopy from '../messages/vi.json';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('next/image', () => ({ default: ({ unoptimized: _unoptimized, ...props }: Record<string, unknown>) => <img {...props}/> }));
vi.mock('../app/i18n-actions', () => ({ setLocale: vi.fn() }));
const fetcher = vi.fn<typeof fetch>();
function mount(organization = '') {
  vi.stubGlobal('fetch', fetcher);
  return render(<NextIntlClientProvider locale="en" messages={en}><InternalAuthForm organization={organization} returnTo="/me"/></NextIntlClientProvider>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetcher.mockReset(); });
describe('Editorial workspace entrance', () => {
  it('does no organization or identity lookup and accepts a workspace before exposing credentials', async () => {
    mount(); const user = userEvent.setup();
    expect(screen.queryByLabelText(en.internalAuth.password)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.internalAuth.microsoft })).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: en.loginEditorial.continueLabel });
    expect(next).toBeDisabled();
    await user.type(screen.getByLabelText(en.loginEditorial.workspaceLabel), '   ');
    expect(next).toBeDisabled();
    await user.clear(screen.getByLabelText(en.loginEditorial.workspaceLabel));
    await user.type(screen.getByLabelText(en.loginEditorial.workspaceLabel), '  customer-a  ');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: en.loginEditorial.accountTitle })).toHaveFocus();
    expect(screen.getByText('customer-a')).toBeInTheDocument();
    expect(screen.getByLabelText(en.internalAuth.password)).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('changing workspace removes old credentials and binds both sign-in methods to the new workspace', async () => {
    mount('customer-a'); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: en.loginEditorial.continueLabel }));
    await user.type(screen.getByLabelText(en.internalAuth.username), 'first-user');
    await user.type(screen.getByLabelText(en.internalAuth.password), 'Private first password');
    await user.click(screen.getByRole('button', { name: en.loginEditorial.changeOrganization }));
    expect(screen.getByLabelText(en.loginEditorial.workspaceLabel)).toHaveFocus();
    await user.clear(screen.getByLabelText(en.loginEditorial.workspaceLabel));
    await user.type(screen.getByLabelText(en.loginEditorial.workspaceLabel), 'customer-b');
    await user.click(screen.getByRole('button', { name: en.loginEditorial.continueLabel }));
    expect(screen.getByLabelText(en.internalAuth.password)).toHaveValue('');
    expect(screen.getByLabelText(en.internalAuth.username)).toHaveValue('');
    const microsoft = screen.getByRole('button', { name: en.internalAuth.microsoft }).closest('form')!;
    expect(Object.fromEntries(new FormData(microsoft))).toEqual({ organization: 'customer-b', returnTo: '/me' });
    fetcher.mockResolvedValue(Response.json({ error: 'invalidLogin' }, { status: 401 }));
    await user.type(screen.getByLabelText(en.internalAuth.username), 'second-user');
    await user.type(screen.getByLabelText(en.internalAuth.password), 'Private second password');
    await user.click(screen.getByRole('button', { name: en.internalAuth.signIn }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[0][0]).toBe('/login/api/login');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ organization: 'customer-b', username: 'second-user', password: 'Private second password' });
    expect(screen.getByRole('alert')).toHaveTextContent(en.internalAuth.errors.invalidLogin);
  });
  it('cannot advance an all-whitespace workspace through a programmatic submit', () => {
    mount('  '); fireEvent.submit(screen.getByLabelText(en.loginEditorial.workspaceLabel).closest('form')!);
    expect(screen.queryByLabelText(en.internalAuth.password)).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('provides the complete presentation vocabulary, without changing authentication copy, in all six languages', () => {
    const keys = (value: Record<string, unknown>): string[] => Object.entries(value).flatMap(([key, v]) => typeof v === 'object' && v ? keys(v as Record<string, unknown>).map(nested => `${key}.${nested}`) : [key]).sort();
    for (const messages of [ms, zh, ta, th, viCopy]) expect(keys(messages.loginEditorial)).toEqual(keys(en.loginEditorial));
  });
});
describe('AI centre to Interfaces vortex', () => {
  it('shows a brief introduction, then gives most of the running time to the clockwork', () => {
    expect(LOGIN_STORY.intro).toBeLessThanOrEqual(3000);
    expect(loginStoryAt(0)).toMatchObject({ clock: false, swirl: 0, finished: false });
    expect(loginStoryAt(LOGIN_STORY.intro)).toMatchObject({ clock: true, swirl: 0, active: 'interfaces' });
    expect(loginStoryAt(LOGIN_STORY.intro + LOGIN_STORY.swirl)).toMatchObject({ clock: true, swirl: 1 });
    expect(loginStoryAt(LOGIN_STORY.end)).toMatchObject({ finished: true });
  });
  it('preserves the initial UI rectangle and sends every corner into the actual interface sink', () => {
    expect(loginSwirlPoint(0, 0, 0, [380, 170])).toMatchObject({ x: 23, y: 7 });
    expect(loginSwirlPoint(1, 1, 0, [380, 170])).toMatchObject({ x: 827, y: 519 });
    for (const sink of [[380, 170], [450, 300]] as const) for (const [u, v] of [[0, 0], [0, 1], [1, 0], [1, 1], [.5, .5]]) {
      expect(loginSwirlPoint(u, v, 1, sink)).toMatchObject({ x: sink[0], y: sink[1] });
    }
  });
});
