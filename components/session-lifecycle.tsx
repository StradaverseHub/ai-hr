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

function readShared(key: string): Shared | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Shared | null;
    return value && Number.isFinite(value.input) && Number.isFinite(value.reportedAt) ? value : null;
  } catch { return null; }
}
function writeShared(key: string, value: Shared) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* this tab keeps its own copy */ }
}

export type SessionLifecycleProps = {
  /** Null where the server does not enforce idle sign-out (legacy providers, local development). */
  idleTimeoutSeconds: number | null;
  sessionChannel?: string;
  reload?: (href: string) => void;
  now?: () => number;
  report?: () => Promise<Response>;
  signOut?: () => Promise<unknown>;
};

const reportActivity = () => fetch('/login/api/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin', signal: AbortSignal.timeout(10_000) });
const revoke = () => fetch('/login/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' });

export function SessionLifecycle({ idleTimeoutSeconds, sessionChannel, reload = replaceDocument, now = Date.now, report = reportActivity, signOut = revoke }: SessionLifecycleProps) {
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
  return idleTimeoutSeconds ? <IdleSignOut key={sessionChannel} sessionChannel={sessionChannel} idleTimeoutSeconds={idleTimeoutSeconds} reload={reload} now={now} report={report} signOut={signOut} /> : null;
}

