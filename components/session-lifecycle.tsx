'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { isAuthRoute } from '@/lib/auth-routes';
import { ACTIVITY_REPORT_INTERVAL_SECONDS, IDLE_WARNING_SECONDS } from '@/lib/session-policy';

/**
 * The shell's one owner of how a session ends (ADR-0171).
 *
 * 1. Leaving the shell: app/layout.tsx is the root layout for both the shell and the login flow and picks between
 *    them from `x-pathname`, which only happens on a document load. A server redirect to /login followed by the
 *    client router kept the old sidebar and top bar mounted around the login form. Landing on a login-flow route
 *    covers the shell at once and reloads the document.
 * 2. Idle sign-out (only where the server enforces it): real input in any tab counts as activity; it is reported
 *    to the server at most once a minute plus once when input stops, the last IDLE_WARNING_SECONDS show a
 *    countdown, and at the limit the session is revoked and every tab goes to the login page.
 *
 * The server's limit is authoritative; this component only makes it visible and tidy.
 */

const RELOAD_KEY = 'aihr-auth-route-reload';
const LOOP_WINDOW_MS = 10_000;
const ACTIVITY_KEY = 'aihr-session-activity';
const SIGNED_OUT_KEY = 'aihr-session-signed-out';
const replaceDocument = (href: string) => window.location.replace(href);
/** The address this document already asked to reload; a repeat effect run must not count as a loop. */
let requested: string | null = null;

type Shared = { input: number; reportedAt: number; serverDeadline: number | null };

function readShared(): Shared | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(ACTIVITY_KEY) ?? 'null') as Shared | null;
    return value && Number.isFinite(value.input) && Number.isFinite(value.reportedAt) ? value : null;
  } catch { return null; }
}
function writeShared(value: Shared) {
  try { window.localStorage.setItem(ACTIVITY_KEY, JSON.stringify(value)); } catch { /* this tab keeps its own copy */ }
}

export type SessionLifecycleProps = {
  /** Null where the server does not enforce idle sign-out (legacy providers, local development). */
  idleTimeoutSeconds: number | null;
  reload?: (href: string) => void;
  now?: () => number;
  report?: () => Promise<Response>;
  signOut?: () => Promise<unknown>;
};

const reportActivity = () => fetch('/login/api/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' });
const revoke = () => fetch('/login/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' });

export function SessionLifecycle({ idleTimeoutSeconds, reload = replaceDocument, now = Date.now, report = reportActivity, signOut = revoke }: SessionLifecycleProps) {
  const pathname = usePathname();
  const leaving = isAuthRoute(pathname);
  const [suppressed, setSuppressed] = useState<string | null>(null);

  useEffect(() => {
    if (!leaving) return;
    const href = window.location.href;
    if (requested === href) return;
    // A shell rendered on an auth route by the server itself (x-pathname missing) would otherwise reload
    // forever; reload at most once per address within the window.
    try {
      const last = window.sessionStorage.getItem(RELOAD_KEY) ?? '';
      const at = last.slice(0, last.indexOf('|'));
      if (last.slice(last.indexOf('|') + 1) === href && Date.now() - Number(at) < LOOP_WINDOW_MS) return setSuppressed(pathname);
      window.sessionStorage.setItem(RELOAD_KEY, `${Date.now()}|${href}`);
    } catch {
      // Storage unavailable: still leave the stale shell.
    }
    requested = href;
    reload(href);
  }, [leaving, pathname, reload]);

  if (leaving) return suppressed === pathname ? null : <div data-auth-route-reload aria-busy="true" className="fixed inset-0 z-[2147483647] bg-canvas" />;
  return idleTimeoutSeconds ? <IdleSignOut idleTimeoutSeconds={idleTimeoutSeconds} reload={reload} now={now} report={report} signOut={signOut} /> : null;
}

