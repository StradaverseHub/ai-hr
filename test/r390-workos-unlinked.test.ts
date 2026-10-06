/**
 * r390 — THE TWO WAYS A REAL SIGN-IN CAN FAIL, AND WHAT THE PERSON SEES.
 *
 *  1. Signed in at WorkOS, but no AI HR account is linked to that login (never invited, archived, a leaver).
 *     Middleware used to send a signed-in /login home, and home throws AuthRequiredError back to /login: an
 *     endless redirect. /login now RENDERS for them, says which login has no account, and offers a sign-out
 *     that works without an AI HR session (logoutAction cannot: it resolves the session first).
 *  2. The callback cannot complete (stale or reused link, verifier cookie missing because the sign-in was
 *     opened in another browser). The SDK's default is a bare 500; it is now a page that says what happened
 *     and links to a fresh start on the PUBLIC origin.
 *
 * Messages are read from messages/en.json through next-intl's own translator, so a key that does not exist
 * fails here as MISSING_MESSAGE instead of rendering its name. Settings are fixture values, not credentials.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';

const ORIGIN = 'https://aihr.example.test';
// NODE_ENV stays 'test': a production NODE_ENV makes React's dev JSX runtime export no jsxDEV, so the page
// cannot render under it. The switcher's own condition is lib/demo-mode.ts's, pinned elsewhere; here it is set.
const REAL_AUTH = {
  WORKOS_API_KEY: 'sk_test_r390_fixture',
  WORKOS_CLIENT_ID: 'client_r390_fixture',
  WORKOS_COOKIE_PASSWORD: 'r390-fixture-cookie-password-at-least-32-characters',
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${ORIGIN}/callback`,
};

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  currentWorkosSession: vi.fn(),
  endWorkosSession: vi.fn(async (_returnTo?: string) => {}),
  logout: vi.fn(async (..._args: unknown[]) => {}),
  switcher: false,
}));

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = JSON.parse(fs.readFileSync('messages/en.json', 'utf8'));
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages, namespace: namespace as never }),
    getLocale: async () => 'en',
  };
});
vi.mock('@/lib/demo-mode', () => ({ demoSwitcherEnabled: () => m.switcher, isDemoDeployment: () => m.switcher }));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/workos', () => ({ currentWorkosSession: m.currentWorkosSession, endWorkosSession: m.endWorkosSession }));
vi.mock('@/core/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), logout: m.logout }));

import { AuthRequiredError } from '@/lib/auth-errors';

const EN = JSON.parse(fs.readFileSync('messages/en.json', 'utf8')).auth;

/** next/navigation's redirect() throws; its digest carries the target. */
async function redirectedTo(p: Promise<unknown>): Promise<string> {
  const err = (await p.then(() => null, (e) => e)) as { digest?: string } | null;
  expect(err?.digest, 'expected a redirect').toMatch(/^NEXT_REDIRECT;/);
  return err!.digest!.split(';')[2];
}

beforeEach(() => {
  for (const [k, v] of Object.entries(REAL_AUTH)) vi.stubEnv(k, v);
  vi.clearAllMocks();
  m.switcher = false;
});
afterEach(() => vi.unstubAllEnvs());

describe('/login with real sign-in on', () => {
  const render = async () => renderToStaticMarkup((await (await import('../app/login/page')).default()) as never);

  it('a WorkOS login with NO AI HR account is told so, by email, with a sign-out — not bounced', async () => {
    m.getSession.mockRejectedValue(new AuthRequiredError('No account is linked to this login.'));
    m.currentWorkosSession.mockResolvedValue({ subject: 'user_unlinked', email: 'stranger@example.test' });
    const html = await render();
    expect(html).toContain(EN.login.notLinkedTitle);
    expect(html).toContain('stranger@example.test');
    expect(html).toContain('data-testid="login-not-linked"');
    expect(html).toContain(EN.login.notLinkedSignOut);
    expect(html).toMatch(/<form[^>]*>[\s\S]*<button[^>]*type="submit"/);
    // Not the demo chooser, and no identity list.
    expect(html).not.toContain(EN.login.chooseIdentity);
    expect(html).not.toContain('/login/as');
  });

  it('a LINKED account goes home', async () => {
    m.getSession.mockResolvedValue({ tenantId: 't1', userId: 'u1' });
    expect(await redirectedTo(render())).toBe('/');
    expect(m.currentWorkosSession).not.toHaveBeenCalled();
  });

  it('any other failure is NOT dressed up as "no account" — it propagates', async () => {
    m.getSession.mockRejectedValue(new Error('database unreachable'));
    await expect(render()).rejects.toThrow('database unreachable');
  });
});

describe('signing out', () => {
  const actions = () => import('../app/auth-actions');

  it('an UNLINKED login is signed out at WorkOS and returned to the PUBLIC /login, with no AI HR session needed', async () => {
    m.getSession.mockRejectedValue(new AuthRequiredError('No account is linked to this login.'));
    expect(await redirectedTo((await actions()).signOutUnlinkedAction())).toBe('/login');
    expect(m.endWorkosSession).toHaveBeenCalledWith(`${ORIGIN}/login`);
    expect(m.getSession).not.toHaveBeenCalled();
  });

  it('a linked user’s Log out returns them to the PUBLIC /login, not a relative path behind the tunnel', async () => {
    m.getSession.mockResolvedValue({ tenantId: 't1', userId: 'u1' });
    await redirectedTo((await actions()).logoutAction());
    expect(m.logout).toHaveBeenCalledWith({ tenantId: 't1', userId: 'u1' }, undefined, `${ORIGIN}/login`);
  });

  it('on the demo switcher the unlinked sign-out never reaches WorkOS', async () => {
    m.switcher = true;
    expect(await redirectedTo((await actions()).signOutUnlinkedAction())).toBe('/login');
    expect(m.endWorkosSession).not.toHaveBeenCalled();
  });
});

describe('/callback that cannot complete (real SDK handleAuth)', () => {
  async function callback(path: string) {
    vi.resetModules(); // the SDK reads its settings at import
    const { GET } = await import('../app/callback/route');
    return GET(new NextRequest(`http://127.0.0.1:3000${path}`));
  }

  it.each(['/callback', '/callback?code=abc&state=never-issued'])('%s explains itself with a fresh-start link on the public origin', async (path) => {
    const res = await callback(path);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain(`<h1 style="font-size:1.4rem">${EN.callbackFailedTitle}</h1>`);
    expect(html).toContain(EN.callbackRetry);
    expect(html).toContain(`href="${ORIGIN}/login"`);
    expect(html).not.toContain('127.0.0.1');
    // The SDK's own error wording, and any internal detail, never reaches the page.
    expect(html).not.toContain('Missing required auth parameter');
    expect(html).not.toContain('Sign-in session could not be verified');
  });
});
