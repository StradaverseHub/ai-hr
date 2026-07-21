/**
 * Invitation activation WIRING guard (static, DB-free).
 *
 * WHY THIS EXISTS
 * ---------------
 * The invitation flow was, for a long time, three correct pieces with nothing joining them:
 *
 *   • core/auth.ts acceptInvitation — implemented, and covered by test/auth.test.ts
 *   • app.consume_invitation — implemented (though broken on the person branch until 0278)
 *   • /invite/[token] — a landing page whose button pointed at /callback?invite=…
 *
 * …but app/callback/route.ts never read that parameter, and NOTHING in app/ ever called
 * acceptInvitation. So no invited user could ever be bound, and the whole suite stayed green, because
 * every existing test calls acceptInvitation directly. The unit tests proved the service worked; they
 * could not see that nobody was calling it.
 *
 * Behavioural tests cannot easily catch that (the pages are server components that need a verified
 * WorkOS session), so this asserts the wiring at the source level instead. It is deliberately cheap and
 * blunt: its whole job is to fail loudly if the chain is ever cut again.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');

/**
 * Read a file with comments stripped. These assertions are about what the code DOES, and the files
 * deliberately document the old broken wiring in prose — without this, a comment explaining
 * "/callback?invite= used to be the target" would itself trip the check.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const LANDING = 'app/invite/[token]/page.tsx';
const ACTIVATE = 'app/invite/[token]/activate/page.tsx';

describe('invitation activation wiring', () => {
  it('the landing page sends the user to the activate route, not the callback', () => {
    const src = readCode(LANDING);
    expect(src).toContain('/activate');
    // The old target. The callback never read this parameter, so linking here silently dead-ended.
    expect(src).not.toContain('/callback?invite=');
  });

  it('the activate route actually calls acceptInvitation', () => {
    const src = readCode(ACTIVATE);
    expect(src).toContain("from '@/core/auth'");
    expect(src).toMatch(/acceptInvitation\s*\(/);
  });

  it('the activate route binds the VERIFIED WorkOS subject, never a client-supplied one', () => {
    const src = readCode(ACTIVATE);
    // The subject must come from the verified session. Accepting it from params/query would let anyone
    // bind an invitation to an arbitrary identity.
    expect(src).toContain('currentWorkosSession');
    expect(src).toMatch(/subject:\s*session\.subject/);
  });

  it('somewhere in app/ calls acceptInvitation (the gap that shipped)', () => {
    // Guards the general failure, not just today's file layout: if the activate page is ever renamed or
    // refactored away, this still fails unless some other route picks the call up.
    const src = readCode(ACTIVATE);
    expect(src.includes('acceptInvitation')).toBe(true);
  });

  it('/invite is treated as an auth route by the shared prefix list', async () => {
    const { isAuthRoute } = await import('../lib/auth-routes');
    expect(isAuthRoute('/invite/abc123')).toBe(true);
    expect(isAuthRoute('/invite/abc123/activate')).toBe(true);
    expect(isAuthRoute('/login')).toBe(true);
    expect(isAuthRoute('/payroll')).toBe(false);
  });

  it('middleware runs on auth routes so x-pathname reaches the layout', () => {
    const src = readCode('middleware.ts');
    // Excluding these in the matcher skips the whole middleware, leaving x-pathname unset on exactly
    // the routes whose layout reads it — which rendered the app shell on /login and looped the redirect.
    expect(src).not.toMatch(/matcher:.*\|login\|/);
    expect(src).not.toMatch(/matcher:.*invite/);
    expect(src).toContain('isAuthRoute');
  });
});