function IdleSignOut({ idleTimeoutSeconds, reload, now, report, signOut }: Required<Omit<SessionLifecycleProps, 'idleTimeoutSeconds'>> & { idleTimeoutSeconds: number }) {
  const t = useTranslations('sessionTimeout');
  const idleMs = idleTimeoutSeconds * 1000;
  const state = useRef<Shared>({ input: now(), reportedAt: 0, serverDeadline: null });
  const reporting = useRef(false);
  const ended = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const leave = useCallback((announce: boolean) => {
    if (ended.current) return;
    ended.current = true;
    if (announce) try { window.localStorage.setItem(SIGNED_OUT_KEY, String(now())); } catch { /* other tabs reach the server limit themselves */ }
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const href = `/login?reason=idle&returnTo=${encodeURIComponent(returnTo)}`;
    void signOut().catch(() => undefined).finally(() => reload(href));
  }, [now, reload, signOut]);

  const send = useCallback(async () => {
    if (reporting.current || ended.current) return;
    reporting.current = true;
    const sentAt = now();
    try {
      const response = await report();
      if (response.status === 401) return leave(true);
      if (!response.ok) return;
      const body = await response.json() as { remainingSeconds?: unknown };
      const seconds = typeof body.remainingSeconds === 'number' && Number.isFinite(body.remainingSeconds) ? body.remainingSeconds : null;
      state.current = { ...(readShared() ?? state.current), reportedAt: sentAt, serverDeadline: seconds === null ? null : sentAt + seconds * 1000 };
      writeShared(state.current);
    } catch {
      // Offline or unavailable: the next tick retries; the server limit still applies.
    } finally { reporting.current = false; }
  }, [leave, now, report]);

  useEffect(() => {
    const shared = readShared();
    if (shared) state.current = shared; else writeShared(state.current);
    let lastWrite = 0;
    const onInput = () => {
      const at = now(), warning = dialog.current?.open === true;
      if (!warning && at - state.current.input < 1_000) return;
      state.current = { ...(readShared() ?? state.current), input: at };
      if (at - lastWrite > 5_000) { lastWrite = at; writeShared(state.current); }
      if (warning && at - state.current.reportedAt > 2_000) void send();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SIGNED_OUT_KEY && event.newValue) leave(false);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll'] as const;
    for (const name of events) window.addEventListener(name, onInput, { passive: true, capture: true });
    window.addEventListener('storage', onStorage);
    const tick = window.setInterval(() => {
      const current = { ...(readShared() ?? state.current) };
      if (current.input < state.current.input) current.input = state.current.input;
      state.current = current;
      const at = now();
      // Report once a minute while active, and once more shortly after input stops, so the server's clock never
      // lags the last real activity by more than a few seconds.
      const unreported = current.input > current.reportedAt;
      if (unreported && (at - current.reportedAt >= ACTIVITY_REPORT_INTERVAL_SECONDS * 1000 || at - current.input >= 15_000)) void send();
      const local = current.input + idleMs;
      // The server's own deadline wins when it is earlier: its clock is the one that actually ends the session.
      const deadline = current.serverDeadline === null ? local : Math.min(local, current.serverDeadline);
      const left = Math.ceil((deadline - at) / 1000);
      if (left <= 0) return leave(true);
      setRemaining(left <= IDLE_WARNING_SECONDS ? left : null);
    }, 1_000);
    return () => {
      for (const name of events) window.removeEventListener(name, onInput, { capture: true });
      window.removeEventListener('storage', onStorage);
      window.clearInterval(tick);
    };
  }, [idleMs, leave, now, send]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (remaining !== null && !node.open) { if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', ''); }
    if (remaining === null && node.open) { if (typeof node.close === 'function') node.close(); else node.removeAttribute('open'); }
  }, [remaining]);

  const stay = () => {
    state.current = { ...(readShared() ?? state.current), input: now() };
    writeShared(state.current);
    setRemaining(null);
    void send();
  };

  return <dialog ref={dialog} data-idle-warning aria-labelledby="idle-warning-title" aria-describedby="idle-warning-body"
    onCancel={event => { event.preventDefault(); stay(); }}
    className="m-auto w-[min(28rem,92vw)] rounded-xl border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/50">
    <h2 id="idle-warning-title" className="text-lg font-semibold">{t('warningTitle')}</h2>
    <p id="idle-warning-body" role="timer" aria-live="polite" className="mt-2 text-sm text-muted-foreground">{t('warningBody', { seconds: remaining ?? IDLE_WARNING_SECONDS })}</p>
    <div className="mt-6 flex flex-wrap justify-end gap-3">
      <Button type="button" variant="outline" onClick={() => leave(true)}>{t('signOutNow')}</Button>
      <Button type="button" onClick={stay} autoFocus>{t('staySignedIn')}</Button>
    </div>
  </dialog>;
}
