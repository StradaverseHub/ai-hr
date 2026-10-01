/** r378: approved two-tab Inquiry, grouped My Leave, and consolidated import row supersede the historical shape below. */
/**
 * 5ca446db (r269) — A SIXTH LEAVE CONFIG ROW: "Employee Leave Inquiry".
 *
 * THE REQUEST, and why it is smaller than it reads. The reporter asked for "Employee Leave Inquiry" to
 * become a navigation item under Leave Config, opening Employee Balances, with Employee Balances keeping
 * its own name (their point 7). Employee Balances was never a tab of Entitlements: in their own screenshot
 * it is a single underlined link in the top-right of the Entitlements page header (r242 3a3f5a2d's F47),
 * and the screen it opens is one of THREE that already sit together as the Leave Inquiry rail — Employee
 * Details (/leave/tracker) · Employee Balances (/leave/employee-balances) · Employee Leave Record
 * (/leave/employee-records). Nothing needed building. What was missing was the DOOR from Leave Config, and
 * this is the second time they asked for it (item 1ff969ed, "add a new function under Leave Config: Leave
 * Inquiry", shipped the three screens and not the row).
 *
 * SO THE WHOLE CHANGE IS NAVIGATION: one new fly-out child, last, after Company rules; the two inquiry
 * paths transferred onto it from the Team Leave Tracker row; one header link removed; one label key minted
 * and one orphaned caption pruned. No route moves, no permission changes, no figure changes, no migration.
 *
 * TWO HALVES, the house shape (test/reset-records-screen.test.ts).
 *
 * The SOURCE-SHAPE half pins the promises a later round could quietly undo with no behaviour test
 * noticing: six children with the new one LAST, its href and ownedSubpaths, its ABSENCE from
 * LEAVE_CONFIG_MAP (it has no page under app/admin/leave-config/**), its registration on the
 * `leaveEmployeeBalances` column rather than on `leaveConfig`, the unchanged route, the label in six
 * catalogues, and the header link's removal in the Entitlements page source.
 *
 * The HIGHLIGHT half drives the REAL exported predicates (components/nav-flyout.ts) over every leave nav
 * row every pack contributes, because the failure this change could most easily cause is two rows lighting
 * at once: `/leave/employee-balances` used to belong to Team Leave Tracker in the `manage` group, and if
 * both rows claimed it the sidebar's `activeSectionKey` would resolve to Manage (the earlier group) while
 * the Leave Config row also lit. Exactly one row must answer for each path.
 *
 * The RENDER half renders the REAL pages with a REAL database — a 200 is not a render check, and neither
 * is a source scan (CLAUDE.md §8). The Entitlements page must render with NO link to the inquiry screen
 * anywhere in its visible markup, and Employee Balances must still render, with its own "Employee
 * Balances" heading and its two-tab rail, when opened with no `emp=` — which is the state the new row
 * lands on, so "the row opens something usable" is a claim this file is entitled to make.
 *
 * ⚠️ FILE-LEVEL MOCKS: requireAdmin()/scopedAdmin() are fakes returning the module-level ADMIN;
 * getTranslations/getLocale are a REAL translator over messages/en.json (next-intl's own
 * `createTranslator`, rethrowing MISSING_MESSAGE / FORMATTING_ERROR) so the assertions read SENTENCES, not
 * key names; next/headers gives an empty cookie jar. Server components are `async` and react-dom/server
 * cannot render one, so `settle()` awaits every async component before `renderToStaticMarkup`.
 *
 * NON-VACUITY (done by the builder, re-derivable by the verifier): remove `ownedSubpaths` from the new row
 * in a copy of packs/leave/index.ts and the highlight case "the Leave Config row answers for BOTH inquiry
 * paths" fails on /leave/employee-records; put the header `actions` link back on a copy of
 * app/admin/leave-config/types/page.tsx and both the source case and the RENDERED Entitlements case fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let ADMIN: SessionContext;
let SCOPE_IDS: string[] = [];
vi.mock('../lib/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz')>()),
  requireAdmin: async () => ADMIN,
}));
vi.mock('../lib/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/scope')>()),
  scopedAdmin: async () => ({ s: ADMIN, scopeIds: SCOPE_IDS }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  /**
   * r369 (9949f91a) — THIS MOCK GREW A ROUTER BECAUSE THE SCREEN GREW A CLIENT COMPONENT.
   *
   * Employee Balances and Employee Leave Records now mount `CollapsibleEmployeePanel`, which is
   * `'use client'` and calls `useRouter()` at module scope of its body. Outside an App Router context
   * that throws "No 'useRouter' export is defined on the 'next/navigation' mock", so every case in this
   * file went red on a render it had always been able to do — nothing about what it asserts changed.
   *
   * Same fix and same reasoning as test/company-panel-no-disclosure-render.test.ts, whose header records
   * it for the same cause. The panel only ever calls `router.push`; `refresh` and `replace` are here for
   * parity with that precedent so the next component to arrive does not need a third variant.
   *
   * Worth recording HOW this was found: it is a CROSS-BRANCH interaction that no per-branch targeted run
   * could see. The branch that mounted the panel did not touch this file, and the branch that touched
   * this file had not yet mounted the panel. Only the full gate over the merged tree fails here.
   */
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
  // The real inquiry tab links project current picker context from the URL.
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const messages = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getLocale: async () => 'en',
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        // ⚠️ LOAD-BEARING: next-intl swallows a missing or malformed message and hands back the key.
        onError: (e) => {
          throw e;
        },
      }),
  };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import EntitlementsPage from '../app/admin/leave-config/types/page';
