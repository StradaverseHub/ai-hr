/**
 * ADR-0171: the shell's one owner of how a session ends. (1) A client navigation that lands on a login-flow route
 * leaves the stale shell by reloading the document, once. (2) Where the server enforces idle sign-out, the shell
 * reports real activity, warns for the last minute, and signs every tab out at the limit.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import en from '../messages/en.json';
import scopes from '../i18n/client-message-scopes.json';
import {pickClientMessages} from '../lib/client-message-tree';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { SessionLifecycle, type SessionLifecycleProps } from '../components/session-lifecycle';

const at = (path: string) => { nav.pathname = path.split('?')[0]; window.history.replaceState(null, '', path); };
const cover = () => document.querySelector('[data-auth-route-reload]');
const warning = () => document.querySelector<HTMLDialogElement>('[data-idle-warning]');
const ok = (remainingSeconds: number) => new Response(JSON.stringify({ step: 'active', idleTimeoutSeconds: 300, remainingSeconds }), { status: 200 });

type Report = Mock<() => Promise<Response>>;
function mount(props: Omit<Partial<SessionLifecycleProps>, 'report'> & { idleTimeoutSeconds: number | null; report?: Report }) {
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advance: async (ms: number) => { for (let i = 0; i < ms; i += 1000) { now += 1000; await act(() => vi.advanceTimersByTimeAsync(1000)); } } };
  const reload = vi.fn(), signOut = vi.fn(async () => undefined);
  const report: Report = props.report ?? vi.fn(async () => ok(props.idleTimeoutSeconds ?? 0));
  const all = { reload, signOut, now: clock.now, ...props, report };
  render(<NextIntlClientProvider locale="en" messages={en}><SessionLifecycle {...all} /></NextIntlClientProvider>);
  return { ...clock, ...all };
}

beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); window.sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe('leaving the shell for the login flow', () => {
  it('does nothing on an application route', () => {
    at('/leave');
    const { reload } = mount({ idleTimeoutSeconds: null });
    expect(reload).not.toHaveBeenCalled();
    expect(cover()).toBeNull();
  });

  it('covers the stale shell and reloads the login address once', () => {
    at('/login?returnTo=%2Fleave');
    const { reload } = mount({ idleTimeoutSeconds: 900 });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith('http://localhost:3000/login?returnTo=%2Fleave');
    expect(cover()).not.toBeNull();
    expect(warning()).toBeNull();
  });

  it('stops after one recent attempt for the same address and uncovers the page', () => {
    at('/reset-password?step=1');
    window.sessionStorage.setItem('aihr-auth-route-reload', `${Date.now() - 1000}|http://localhost:3000/reset-password?step=1`);
    const { reload } = mount({ idleTimeoutSeconds: null });
    expect(reload).not.toHaveBeenCalled();
    expect(cover()).toBeNull();
  });
});

describe('idle sign-out', () => {
  beforeEach(() => at('/leave?tab=history'));

  it('renders nothing where the server does not enforce an idle limit', async () => {
    const { report, advance } = mount({ idleTimeoutSeconds: null });
    await advance(5_000);
    expect(warning()).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it('reports activity, warns for the last minute, then revokes and returns to the login page with the reason', async () => {
    const { report, signOut, reload, advance } = mount({ idleTimeoutSeconds: 300 });
    await advance(1_000);
    expect(report).toHaveBeenCalledTimes(1);
    expect(warning()?.open).toBe(false);
    await advance(238_000);
    expect(warning()?.open).toBe(false);
    await advance(2_000);
    expect(warning()?.open).toBe(true);
    expect(screen.getByRole('timer').textContent).toMatch(/signed out in \d+ seconds/);
    await advance(60_000);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith('/login?reason=idle&returnTo=%2Fleave%3Ftab%3Dhistory');
    expect(window.localStorage.getItem('aihr-session-signed-out')).not.toBeNull();
  });

  it('"Stay signed in" reports at once and closes the warning', async () => {
    const { report, signOut, advance } = mount({ idleTimeoutSeconds: 300 });
    await advance(245_000);
    expect(warning()?.open).toBe(true);
    const before = report.mock.calls.length;
    report.mockImplementation(async () => ok(300));
    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    await advance(1_000);
    expect(report.mock.calls.length).toBeGreaterThan(before);
    expect(warning()?.open).toBe(false);
    await advance(120_000);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('real input keeps the session; one report follows when input stops', async () => {
    const { report, signOut, advance } = mount({ idleTimeoutSeconds: 300 });
    await advance(1_000);
    report.mockClear();
    for (let minute = 0; minute < 6; minute++) {
      fireEvent.keyDown(window, { key: 'a' });
      report.mockImplementation(async () => ok(300));
      await advance(60_000);
    }
    expect(report).toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(warning()?.open).toBe(false);
  });

  it('a server that already ended the session sends the tab straight to the login page', async () => {
    const report: Report = vi.fn(async () => new Response(JSON.stringify({ error: 'expired' }), { status: 401 }));
    const { signOut, reload, advance } = mount({ idleTimeoutSeconds: 300, report });
    await advance(1_000);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?reason=idle&returnTo=/));
  });

  it('follows another tab that signed out', async () => {
    const { reload, advance } = mount({ idleTimeoutSeconds: 300 });
    await advance(1_000);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'aihr-session-signed-out', newValue: String(Date.now()) })); });
    await advance(1_000);
    expect(reload).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?reason=idle/));
  });

  it('a session no enforcing provider owns (federated sign-in) shows no countdown and is never signed out by the shell', async () => {
    const report: Report = vi.fn(async () => new Response(JSON.stringify({ step: 'not-enforced' }), { status: 200 }));
    const { signOut, reload, advance } = mount({ idleTimeoutSeconds: 300, report });
    await advance(1_000);
    expect(report).toHaveBeenCalledTimes(1);
    await advance(400_000);
    expect(warning()).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("never ends a new session because of an earlier session's stored activity", async () => {
    window.localStorage.setItem('aihr-session-activity', JSON.stringify({ input: 1, reportedAt: 1, serverDeadline: 2 }));
    const { signOut, reload, report, advance } = mount({ idleTimeoutSeconds: 300 });
    await advance(5_000);
    expect(signOut).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(warning()?.open).toBe(false);
  });

  it("uses the server's earlier deadline when it has not heard of the latest activity", async () => {
    const report: Report = vi.fn(async () => ok(90));
    const { signOut, advance } = mount({ idleTimeoutSeconds: 300, report });
    await advance(1_000);
    await advance(30_000);
    expect(warning()?.open).toBe(true);
    await advance(60_000);
    expect(signOut).toHaveBeenCalled();
  });
});

// The real root layout sends the bounded shared catalog, rather than the complete dictionaries.
it('renders the actual idle warning from the bounded shared shell catalog',()=>{
 at('/leave');
 render(<NextIntlClientProvider locale="en" messages={pickClientMessages(en,scopes.shared.prefixes)} onError={error=>{throw error;}}><SessionLifecycle idleTimeoutSeconds={300} now={()=>1_800_000_000_000} reload={vi.fn()} report={async()=>ok(300)} signOut={async()=>undefined}/></NextIntlClientProvider>);
 expect(screen.getByText(en.sessionTimeout.warningTitle)).toBeTruthy();
 expect(screen.getByText(en.sessionTimeout.staySignedIn)).toBeTruthy();
});
