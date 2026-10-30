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
import ts from 'typescript';
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
// ADR-0142: requireOnehrAdminAccess replaced requirePerfCompAccess on the /performance/[cycleId] pages.
const GUARD_RE = /requireSecurityCenter|requireGroupAdministration|requireWorkforceAccess|requireAccessConfiguration|requireTeamAccess|requireAdmin|requirePayrollAccess|requirePerfCompAccess|requireOnehrAdminAccess|scopedAdmin|scopedSession|readV9Workspace\s*\(|onboarding(?:Context|Detail|MyAcknowledgements|Requisitions)\s*\(/;

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
// '/admin/ai' forwards to AI management › Provider, where the requireAdmin guard applies.
const REDIRECT_ONLY_ROUTES = ['/admin/ai', '/payroll/transactions/tp1/[year]'] as const;

/** An actual awaited call, not a comment/string bearing an auth helper's name. */
function hasAssistantSessionGuard(source:string){
 const ast=ts.createSourceFile('layout.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let guarded=false;
 const visit=(node:ts.Node)=>{if(ts.isAwaitExpression(node)&&ts.isCallExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='getBrowserCommandSession')guarded=true;ts.forEachChild(node,visit);};visit(ast);return guarded;
}
/** Recursively collect every `page.tsx` under app/ whose CODE calls a page guard, as a normalized route. */
function guardedRoutes(): string[] {
  const out: string[] = [];
  // This actual layout call guards every descendant, including pages whose data guards live in
  // server sections. A removed/renamed guard makes registered Assistant routes fail the stale set.
  const layout=path.join(APP,'assistant/layout.tsx'),assistantGuard=fs.existsSync(layout)&&hasAssistantSessionGuard(fs.readFileSync(layout,'utf8'));
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'page.tsx' && (GUARD_RE.test(codeWithoutComments(fs.readFileSync(p, 'utf8')))||assistantGuard&&path.relative(APP,p).split(path.sep)[0]==='assistant')) {
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
  it('recognizes the real inherited Assistant guard and rejects inert prose or an unawaited call',()=>{
    expect(hasAssistantSessionGuard('export default async function Layout(){await getBrowserCommandSession();return null;}')).toBe(true);
    for(const source of ['', '// await getBrowserCommandSession();', 'const label="await getBrowserCommandSession()";', 'function Layout(){getBrowserCommandSession();return null;}'])expect(hasAssistantSessionGuard(source)).toBe(false);
    const screen=SCREENS.find(row=>row.screenKey==='assistantWorkspace');expect(screen).toMatchObject({guard:'assistantSession',labelKey:'nav.assistant',hasScopeNote:true});
    // Exact source-reviewed mounted inventory, independent of SCREENS and guardedRoutes().
    // All53 routes share the real authenticated layout; narrower record/effect owners remain current.
    const expectedAssistantRoutes = [
      '/assistant',
      '/assistant/approvals',
      '/assistant/attendance',
      '/assistant/bank',
      '/assistant/claims',
      '/assistant/compensation',
      '/assistant/cost-allocation',
      '/assistant/day-schedule',
      '/assistant/document-details',
      '/assistant/emergency-contacts',
      '/assistant/employee-code',
      '/assistant/employee-draft-discard',
      '/assistant/employee-drafts',
      '/assistant/family',
      '/assistant/fixed-item-archive',
      '/assistant/hr',
      '/assistant/knowledge-base',
      '/assistant/leave',
      '/assistant/lifecycle',
      '/assistant/notifications',
      '/assistant/offboarding-case-cancel',
      '/assistant/offboarding-step',
      '/assistant/offboarding-step-undo',
      '/assistant/org',
      '/assistant/org-departments',
      '/assistant/org-employee-id',
      '/assistant/org-people-general',
      '/assistant/org-positions',
      '/assistant/passport',
      '/assistant/pay-codes',
      '/assistant/payment-method',
      '/assistant/payroll-close',
      '/assistant/payroll-reopen',
      '/assistant/payroll-reset',
      '/assistant/payroll-runs',
      '/assistant/performance',
      '/assistant/performance/checkins',
      '/assistant/performance/checkins/complete',
      '/assistant/performance/checkins/schedule',
      '/assistant/performance/goals',
      '/assistant/profile',
      '/assistant/profile-request-rejection',
      '/assistant/qualifications',
      '/assistant/rewards',
      '/assistant/rewards/calendar',
      '/assistant/rewards/cancel',
      '/assistant/rewards/return',
      '/assistant/schedule-group',
      '/assistant/statutory',
      '/assistant/testing',
      '/assistant/toil',
      '/assistant/tp3-opening',
      '/assistant/workforce-profile',
    ];
    const actual=guardedRoutes().filter(route=>route==='/assistant'||route.startsWith('/assistant/')).sort();expect(screen?.routes.slice().sort()).toEqual(actual);expect(actual.length).toBeGreaterThan(1);
    expect(actual).toEqual(expectedAssistantRoutes);expect(screen?.routes.slice().sort()).toEqual(expectedAssistantRoutes);
    // This is CONDITIONAL shell reach, never a role grant to HR choices, fields, approval or effects.
    // The actual roleEnum has8 roles; no new role or automatic permission is invented for added routes.
    const expectedShellReach={employee:true,manager:true,hr_admin:true,super_admin:true,payroll_partner:true,performance_comp_partner:true,operator:true,performance_partner:true};
    expect(Object.keys(expectedShellReach).sort()).toEqual([...roleEnum.enumValues].sort());
    for(const [role,reachable] of Object.entries(expectedShellReach))expect(canReach(role as typeof roleEnum.enumValues[number],screen!),role).toBe(reachable);
    const layout=codeWithoutComments(fs.readFileSync(path.join(APP,'assistant/layout.tsx'),'utf8'));
    expect(layout).toContain('if(!session.userId)throw new AuthRequiredError');
    expect(String(getPath(en,'admin.users.scope.assistantWorkspace'))).toContain('do not grant effect permission');
  });

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

  it('WP-C: the HOD department view is an onehrAssignments route behind scopedSession, and its page calls that guard', () => {
    const screen = SCREENS.find((row) => row.screenKey === 'onehrAssignments');
    expect(screen).toMatchObject({ guard: 'scopedSession', hasScopeNote: true });
    expect(SCREENS.filter((row) => row.routes.includes('/performance/department')).map((row) => row.screenKey)).toEqual(['onehrAssignments']);
    const page = codeWithoutComments(fs.readFileSync(path.join(APP, 'performance/department/page.tsx'), 'utf8'));
    expect(page).toMatch(/await requireModule\('performance'\)/);
    expect(page).toMatch(/await scopedSession\(\)/);
    expect(guardedRoutes()).toContain('/performance/department');
    expect(String(getPath(en, 'admin.users.scope.onehrAssignments'))).toMatch(/head-of-department assignment/);
  });

  // WP-B2 — the Leaders admin screen joins the performance column: it admits exactly the cycle administration
  // set (requireOnehrAdminAccess, as /performance/[cycleId] does), and has no sidebar row of its own.
  it('registers /performance/leaders under the performance column, guarded like the cycle pages', () => {
    const performance = SCREENS.find((x) => x.screenKey === 'performance');
    expect(performance?.routes).toContain('/performance/leaders');
    expect(performance?.routes).toContain('/performance/[cycleId]');
    const page = codeWithoutComments(fs.readFileSync(path.join(APP, 'performance/leaders/page.tsx'), 'utf8'));
    expect(page).toMatch(/await requireOnehrAdminAccess\(\)/);
    expect(SCREENS.filter((x) => x.href === '/performance/leaders')).toEqual([]);
  });

  it('screenKeys are unique (no duplicate columns)', () => {
    const keys = SCREENS.map((s) => s.screenKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The scopedSession count tracks MATRIX_ROLES (that guard gates nothing at the page boundary, so every
  // authenticated role reaches it) and moved 6 → 7 when the operator tier was added in 0294, then 7 → 8
  // with ADR-0142's performance_partner (0610). The two ADMIN counts stay pinned at 2, which is the
  // assertion that matters: neither operator nor performance_partner is an admin role, so the loop below
  // also proves neither reaches a requireAdmin/scopedAdmin screen.
  it('access is guard-derived and honest: admin/scopedAdmin → 2 admin roles, scopedSession → all 8', () => {
    const guardExpect: Record<Guard, number> = { requireSecurityCenter:8, requireGroupAdministration:2, assistantSession: 8, requireWorkforceAccess: 8, requireAccessConfiguration: 8, requireAdmin: 2, scopedAdmin: 2, scopedSession: 8, requireTeamAccess: 3, onboardingAccess: 8, onboardingParticipant: 8, onboardingMaster: 2 };

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
