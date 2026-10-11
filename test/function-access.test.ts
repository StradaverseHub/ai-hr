/**
 * Function-access registry (lib/permissions.ts) — the reference grid on /admin/users.
 *
 * The registry MIRRORS the enforced access derived from each route's requireX guard; editing it does
 * NOT change enforcement (that lives in lib/authz.ts + lib/scope.ts + the RLS policies). These tests
 * pin the two properties that matter for a TRANSPARENCY screen — completeness in both directions:
 *
 *   1. Forward completeness: every role has a defined access answer for every screen (no blank cells).
 *   2. Reverse completeness: every guarded app/**\/page.tsx route on disk is covered by a screen column,
 *      so a NEW screen shipped without a matrix column FAILS the build (the under-reporting failure mode
 *      — the grid silently omitting a screen users can reach — which is the dangerous one for a security
 *      view). Implemented as a filesystem glob vs the registry's REGISTERED_ROUTES set (no RLS parsing).
 *
 * Plus a guard that every column's i18n labelKey and scopeNote resolve in en.json (the page resolves
 * these dynamically, so the i18n static-key coverage test cannot see them).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { roleEnum } from '../db/schema';
import {
  MATRIX_ROLES,
  REGISTERED_ROUTES,
  SCREENS,
  canReach,
  rolesForGuard,
  type Guard,
} from '../lib/permissions';
import en from '../messages/en.json';

const APP = path.resolve(__dirname, '../app');
const GUARD_RE = /requireTeamAccess|requireAdmin|requirePayrollAccess|requirePerfCompAccess|scopedAdmin|scopedSession/;

/**
 * r362 — THIS USED TO TEST THE RAW SOURCE, SO A COMMENT COUNTED AS A GUARD.
 *
 * `GUARD_RE.test(readFileSync(p))` matched the guard name anywhere in the file, including inside the
 * header comment that EXPLAINS the guard. A page could therefore lose `await scopedSession()` from its
 * code and stay "guarded" here for as long as its comment still named it — the two assertions below are
 * the repo's only page-boundary authentication check, so that is a false assurance about auth, which is
 * the one class of guard that must not be satisfiable by prose.
 *
 * Found while reviewing r362: a deliberate defect that deleted `await scopedSession()` AND its import
 * from a page left this file green, while the two page-level guards in
 * test/attendance-my-records-split.test.ts (which do strip comments) caught it. Measured before
 * changing: of every `page.tsx` under app/, exactly ONE is classified differently once comments are
 * stripped, and it is the documented redirect-only segment below.
 *
 * Comments are stripped, so `guardedRoutes()` now means "calls a guard IN CODE". The exemption is named
 * and exact rather than a subset check, so this is stronger than before in both directions: delete a
 * real guard and the stale set grows and names the route; give the redirect a guard and the exemption
 * goes unmatched and says so.
 */
function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * Route segments that are REGISTERED but call no guard, because they read nothing and only redirect.
 *
 * `/payroll/transactions/tp1/[year]` is kept as a segment because 3e3d3fb2's year-grained URLs are in
 * the wild (7ad37961 moved the record's grain to the month when the official TP1 (1/2026) turned out to
 * have a DEDUCTION MONTH box). It resolves no session and touches no data; it forwards, and the
 * destination applies the full `scopedAdmin` guard and 404s an employment outside the admin's scope, so
 * forwarding an id proves nothing about it. It stays in the matrix because REGISTERED_ROUTES is an
 * exact-set check over page.tsx files.
 *
 * A route belongs here ONLY if it reads no session and no data. Anything that reads gets a real guard.
 */
const REDIRECT_ONLY_ROUTES = ['/payroll/transactions/tp1/[year]'] as const;