function IdleSignOut({ idleTimeoutSeconds, sessionChannel, reload, now, report, signOut }: Required<Omit<SessionLifecycleProps, 'idleTimeoutSeconds' | 'sessionChannel'>> & { idleTimeoutSeconds: number; sessionChannel?: string }) {
  const t = useTranslations('sessionTimeout');
  const idleMs = idleTimeoutSeconds * 1000;
  const state = useRef<Shared>({ input: now(), reportedAt: 0, serverDeadline: null });
  const activityKey = sessionChannel ? `${ACTIVITY_KEY}:${sessionChannel}` : ACTIVITY_KEY;
  const signedOutKey = sessionChannel ? `${SIGNED_OUT_KEY}:${sessionChannel}` : SIGNED_OUT_KEY;
  const reporting = useRef<Promise<boolean> | null>(null);
  const extending = useRef(false);
  const [extension, setExtension] = useState<'pending' | 'failed' | null>(null);
  const ended = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  /** False once the server says no enforcing provider owns this session (ADR-0171 provider contract). */
  const [enforced, setEnforced] = useState(true);

  const leave = useCallback((announce: boolean) => {
    if (ended.current) return;
    ended.current = true;
    if (announce) try { window.localStorage.setItem(signedOutKey, String(now())); } catch { /* other tabs reach the server limit themselves */ }
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const href = `/login?reason=idle&returnTo=${encodeURIComponent(returnTo)}`;
    void signOut().catch(() => undefined).finally(() => reload(href));
  }, [now, reload, signOut, signedOutKey]);

  const send = useCallback(() => {
    if (reporting.current) return reporting.current;
    if (ended.current) return Promise.resolve(false);
    const sentAt = now();
    const pending = (async () => {
      try {
        const response = await report();
        if (ended.current) return false;
        if (response.status === 401) { leave(true); return false; }
        if (!response.ok) return false;
        const body = await response.json() as { step?: unknown; remainingSeconds?: unknown; sessionChannel?: unknown };
        if (ended.current) return false;
        if (body.step === 'not-enforced') { setRemaining(null); setEnforced(false); return true; }
        if (body.step !== 'active' || (sessionChannel && body.sessionChannel !== sessionChannel) ||
          typeof body.remainingSeconds !== 'number' || !Number.isFinite(body.remainingSeconds) || body.remainingSeconds <= 0) return false;
        const shared = readShared(activityKey);
        if (!shared || shared.reportedAt <= sentAt) {
          state.current = {
            input: Math.max(shared?.input ?? 0, state.current.input, extending.current ? sentAt : 0),
            reportedAt: sentAt,
            serverDeadline: sentAt + body.remainingSeconds * 1000,
          };
          writeShared(activityKey, state.current);
        }
        return true;
      } catch {
        return false;
      }
    })();
    reporting.current = pending;
    void pending.finally(() => { reporting.current = null; });
    return pending;
  }, [activityKey, leave, now, report, sessionChannel]);

  useEffect(() => {
    if (!enforced) return;
    // Loading the document is activity. Storage can hold an earlier session's figures (signed out yesterday, or
    // in another account); they must never end this one, so its server deadline is dropped until the first report.
    const shared = readShared(activityKey);
    state.current = { input: Math.max(shared?.input ?? 0, now()), reportedAt: shared?.reportedAt ?? 0, serverDeadline: sessionChannel ? shared?.serverDeadline ?? null : null };
    writeShared(activityKey, state.current);
    let lastWrite = 0;
    const onInput = () => {
      const at = now(), warning = dialog.current?.open === true;
      if (warning || at - state.current.input < 1_000) return;
      state.current = { ...(readShared(activityKey) ?? state.current), input: at };
      if (at - lastWrite > 5_000) { lastWrite = at; writeShared(activityKey, state.current); }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === signedOutKey && event.newValue) leave(false);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll'] as const;
    for (const name of events) window.addEventListener(name, onInput, { passive: true, capture: true });
    window.addEventListener('storage', onStorage);
    const tick = window.setInterval(() => {
      const current = { ...(readShared(activityKey) ?? state.current) };
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
      if (left <= 0 && !extending.current) return leave(true);
      setRemaining(left <= IDLE_WARNING_SECONDS ? Math.max(0, left) : null);
      if (left > IDLE_WARNING_SECONDS && !extending.current) setExtension(null);
    }, 1_000);
    return () => {
      for (const name of events) window.removeEventListener(name, onInput, { capture: true });
      window.removeEventListener('storage', onStorage);
      window.clearInterval(tick);
    };
  }, [activityKey, enforced, idleMs, leave, now, send, sessionChannel, signedOutKey]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (remaining !== null && !node.open) { if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', ''); }
    if (remaining === null && node.open) { if (typeof node.close === 'function') node.close(); else node.removeAttribute('open'); }
  }, [remaining]);

  if (!enforced) return null;
  const stay = async () => {
    if (extending.current || ended.current) return;
    extending.current = true;
    setExtension('pending');
    // An earlier background report may have been recorded before the operator pressed Stay signed in.
    // Let it settle before sending the explicit activity.
    if (reporting.current) await reporting.current;
    const confirmed = await send();
    extending.current = false;
    if (ended.current) return;
    setExtension(confirmed ? null : 'failed');
  };

  return <dialog ref={dialog} data-idle-warning aria-labelledby="idle-warning-title" aria-describedby="idle-warning-body"
    onCancel={event => { event.preventDefault(); stay(); }}
    className="m-auto w-[min(28rem,92vw)] rounded-xl border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/50">
    <h2 id="idle-warning-title" className="text-lg font-semibold">{t('warningTitle')}</h2>
    <p id="idle-warning-body" role="timer" aria-live="polite" className="mt-2 text-sm text-muted-foreground">{t('warningBody', { seconds: remaining ?? IDLE_WARNING_SECONDS })}</p>
    {extension === 'failed' && <p role="alert" className="mt-2 text-sm text-destructive">{t('extensionFailed')}</p>}
    <div className="mt-6 flex flex-wrap justify-end gap-3">
      <Button type="button" variant="outline" onClick={() => leave(true)}>{t('signOutNow')}</Button>
      <Button type="button" onClick={stay} disabled={extension === 'pending'} aria-busy={extension === 'pending'} autoFocus>{t(extension === 'pending' ? 'checkingExtension' : 'staySignedIn')}</Button>
    </div>
  </dialog>;
}
