/**
 * "Approval Items" nav rename + pending-count badge (feedback 836118c4).
 *
 * Two halves:
 *
 *   1. A REAL render test of components/approval-count-badge.tsx. The badge was deliberately factored
 *      out of components/sidebar.tsx so it could be exercised here: the sidebar itself pulls
 *      next/navigation + the pack registry at module load and cannot be imported by a node test, while
 *      the badge's only dependency is `cn`. Rendered with react-dom/server (the suite has no jsdom and
 *      no @testing-library) — enough for a component whose entire contract is markup: hide at zero,
 *      cap at 9+, and two placements.
 *
 *   2. Static source/catalog guards for the parts that CANNOT render here — the RSC layout, the rail,
 *      and the six message catalogs (precedent: test/my-absence-nav.test.ts, which asserts the sibling
 *      "My Absence" rename the same way).
 *
 * Not covered, deliberately: listPendingTasks itself is UNCHANGED by this feedback (the badge reuses
 * the value app/layout.tsx already resolves for the bell), so its existing coverage stands.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalCountBadge } from '@/components/approval-count-badge';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const sidebar = read('components/sidebar.tsx');
const layout = read('app/layout.tsx');
const actions = read('app/approvals/actions.ts');
const permissions = read('lib/permissions.ts');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
type Catalog = { nav: Record<string, string> };
const nav = (loc: string) => (JSON.parse(read(`messages/${loc}.json`)) as Catalog).nav;

const html = (count: number, collapsed: boolean) =>
  renderToStaticMarkup(createElement(ApprovalCountBadge, { count, collapsed }));

describe('ApprovalCountBadge: renders the pending count', () => {
  it('renders nothing when nothing is pending', () => {
    expect(html(0, false)).toBe('');
    expect(html(0, true)).toBe('');
    // Defensive: a negative can only come from a bug upstream, but it must never render "-1".
    expect(html(-1, false)).toBe('');
  });

  it('shows the exact count from 1 to 9', () => {
    for (const n of [1, 3, 7, 9]) {
      const out = html(n, false);
      expect(out, `count ${n}`).toContain(`>${n}<`);
      expect(out, `count ${n}`).not.toContain('9+');
    }
  });

  it('caps at 9+ past nine (the bell\'s convention)', () => {
    expect(html(10, false)).toContain('9+');
    expect(html(12, false)).toContain('9+');
    expect(html(29, true)).toContain('9+');
  });

  it('expanded rail: a trailing pill (ml-auto), not an overlay', () => {
    const out = html(3, false);
    expect(out).toContain('ml-auto');
    expect(out).not.toContain('absolute');
  });

  it('collapsed rail: a bubble pinned over the icon square', () => {
    const out = html(3, true);
    expect(out).toContain('absolute');
    expect(out).toContain('right-1');
    expect(out).toContain('top-1');
    expect(out).not.toContain('ml-auto');
  });

  it('reuses the bell\'s amber pill tokens and stays out of the a11y tree', () => {
    const out = html(3, false);
    // Same token set as the bell's task dot in components/notification-center.tsx — the two
    // pending-work indicators must not drift into two different-looking badges.
    expect(out).toContain('bg-amber-500');
    expect(out).toContain('rounded-full');
    // The count reaches screen readers through the row's aria-label instead (see below), so the
    // glyph itself is hidden — "9+" read aloud is noise.
    expect(out).toContain('aria-hidden');
  });
});

describe('nav rename: "Approvals" → "Approval Items" in every locale', () => {
  // Hard-coded expectations on purpose. messages/*.json is the tracked source of truth, but the
  // catalogs are ALSO rebuilt by `pnpm i18n:import` from the (gitignored, regenerable) messages/i18n.csv
  // working file. Pinning the six strings here means a stale-CSV import that silently reverts the rename
  // fails this test instead of shipping "Approvals" back to production.
  const EXPECTED: Record<(typeof LOCALES)[number], string> = {
    en: 'Approval Items',
    ms: 'Item Kelulusan',
    zh: '审批事项',
    ta: 'ஒப்புதல் உருப்படிகள்',
    th: 'รายการอนุมัติ',
    vi: 'Mục phê duyệt',
  };

  it('every locale carries the new label', () => {
    for (const loc of LOCALES) {
      expect(nav(loc).approvals, `${loc} nav.approvals`).toBe(EXPECTED[loc]);
    }
  });

  it('the KEY is unchanged, so the permission matrix and stored role configs follow automatically', () => {
    // Renaming the label only — lib/permissions.ts (screenKey 'approvals' / labelKey 'nav.approvals')
    // is deliberately NOT edited, so persisted role configs keyed on 'approvals' keep working and the
    // Security & Permission screen picks up the new wording for free.
    expect(permissions.includes("labelKey: 'nav.approvals'")).toBe(true);
    expect(permissions.includes("screenKey: 'approvals'")).toBe(true);
  });

  it('one rail row serves both Manager and HR Admin, so one label covers both', () => {
    // managerUp:true + the isAdmin||canApprove filter in canSeeChild — a single row, not one per role.
    expect(
      sidebar.includes(
        "{ href: '/approvals', labelKey: 'approvals', icon: ListChecks, tour: 'nav-approvals', managerUp: true }",
      ),
    ).toBe(true);
  });
});

describe('accessible count label: nav.approvalsCount', () => {
  it('exists in every locale as an ICU plural on {count}', () => {
    for (const loc of LOCALES) {
      const msg = nav(loc).approvalsCount;
      expect(msg, `${loc} nav.approvalsCount`).toBeTruthy();
      expect(msg, `${loc} nav.approvalsCount`).toContain('{count, plural,');
      expect(msg, `${loc} nav.approvalsCount other branch`).toContain('other {');
    }
  });

  it('the rail composes it into the row aria-label when items are pending', () => {
    expect(sidebar).toContain("t('approvalsCount', { count: approvalCount })");
    expect(sidebar).toContain('aria-label={showApprovalCount ?');
  });
});

describe('the count is the viewer\'s own pending queue, computed once', () => {
  it('the layout passes listPendingTasks(...).length — no second query', () => {
    expect(layout).toContain('approvalCount={pendingTasks.length}');
    // The value it reuses is still the same single call already made for the bell.
    //
    // r292 UPDATED, NOT LOOSENED. Module gating gave listPendingTasks a third argument (the resolved
    // InboxModules — the root layout must not throw, since a throw here 500s every authenticated route),
    // so the old exact-spelling assertions broke while the decision they protect did not. The intent was
    // always "exactly ONE call, and the count reuses it". That is now asserted directly by counting CALL
    // sites rather than matching one argument list, which is both stronger and immune to the next
    // argument change. Do not weaken this to "contains listPendingTasks".
    expect(layout).toContain('const pendingTasks = await listPendingTasks(session, scopeIds,');
    const callSites = layout.split('await listPendingTasks(').length - 1;
    expect(callSites, 'exactly one listPendingTasks call in the root layout').toBe(1);
  });

  it('it is NOT the bell\'s taskCount (which also folds in action notifications)', () => {
    // Deliberate divergence: the bell counts unread action-severity notifications too, which are not
    // approval records. The nav badge is strictly approval items.
    expect(layout).toContain('taskCount={pendingTasks.length + taskNotifCount}');
    expect(layout).not.toContain('approvalCount={pendingTasks.length + taskNotifCount}');
  });

  it('the rail renders the badge on the /approvals row only, gated on a positive count', () => {
    expect(sidebar).toContain("const showApprovalCount = item.href === '/approvals' && approvalCount > 0");
    expect(sidebar).toContain('<ApprovalCountBadge count={approvalCount} collapsed={collapsed} />');
    expect(sidebar).toContain("from '@/components/approval-count-badge'");
    // The collapsed-rail bubble is absolutely positioned, so its row needs a positioned ancestor.
    expect(sidebar).toContain("showApprovalCount && 'relative'");
  });
});

describe('post-decision refresh', () => {
  it('deciding revalidates the ROOT LAYOUT, not just the /approvals page', () => {
    // The badge (and the bell's task count) live in app/layout.tsx. revalidatePath(back) defaults to
    // type 'page' and would leave both stale after a decision.
    expect(actions).toContain("revalidatePath('/', 'layout')");
    // Both decrement paths go through the shared helper: the row-level actions via done(), and bulk.
    expect(actions).toContain('function done(toast: string, nav: Nav = {}): never {\n  revalidateShell();');
    expect(actions).toContain('revalidateShell();\n  const summary =');
    // fail() changes no state, so it must NOT pay for a shell revalidation.
    expect(actions).toContain('function fail(e: unknown, nav: Nav = {}): never {\n  redirect(');
  });
});