/** Recursively collect every `page.tsx` under app/ whose CODE calls a page guard, as a normalized route. */
function guardedRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'page.tsx' && GUARD_RE.test(codeWithoutComments(fs.readFileSync(p, 'utf8')))) {
        // app/foo/bar/page.tsx -> /foo/bar ; app/page.tsx -> /
        const rel = path.relative(APP, p).replace(/\\/g, '/'); // e.g. "foo/bar/page.tsx" or "page.tsx"
        const route = rel.replace(/(^|\/)page\.tsx$/, '');
        out.push(route === '' ? '/' : `/${route}`);
      }
    }
  };
  walk(APP);
  return out;
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('function-access registry (lib/permissions)', () => {
  it('MATRIX_ROLES is exactly the roleEnum set (a new role forces a new grid row)', () => {
    expect([...MATRIX_ROLES].sort()).toEqual([...roleEnum.enumValues].sort());
  });

  it('forward completeness: every role has a boolean access answer for every screen', () => {
    for (const screen of SCREENS) {
      for (const role of roleEnum.enumValues) {
        expect(typeof canReach(role, screen), `${role} × ${screen.screenKey}`).toBe('boolean');
      }
    }
  });

  it('reverse completeness: every guarded page.tsx route on disk has a screen column', () => {
    const onDisk = guardedRoutes();
    expect(onDisk.length, 'expected to find guarded routes on disk').toBeGreaterThan(0);
    const missing = onDisk.filter((r) => !REGISTERED_ROUTES.has(r));
    expect(missing, `guarded routes with no matrix column:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no stale routes: every REGISTERED_ROUTES entry calls a guard in code, or is a named redirect-only segment', () => {
    const onDisk = new Set(guardedRoutes());
    const unguarded = [...REGISTERED_ROUTES].filter((r) => !onDisk.has(r)).sort();
    // EXACT, not a subset: a page that loses its guard lands here and is named, and a redirect-only
    // segment that gains one stops matching and is named too. Before r362 a comment naming the guard
    // was enough to keep a route out of this list.
    expect(
      unguarded,
      `registered routes that call no guard in code.\nExpected exactly the documented redirect-only segments.\nGot:\n${unguarded.join('\n')}`,
    ).toEqual([...REDIRECT_ONLY_ROUTES].sort());
  });

  it('screenKeys are unique (no duplicate columns)', () => {
    const keys = SCREENS.map((s) => s.screenKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The scopedSession count tracks MATRIX_ROLES (that guard gates nothing at the page boundary, so every
  // authenticated role reaches it) and moved 6 → 7 when the operator tier was added in 0294. The two
  // ADMIN counts stay pinned at 2, which is the assertion that matters: operator is NOT an admin role,
  // so the loop below now also proves an operator reaches no requireAdmin/scopedAdmin screen.
  it('access is guard-derived and honest: admin/scopedAdmin → 2 admin roles, scopedSession → all 7', () => {
    const guardExpect: Record<Guard, number> = { requireAdmin: 2, scopedAdmin: 2, scopedSession: 7, requireTeamAccess: 3 };
    for (const g of Object.keys(guardExpect) as Guard[]) {
      expect(rolesForGuard(g).size, g).toBe(guardExpect[g]);
    }
    // a scopedAdmin screen must NOT grant a plain employee (regression guard against nav-derived leakage)
    const admins = new Set(['hr_admin', 'super_admin']);
    for (const s of SCREENS.filter((x) => x.guard === 'requireAdmin' || x.guard === 'scopedAdmin')) {
      for (const role of roleEnum.enumValues) {
        expect(canReach(role, s), `${role} × ${s.screenKey}`).toBe(admins.has(role));
      }
    }
  });

  it('every column labelKey and scopeNote resolves as a string in en.json', () => {
    for (const screen of SCREENS) {
      const label = getPath(en, screen.labelKey);
      expect(typeof label, `label ${screen.labelKey}`).toBe('string');
      if (screen.hasScopeNote) {
        const note = getPath(en, `admin.users.scope.${screen.screenKey}`);
        expect(typeof note, `scope admin.users.scope.${screen.screenKey}`).toBe('string');
      }
    }
    // Section-level strings the page renders. This is the ONE pinning site for /admin/users strings:
    // the page uses both page-scoped and global translations, which makes it a multi-namespace
    // file that i18n-coverage check C skips ENTIRELY — static keys included. So a typo in any key
    // below would render a raw key with a fully green suite unless it is listed here.
    for (const k of [
      'sectionFunctionAccess',
      'functionAccessCaption',
      'accessible',
      'notAccessible',
      'screenColumn',
      // Login lifecycle (0279) — merged Active/Invited/Archived list, archive/restore, invite-by-person.
      'status.active',
      'status.invited',
      'status.archived',
      'status.preparing',
      'status.pending',
      'activateManually',
      'activateByInvitation',
      'resumeActivation',
      'chooseAnotherEmployee',
      'statusColumn',
      'archive',
      'restore',
      'showArchived',
      'hideArchived',
      'archivedCount',
      'archivedCauseLeft',
      'archivedCauseManual',
      'invitePerson',
      'invitePersonPlaceholder',
      'unlinkedLogin',
    ]) {
      expect(typeof getPath(en, `admin.users.${k}`), k).toBe('string');
    }
    // Orphaned by the merged list — the separate "Pending invitations" card no longer exists.
    expect(getPath(en, 'admin.users.pendingInvitations')).toBeUndefined();
  });
});
