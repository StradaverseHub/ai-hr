/**
 * THE GATED DEMO SIGNS IN AT /login, AND ITS FIRST STATE IS SIGNED OUT.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * The demo signed every visitor in automatically. `lib/session.ts` fell back to `DEV_USER_ID` when no
 * `dev_user` cookie was set, so a visitor arrived already authenticated as the seeded GROUP ADMIN — the
 * most privileged identity in the tenant — and the sign-in page was unreachable in normal use. Testing
 * the product as a manager or an employee required knowing about a dropdown in the header. Worse, "Log
 * out" deliberately KEPT the cookie ("the switcher keeps working"), so logging out did not log you out.
 *
 * ═══ THE FOUR PROPERTIES PINNED HERE ═══
 *
 *  1. On the demo the fallback is withheld, so "no cookie" means SIGNED OUT.
 *  2. That state raises `AuthRequiredError` — the error `app/layout.tsx` turns into a redirect to
 *     /login. A plain Error would render a 500 on the product's front door.
 *  3. LOCAL DEV KEEPS THE FALLBACK. `lib/session.ts`'s header says the dev switcher exists so `pnpm dev`
 *     and the test harness are "never forced through WorkOS"; withholding it everywhere would send every
 *     local page to /login and break the harness. This is the property most likely to be broken by
 *     someone "simplifying" the condition later.
 *  4. A blocked identity still fails closed, and must not fall through to the fallback — that is the
 *     0279 privilege-escalation case, and adding a login flow must not have loosened it.
 *
 * `resolveDevPrincipal` is pure and injectable, so 1, 2 and 4 are REAL assertions rather than greps.
 * The page wiring (which is inside a server component) is source-shape, per the convention in
 * test/sidebar-flyout.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDevPrincipal } from '../lib/session';
import { AuthRequiredError } from '../lib/auth-errors';

const SESSION = fs.readFileSync(path.resolve(__dirname, '../lib/session.ts'), 'utf8');
const LOGIN = fs.readFileSync(path.resolve(__dirname, '../app/login/page.tsx'), 'utf8');
const LAYOUT = fs.readFileSync(path.resolve(__dirname, '../app/layout.tsx'), 'utf8');
const AUTH_ACTIONS = fs.readFileSync(path.resolve(__dirname, '../app/auth-actions.ts'), 'utf8');
const IDENTITY = fs.readFileSync(path.resolve(__dirname, '../app/identity-actions.ts'), 'utf8');

const ADMIN = '11111111-1111-1111-1111-111111111111';
const lookup = async (id: string) =>
  id === ADMIN ? [{ tenant_id: 't1', person_id: 'p1', grants: [{ role: 'hr_admin', companyId: null }] }] : [];

describe('demo sign-in flow', () => {
  it('with no cookie and no fallback, the visitor is SIGNED OUT — not auto-admin', async () => {
    // The demo's starting state. Before this, the same call returned the group admin.
    await expect(resolveDevPrincipal(lookup as never, undefined, undefined)).rejects.toThrow(AuthRequiredError);
  });

  it('raises AuthRequiredError, which is what redirects to /login rather than 500-ing', async () => {
    // toThrow(AuthRequiredError) above would also pass for a subclass; this pins the TYPE the layout
    // switches on. A plain Error here is a 500 on the front door.
    const err = await resolveDevPrincipal(lookup as never, undefined, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect(LAYOUT).toContain('AuthRequiredError');
  });

  it('LOCAL DEV KEEPS THE FALLBACK — pnpm dev and the harness must not need a login', async () => {
    const s = await resolveDevPrincipal(lookup as never, undefined, ADMIN);
    expect(s.userId).toBe(ADMIN);
    expect(s.roles).toContain('hr_admin');
  });

  it('withholds the fallback ONLY on the demo deployment', () => {
    // isDemoDeployment(), not demoSwitcherEnabled(): the latter is true for local dev too, and using it
    // here would send every `pnpm dev` page to /login.
    expect(SESSION).toContain('isDemoDeployment() ? undefined : process.env.DEV_USER_ID');
  });

  it('still fails closed on a blocked identity rather than falling through', async () => {
    // 0279: continuing to the fallback would ESCALATE an archived login to the seeded group admin.
    await expect(
      resolveDevPrincipal(lookup as never, ADMIN, ADMIN, async () => true),
    ).rejects.toThrow(AuthRequiredError);
  });

  it('log out actually clears the chosen identity', () => {
    // It used to keep the cookie on purpose. With /login as the front door, that meant the chooser
    // would sign you straight back into the identity you just left.
    expect(IDENTITY).toContain('export async function signOutDemo');
    expect(IDENTITY).toMatch(/signOutDemo[\s\S]*cookieStore\.delete\('dev_user'\)/);
    expect(AUTH_ACTIONS).toContain('await signOutDemo();');
  });

  it('offers the identities WITH the access each carries, and only on the demo', () => {
    // The roles are the entire reason to pick one, so they must reach the screen.
    expect(LOGIN).toContain('listPrincipals');
    expect(LOGIN).toContain('p.roles.join');
    expect(LOGIN).toContain('const demo = isDemoDeployment();');
  });

  it('hides the header identity switcher on the demo', () => {
    // Leaving it would defeat the point: a tester could swap access mid-session and stop testing the
    // level they signed in with. Local dev keeps it.
    expect(LAYOUT).toContain('{!isDemoDeployment() && (');
    expect(LAYOUT).toContain('<DevIdentitySwitcher');
  });
});