import EmployeeBalancesPage from '../app/leave/employee-balances/page';
import { LEAVE_CONFIG_MAP } from '../components/leave-config-map';
import { isNavRowActive, isParentActive } from '../components/nav-flyout';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';
import { leavePack } from '../packs/leave';
import '../packs/register-all';
import { listPacks, type NavChildDescriptor } from '../packs/registry';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(root, rel));
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`))])) as Record<
  (typeof LOCALES)[number],
  { nav: Record<string, string>; admin: Record<string, Record<string, unknown>>; leave: Record<string, Record<string, string>> }
>;
/** Strip <script> before counting — a key in the RSC payload is not a screen (CLAUDE.md §8). */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');

const ENTITLEMENTS_PAGE = 'app/admin/leave-config/types/page.tsx';
const BALANCES_HREF = '/leave/employee-balances';
const RECORDS_HREF = '/leave/employee-records';
const TRACKER_HREF = '/leave/tracker';

const NODE = leavePack.navNodes!.find((n) => n.group === 'admin')!;
/** r281 (a73d1e14) — BY NAME, not by index. This was `children.at(-1)`, which held only while the
 *  inquiry row happened to be last; Special Setting was appended below it at the reporter's request.
 *  Every case in this file is about THIS row's shape — its address, its owned path, the highlight — and
 *  none of them is about its index. Its POSITION is still asserted, as the neighbour pair r269 actually
 *  promised ("at the bottom, after Company rules"), in the case below. */
const INQUIRY_ROW = NODE.children.find((c) => c.labelKey === 'employeeLeaveInquiry')!;

// ────────────────────────────────── SOURCE SHAPE ──────────────────────────────────

describe('5ca446db — six rows in the Leave Config fly-out, the new one last', () => {
  it('the node carries every Leave Config child, in the order the reporter reads, with the inquiry row last', () => {
    // r279 (3fbf7a02) — UPDATED, NOT LOOSENED. This was "SIX children"; it is seven, because Leave
    // Balance Health took a row of its own directly under Entitlements (test/r279-balance-health-row
    // .test.ts owns that decision). This file's property is unchanged and is still asserted exactly: the
    // INQUIRY row is last, immediately after Company rules, which is where the reporter asked for it. The
    // list stays an exact set — a deletion, a rename or a re-sort still fails it.
    expect(NODE.labelKey).toBe('leaveConfig');
    expect(NODE.group).toBe('admin');
    // r281 — UPDATED, NOT LOOSENED, twice over. Run Earned Accrual joined directly after Generate
    // Entitlement (it was a card filed INSIDE that page, beside the one operation it must not be confused
    // with), and Special Setting joined at the very bottom, below this row, where the reporter drew it.
    // The list stays an exact set — a deletion, a rename or a re-sort still fails it — and r269's own
    // promise is restated exactly below: the inquiry row sits immediately after Company rules.
    expect(NODE.children.map((c) => c.labelKey)).toEqual([
      'leaveEntitlements',
      'leaveBalanceHealth',
      'leaveAdjustments',
      // r378 consolidates the import destinations behind one row; legacy routes remain aliases.
      'leaveDataImport',
      'leaveCredit',
      'leaveGenerate',
      'leaveEarnedAccrual',
      'leaveApprovalWorkflow',
      'leaveCompanyRules',
      'employeeLeaveInquiry',
      'leaveSpecialSetting',
    ]);
    // "At the bottom, after Company rules" — asserted as the PAIR, so the row cannot drift up the list
    // while still technically being last of something. That pair is what r269 promised and it is intact;
    // "last child of the node" never was the promise, and is no longer true of this row.
    expect(NODE.children.map((c) => c.labelKey).slice(-3)).toEqual([
      'leaveCompanyRules',
      'employeeLeaveInquiry',
      'leaveSpecialSetting',
    ]);
  });

  it('the row opens the EXISTING Employee Balances screen — the route is unmoved, not re-created', () => {
    expect(INQUIRY_ROW.href).toBe(BALANCES_HREF);
    // The page that answers is the one that was always there. A new page under the Leave Config module
    // would be the "second address for one screen" this item deliberately does not do.
    expect(exists('app/leave/employee-balances/page.tsx')).toBe(true);
    expect(exists('app/admin/leave-config/employee-balances/page.tsx')).toBe(false);
    expect(REGISTERED_ROUTES.has(BALANCES_HREF)).toBe(true);
    // …and the other two rail screens keep their addresses too, so every saved and export link resolves.
    for (const href of [TRACKER_HREF, RECORDS_HREF]) expect(REGISTERED_ROUTES.has(href)).toBe(true);
    // r378 retains two inquiry tabs; tracker remains the separately accessible calendar/legacy alias.
    const rail = read('components/leave/leave-inquiry-nav.tsx');
    expect(rail).not.toContain("{ key: 'details'");
    expect(rail).toContain("{ key: 'balances', href: hrefFor('/leave/employee-balances', 'balances'), label: t('employeeBalances') }");
    expect(rail).toContain("{ key: 'records', href: hrefFor('/leave/employee-records', 'records'), label: t('employeeLeaveRecord') }");
  });

  it('it owns Employee Leave Record, and the tracker row has given both inquiry paths up', () => {
    expect(INQUIRY_ROW.ownedSubpaths).toEqual([RECORDS_HREF]);
    const tracker = leavePack.navLinks!.find((l) => l.href === TRACKER_HREF)!;
    // The TRANSFER, both halves. Leaving the paths on the tracker row as well is the defect that would
    // light two rows in two groups at once (the highlight block below is what proves it does not).
    expect(tracker.ownedSubpaths ?? []).toEqual([]);
    // …and the transfer must not have been "fixed" by gating the tracker row, which would delete the
    // leave calendar from every plain employee (388e53c2's load-bearing decision).
    expect(tracker.adminOnly).toBeUndefined();
    expect(tracker.managerUp).toBeUndefined();
    expect(SCREENS.find((s) => s.screenKey === 'leaveTracker')!.guard).toBe('scopedSession');
  });

  it('it is NOT a Leave Config screen: no map group, and its own permission column keeps its own name', () => {
    // A map group would make `leaveConfigPageHeader` claim a page it does not own (there is no page under
    // app/admin/leave-config for it) and break test/leave-config-map.test.ts. The heading the reporter sees
    // on arrival comes from the inquiry page's own PageHeader instead.
    expect(LEAVE_CONFIG_MAP.map((g) => g.navKey as string)).not.toContain('employeeLeaveInquiry');
    expect(LEAVE_CONFIG_MAP.flatMap((g) => g.items.map((i) => i.href))).not.toContain(BALANCES_HREF);
    expect(read('app/leave/employee-balances/page.tsx')).toContain("tInq('balancesTitle')");
    // Registered on its OWN scopedAdmin column since 20c699f8 — NOT folded into leaveConfig, which would
    // hand every Leave Config grantee the inquiry screens.
    expect(SCREENS.find((s) => s.screenKey === 'leaveConfig')!.routes).not.toContain(BALANCES_HREF);
    const own = SCREENS.find((s) => s.screenKey === 'leaveEmployeeBalances')!;
    expect(own.routes).toEqual([BALANCES_HREF]);
    expect(own.guard).toBe('scopedAdmin');
    // THE ROW IS THE AREA, THE COLUMN IS THE SCREEN (the reporter's point 7, and the
    // leaveApprovalWorkflow/leaveApproval precedent): the two surfaces keep their own names.
    expect(own.labelKey).toBe('admin.users.screen.leaveEmployeeBalances');
    expect(CATALOGUES.en.admin.users as unknown as Record<string, Record<string, string>>).toBeTruthy();
    expect(CATALOGUES.en.nav.employeeLeaveInquiry).toBe('Employee Leave Inquiry');
  });

  it('the label is its own key in all six catalogues, translated, and takes no ICU argument', () => {
    for (const loc of LOCALES) {
      const v = CATALOGUES[loc].nav.employeeLeaveInquiry;
      expect(typeof v, `${loc}: nav.employeeLeaveInquiry`).toBe('string');
      expect(v.trim().length, `${loc}: nav.employeeLeaveInquiry is empty`).toBeGreaterThan(0);
      // Rendered by a bare t() — a {brace} throws FORMATTING_ERROR at render behind a green 200.
      expect(v, `${loc}: unexpected ICU argument`).not.toMatch(/[{}]/);
      if (loc !== 'en') expect(v, `${loc}: left in English`).not.toBe(CATALOGUES.en.nav.employeeLeaveInquiry);
      // The row does NOT hijack an existing key: the rail's own area label and the screen labels survive
      // and stay distinct, exactly as nav.leaveApproval does from nav.leaveApprovalWorkflow.
      expect(CATALOGUES[loc].leave.inquiry.navLabel, `${loc}: the rail keeps its own label`).toBeTruthy();
      expect(CATALOGUES[loc].leave.inquiry.balancesTitle, `${loc}: the screen keeps its own name`).toBeTruthy();
      expect(v, `${loc}: the row must not rename the screen`).not.toBe(CATALOGUES[loc].leave.inquiry.balancesTitle);
    }
  });

  it('the Entitlements header link is GONE from the source, and its caption is pruned in six catalogues', () => {
    const src = read(ENTITLEMENTS_PAGE);
    const header = src.slice(src.indexOf('<PageHeader'), src.indexOf('<LeaveConfigMap'));
    expect(header, 'the actions slot is gone, not emptied').not.toMatch(/actions=\{/);
    expect(src, 'no link to the inquiry screen survives anywhere on the page').not.toContain(`href="${BALANCES_HREF}"`);
    expect(src).not.toContain('employeeBalancesAction');
    for (const loc of LOCALES)
      expect(
        (CATALOGUES[loc].admin.leave as Record<string, unknown>).employeeBalancesAction,
        `${loc}: the caption must retire with its only reader`,
      ).toBeUndefined();
    // Everything else on the page r269's plan promised would not change is still mounted.
    //
    // r279 (3fbf7a02) — `'<LeaveConfigHealthCard'` STOOD IN THIS LIST and is deliberately gone from it.
    // r269 promised this page's OTHER surfaces would survive ITS change, and they did; r279 is a
    // different, approved change that gives the health listing its own row and its own address, because
    // nothing in the menu said it existed. Keeping the literal here would make this file veto a later
    // approved move of a surface it never owned. The three surfaces r269 actually reasoned about are
    // still pinned, and the card's new home is asserted instead, so this cannot go green on a page that
    // simply lost it.
    for (const kept of ['<LeaveConfigMap current="leaveTypes"', '<EntitlementTablesBlock', '<LeaveTypeWorkspace'])
      expect(src, kept).toContain(kept);
    expect(read('app/admin/leave-config/balance-health/page.tsx')).toContain('<LeaveConfigHealthCard');
  });
});

// ────────────────────────────────── HIGHLIGHTING ──────────────────────────────────

/**
 * Every nav row EVERY registered pack contributes — flat rows and fly-out children alike — so "exactly one
 * row lights" is a claim about the rail, not about the leave pack in isolation. (Acknowledged limit, the
 * same one test/sidebar-flyout.test.ts states: the sidebar's hardcoded non-pack rows live in module-private
 * consts inside a `'use client'` component and cannot be imported. None of them addresses /leave/*.)
 */
const ALL_ROWS: { key: string; row: NavChildDescriptor }[] = listPacks('module').flatMap((p) => {
  const pack = p as { id: string; navLinks?: NavChildDescriptor[]; navNodes?: { children: NavChildDescriptor[] }[] };
  return [
    ...(pack.navLinks ?? []).map((row) => ({ key: `${pack.id}:${row.labelKey}`, row })),
    ...(pack.navNodes ?? []).flatMap((n) => n.children.map((row) => ({ key: `${pack.id}:${row.labelKey}`, row }))),
  ];
});

describe('5ca446db — the sidebar lights the new row on both inquiry screens, and lights it alone', () => {
  it('the row set the predicate runs over is real, and contains the rows this block names', () => {
    // Non-vacuity for the two `it.each` tables below: an empty or leave-only row set would make "exactly
    // one lights" trivially true.
    expect(ALL_ROWS.length).toBeGreaterThan(10);
    for (const key of ['leave:employeeLeaveInquiry', 'leave:teamLeaveTracker', 'leave:leaveOverview', 'leave:leaveHistory', 'leave:leaveEntitlements'])
      expect(ALL_ROWS.map((r) => r.key), key).toContain(key);
  });

  const TRUTH: ReadonlyArray<readonly [string, string]> = [
    // pathname                           the ONE pack row that must light
    [BALANCES_HREF, 'leave:employeeLeaveInquiry'],
    [RECORDS_HREF, 'leave:employeeLeaveInquiry'],
    [`${RECORDS_HREF}/EMP-0003`, 'leave:employeeLeaveInquiry'],
    // The separately accessible calendar retains its Manage owner; My Leave's two destinations
    // each have exactly one child row in the grouped self-service node.
    [TRACKER_HREF, 'leave:teamLeaveTracker'],
    ['/leave', 'leave:leaveOverview'],
    ['/leave/history', 'leave:leaveHistory'],
    // …and Entitlements is NOT lit by the new row: the row the reporter opened Leave Config on still wins
    // its own screen.
    ['/admin/leave-config/types', 'leave:leaveEntitlements'],
  ];

  it.each(TRUTH)('on %s exactly one pack nav row lights, and it is %s', (pathname, expected) => {
    const lit = ALL_ROWS.filter(({ row }) => isNavRowActive(pathname, '', row)).map((r) => r.key);
    expect(lit, `on ${pathname}`).toEqual([expected]);
  });

  it('the Leave Config row answers for BOTH inquiry paths, so the fly-out opens on either', () => {
    // `isParentActive` over the node's child paths is what makes the PARENT ("Leave config") light and its
    // section open (components/sidebar.tsx activeSectionKey). Driven through the real exported predicate.
    const childPaths = NODE.children.flatMap((c) => [c.href, ...(c.ownedSubpaths ?? [])]);
    for (const p of [BALANCES_HREF, RECORDS_HREF, `${RECORDS_HREF}/EMP-0003`])
      expect(isParentActive(p, childPaths), `Leave config must be the open section on ${p}`).toBe(true);
    // …and it is NOT the open section on the rail's first tab, which belongs to Manage. The two statements
    // together are the whole of the disclosed consequence.
    expect(isParentActive(TRACKER_HREF, childPaths)).toBe(false);
    // Inside the open panel the sidebar ranks by longest matching href, so exactly one CHILD reads as the
    // current page. On the inquiry paths that child must be the new row and not Entitlements.
    const litChildren = NODE.children.filter((c) => isNavRowActive(BALANCES_HREF, '', c));
    expect(litChildren.map((c) => c.labelKey)).toEqual(['employeeLeaveInquiry']);
  });
});

// ────────────────────────────────── RENDER ──────────────────────────────────

/** Await every async server component in an element tree so react-dom/server can render it. */
const isAsync = (f: unknown) => typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';
async function settle(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (isAsync(el.type)) return settle(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  if (el.props && el.props.children !== undefined) return cloneElement(el, { children: await settle(el.props.children) });
  return node;
}
function toMarkup(tree: ReactNode): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      timeZone: 'Asia/Kuala_Lumpur',
      messages: CATALOGUES.en as never,
      children: tree as never,
    }),
  );
}

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  SCOPE_IDS = [b.companyId];
});
afterAll(async () => {
  await closeAll();
});

describe('5ca446db — the Entitlements page renders, for real, with no way out to the inquiry screen', () => {
  it('renders its heading and its two tabs, and carries NO link to /leave/employee-balances', async () => {
    const html = visible(
      toMarkup(await settle(await EntitlementsPage({ searchParams: Promise.resolve({}) }))),
    );
    // The page is really the Entitlements screen, not an error boundary that happens to lack the link.
    expect(html).toContain(`<h1 class="text-xl font-semibold tracking-tight">${CATALOGUES.en.nav.leaveEntitlements}</h1>`);
    expect(html).toContain('Leave types');
    expect(html).toContain('Entitlement tables');
    // THE ASSERTION THIS FILE EXISTS FOR, on rendered markup rather than on source: the corner link is
    // gone from the screen the reporter photographed.
    expect(html, 'the Employee Balances link is still rendered').not.toContain(`href="${BALANCES_HREF}"`);
    expect(html, 'the caption survived somewhere').not.toContain('Employee Balances');
  });
});

describe('5ca446db — the row lands somewhere usable: Employee Balances renders with no emp=', () => {
  it('keeps its own name and its two-tab rail, and offers the employee picker', async () => {
    const html = visible(
      toMarkup(await settle(await EmployeeBalancesPage({ searchParams: Promise.resolve({}) }))),
    );
    // THE SCREEN KEEPS ITS OWN NAME (point 7): the row says "Employee Leave Inquiry", the page says
    // "Employee Balances". Both strings are read from the catalogue, not typed here.
    expect(html).toContain(`<h1 class="text-xl font-semibold tracking-tight">${CATALOGUES.en.leave.inquiry.balancesTitle}</h1>`);
    expect(html).not.toContain(CATALOGUES.en.nav.employeeLeaveInquiry);
    // Both approved inquiry destinations render, without reviving the retired Details tab.
    expect(html).not.toContain(`href="${TRACKER_HREF}"`);
    for (const href of [BALANCES_HREF, RECORDS_HREF]) expect(html, href).toContain(`href="${href}"`);
    for (const label of ['employeeBalances', 'employeeLeaveRecord'] as const)
      expect(html, label).toContain(CATALOGUES.en.leave.inquiry[label]);
    // With no `emp=` the page renders the picker rather than an error — which is what makes the new row a
    // legitimate destination in its own right.
    //
    // ── r369 (9949f91a): THE PROPERTY IS UNCHANGED, THE PICKER IS NOT ───────────────────────────────────
    // This used to read:
    //     expect(html).toContain('name="emp"');
    //     expect(html).toContain(`action="${BALANCES_HREF}"`);
    // i.e. it proved "there is a picker" by finding a GET form with an `emp` field on it. 9949f91a
    // replaced that filter-row field with the shared CollapsibleEmployeePanel, which selects by pushing
    // `?emp=` through the router rather than by submitting a form — so the old proxy is gone while the
    // thing it stood for is not. The assertion is REPOINTED at the new picker, not relaxed: the panel
    // must be on screen AND the page must say what it is waiting for, which is strictly more than the
    // old form-field check proved. `?emp=` remains the contract (test/employee-scope-panel-guard.ts
    // pins the round trip); this file's job is only that the screen is a usable destination with no id.
    expect(html, 'the employee panel is the picker now').toContain(CATALOGUES.en.leave.inquiry.panelHeading);
    expect(html, 'and it says how to use it').toContain(CATALOGUES.en.leave.inquiry.panelHint);
    // The empty state must be DRAWN — that is the property. Which sentence it carries depends on the
    // scope, and this file's fixture has no employees in it, so the page correctly says "no employees in
    // scope" rather than "pick one". Asserting `pickEmployeeBalances` here would have been asserting the
    // wrong branch and would have read as a page defect; the `data-testid` hook the page carries is what
    // makes the state itself checkable either way.
    expect(html, 'the page draws its empty state rather than an empty table').toContain(
      'data-testid="pick-employee"',
    );
    expect(
      html.includes(CATALOGUES.en.leave.inquiry.noEmployees) ||
        html.includes(CATALOGUES.en.leave.inquiry.pickEmployeeBalances),
      'and that state says something from the catalogue, not a hardcoded string',
    ).toBe(true);
    expect(html, 'a scope with no employees says so, rather than asking for a pick that cannot be made').toContain(
      CATALOGUES.en.leave.inquiry.noEmployees,
    );
  });
});
