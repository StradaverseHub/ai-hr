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
const GUARD_RE = /requireAdmin|requirePayrollAccess|requirePerfCompAccess|scopedAdmin|scopedSession/;

/** Recursively collect every `page.tsx` under app/ whose source calls a page guard, as a normalized route. */
function guardedRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'page.tsx' && GUARD_RE.test(fs.readFileSync(p, 'utf8'))) {
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

  it('no stale routes: every REGISTERED_ROUTES entry exists on disk as a guarded route', () => {
    const onDisk = new Set(guardedRoutes());
    const stale = [...REGISTERED_ROUTES].filter((r) => !onDisk.has(r));
    expect(stale, `registered routes not found on disk:\n${stale.join('\n')}`).toEqual([]);
  });

  it('screenKeys are unique (no duplicate columns)', () => {
    const keys = SCREENS.map((s) => s.screenKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('access is guard-derived and honest: admin/scopedAdmin → 2 admin roles, scopedSession → all 6', () => {
    const guardExpect: Record<Guard, number> = { requireAdmin: 2, scopedAdmin: 2, scopedSession: 6 };
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
    // section-level strings the page renders
    for (const k of ['sectionFunctionAccess', 'functionAccessCaption', 'accessible', 'notAccessible', 'screenColumn']) {
      expect(typeof getPath(en, `admin.users.${k}`), k).toBe('string');
    }
  });
});
