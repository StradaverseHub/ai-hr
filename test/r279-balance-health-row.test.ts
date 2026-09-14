/**
 * r279 (3fbf7a02) — LEAVE BALANCE HEALTH GETS ITS OWN MENU ROW AND ITS OWN PAGE.
 *
 * THE REQUEST, and why it is a navigation item rather than a feature. `LeaveConfigHealthCard` is the one
 * screen that says WHY a leave balance reads 0.00 — which types have no entitlement table, which have no
 * earning method, which benefit scheme expired. It was drawn at page level on the Leave types tab
 * (`/admin/leave-config/types`), between the tab row and the workspace, and NOTHING in the menu said it
 * existed: to reach it you opened Entitlements, stayed on the first tab and scrolled. The screen that
 * explains a missing balance was the screen you had to already know about before you could find it.
 *
 * SO THE WHOLE CHANGE IS A MOUNT POINT AND A MENU ROW: one new fly-out child (SECOND, directly under
 * Entitlements, because it answers the question you ask about entitlements), one new guarded page that
 * renders the SAME component from the SAME derivation, one route registered on the EXISTING `leaveConfig`
 * column, one label key in six catalogues, and the old page-level mount deleted. No migration, no service
 * change, no new finding, no reworded finding, no change to what counts as Ready / Needs attention /
 * Cannot grant — `lib/leave-config-health.ts` is untouched.
 *
 * ⚠️ ONE THING DELIBERATELY DOES NOT MOVE, and the move is only safe because of it. The per-type
 * `LeaveConfigHealthNotice` — the scoped arm of the ternary in the shared entitlement-tables block — shows
 * ONE leave type's findings beside that type's own tables, and it stays exactly where it is. A warning on
 * a different screen from the thing it is about gets ignored; that is why it was built, and the disclosed
 * cost of moving the full list (it is now further from the tables you would edit to clear it) is what the
 * notice covers. §A pins that it survived.
 *
 * THREE HALVES, the house shape (test/r269-employee-leave-inquiry-row.test.ts).
 *
 *   §A SOURCE SHAPE — the promises a later round could quietly undo with no behaviour test noticing: the
 *      row's position and href, its absence from the map and from any row's `ownedSubpaths`, its
 *      registration on `leaveConfig` (not a new column), the label in six catalogues, the page being a
 *      thin wrapper over the shared component rather than a second derivation, and the old mount gone
 *      from the Leave types tab while that tab KEEPS the derivation and the per-type notice.
 *   §B HIGHLIGHTING — driven through the REAL exported predicates over every nav row every pack
 *      contributes, because the failure this change could most easily cause is two rows lighting at once.
 *   §C RENDER — the real pages against a real database. A 200 is not a render check and neither is a
 *      source scan (CLAUDE.md §8), and the claim being made here is visual: the table IS on the new page
 *      and is GONE from the Leave types tab. `<script>` is stripped first, because the RSC payload carries
 *      the whole catalogue and grepping fetched HTML for a label proves nothing.
 *
 * ⚠️ FILE-LEVEL MOCKS: requireAdmin()/scopedAdmin() are fakes returning the module-level ADMIN;
 * getTranslations/getLocale are a REAL translator over messages/en.json (next-intl's own
 * `createTranslator`, rethrowing MISSING_MESSAGE / FORMATTING_ERROR) so the assertions read SENTENCES, not
 * key names; next/headers gives an empty cookie jar. Server components are `async` and react-dom/server
 * cannot render one, so `settle()` awaits every async component before `renderToStaticMarkup`.
 *
 * NON-VACUITY (done by the builder, re-derivable by the verifier): put
 * `<LeaveConfigHealthCard rows={configHealth} />` back on a copy of app/admin/leave-config/types/page.tsx
 * and BOTH §A's "the old mount is gone" case and §C's rendered Leave types case fail; delete the row from
 * a copy of packs/leave/index.ts and §A's position case and §B's highlight case fail on the new address.
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
import BalanceHealthPage from '../app/admin/leave-config/balance-health/page';
import LeaveTypesPage from '../app/admin/leave-config/types/page';
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
  { nav: Record<string, string>; admin: Record<string, unknown> }
>;
/** One catalogue leaf, resolved by dotted path and asserted to BE a string — so a key that silently
 *  becomes an object (or vanishes) fails here rather than making a `toContain` vacuously true. */
function str(loc: (typeof LOCALES)[number], dotted: string): string {
  const v = dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), CATALOGUES[loc]);
  expect(typeof v, `${loc}: ${dotted} must be a string`).toBe('string');
  return v as string;
}
/** The `admin.entitlementTemplates` leaf the card and the notice read, in English. */
const et = (key: string) => str('en', `admin.entitlementTemplates.${key}`);
/** Strip <script> before counting — a key in the RSC payload is not a screen (CLAUDE.md §8). */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');

const HEALTH_HREF = '/admin/leave-config/balance-health';
const HEALTH_PAGE = 'app/admin/leave-config/balance-health/page.tsx';
const TYPES_HREF = '/admin/leave-config/types';
const TYPES_PAGE = 'app/admin/leave-config/types/page.tsx';
const BLOCK = 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';

const NODE = leavePack.navNodes!.find((n) => n.group === 'admin')!;
const HEALTH_ROW = NODE.children.find((c) => c.href === HEALTH_HREF)!;
/**
 * The strings only the CARD renders, and the list is SHORTER than the card's own string set on purpose.
 *
 * The per-type `LeaveConfigHealthNotice` renders none of these (it leads with `healthTitle`), which is
 * what makes "the card is gone / the notice stayed" separable in rendered markup. `healthColLeaveType`
 * ("Leave type") and `healthColStatus` ("Status") are deliberately NOT here: both are ordinary words the
 * Leave types tab draws elsewhere — the unfiltered entitlement grid has its own Leave type column — so
 * asserting their absence would fail against correct code, which is worse than no guard (r134). The new
 * page's own case asserts those two as `<th>` cells instead, where they can only be the card's.
 */
const CARD_ONLY = ['healthCardTitle', 'healthCardHelp', 'healthColWhatIsMissing'] as const;
/** Comments are not code: the page's own note explains WHY a warning stays beside the thing it warns
 *  about, and the word "warning" in prose must not read as a verdict this file re-decides (r134). */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

// ────────────────────────────────── §A · SOURCE SHAPE ──────────────────────────────────

describe('r279 §A — the row, the page, and the mount that moved', () => {
  it('the row is the SECOND child, directly under Entitlements, and opens the new address', () => {
    expect(HEALTH_ROW, 'the Balance Health row is gone').toBeTruthy();
    expect(HEALTH_ROW.labelKey).toBe('leaveBalanceHealth');
    // "Directly under Entitlements" asserted as the PAIR, so the row cannot drift down the list while
    // still technically being second to something.
    expect(NODE.children.map((c) => c.labelKey).slice(0, 2)).toEqual(['leaveEntitlements', 'leaveBalanceHealth']);
    expect(NODE.children[0].href).toBe(TYPES_HREF);
    // …and the row the reporter asked to stay at the bottom is still at the bottom (r269's promise).
    expect(NODE.children.at(-1)!.labelKey).toBe('employeeLeaveInquiry');
  });

  it('it is a real guarded page on the EXISTING leaveConfig column — no new permission is invented', () => {
    expect(exists(HEALTH_PAGE)).toBe(true);
    expect(read(HEALTH_PAGE)).toContain('requireAdmin()');
    // Both halves or neither: test/function-access.test.ts fails on a guarded page with no column AND on
    // a registered route with no page.
    expect(REGISTERED_ROUTES.has(HEALTH_HREF)).toBe(true);
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    expect(leaveConfig.routes).toContain(HEALTH_HREF);
    expect(leaveConfig.guard).toBe('requireAdmin');
    // Exactly one column answers for it, and it is not a new one: this listing WAS the Leave types tab,
    // so everybody who could read it there can read it here and nobody new can.
    expect(SCREENS.filter((s) => s.routes.includes(HEALTH_HREF))).toHaveLength(1);
    expect(SCREENS.map((s) => s.screenKey)).not.toContain('leaveBalanceHealth');
  });

  it('it is a SIBLING row, not a third tab of Entitlements: no map group, and nobody owns its path', () => {
    // A map group is a row AND ITS TABS — every group leads with its own row's href — so a group here
    // would either draw a tab strip for a one-screen row or read as a tab of the row above.
    expect(LEAVE_CONFIG_MAP.map((g) => g.navKey as string)).not.toContain('leaveBalanceHealth');
    expect(LEAVE_CONFIG_MAP.flatMap((g) => g.items.map((i) => i.href))).not.toContain(HEALTH_HREF);
    // Nothing owns its path: `ownedSubpaths` is highlighting only, and the Entitlements row claiming this
    // address would light the row above while the reader is on this one.
    for (const c of NODE.children) expect(c.ownedSubpaths ?? [], `${c.labelKey} must not own it`).not.toContain(HEALTH_HREF);
    expect(HEALTH_ROW.ownedSubpaths ?? [], 'it has no tabs and no sub-screen of its own').toEqual([]);
    // Highlighting is not a gate: the Administration group is gated wholesale and the page guards itself.
    expect(HEALTH_ROW.adminOnly).toBeUndefined();
    expect(HEALTH_ROW.managerUp).toBeUndefined();
    // Without a group it cannot read the row helper, so it carries its own PageHeader titled from the
    // row's own key — the heading-equals-row rule (r266) reached without the map.
    const src = read(HEALTH_PAGE);
    expect(src).not.toContain('<LeaveConfigMap');
    expect(src).not.toContain('leaveConfigPageHeader(');
    expect(src).toContain('<PageHeader');
    expect(src).toContain(`tNav('${HEALTH_ROW.labelKey}')`);
  });

  it('the label is its own key in all six catalogues, translated, and takes no ICU argument', () => {
    for (const loc of LOCALES) {
      const v = str(loc, 'nav.leaveBalanceHealth');
      expect(v.trim().length, `${loc}: nav.leaveBalanceHealth is empty`).toBeGreaterThan(0);
      // Rendered by a bare t() — a {brace} throws FORMATTING_ERROR at render behind a green 200.
      expect(v, `${loc}: unexpected ICU argument`).not.toMatch(/[{}]/);
      if (loc !== 'en') expect(v, `${loc}: left in English`).not.toBe(str('en', 'nav.leaveBalanceHealth'));
      // It does not hijack an existing key: the card keeps its own title string in every catalogue.
      expect(
        str(loc, 'admin.entitlementTemplates.healthCardTitle').length,
        `${loc}: the card keeps its name`,
      ).toBeGreaterThan(0);
    }
  });

  it('the page is a THIN WRAPPER: the shared component over the shared derivation, not a second copy', () => {
    const src = read(HEALTH_PAGE);
    // One definition, two readers. Both imports are the ones the Leave types tab already used.
    expect(src).toContain("from '@/components/leave/leave-config-health'");
    expect(src).toContain("from '@/lib/leave-config-health'");
    expect(src).toContain('leaveConfigHealthAll(');
    expect(src).toContain('<LeaveConfigHealthCard rows={rows} />');
    // …and the loader is the SHARED page-level load, not a bespoke reader free to drift from the tables
    // the card is quoting from.
    expect(src).toContain('loadEntitlementTablesData(s)');
    // NOTHING ABOUT THE CHECK ITSELF CHANGED: the page states no verdict of its own. `leaveConfigHealthAll`
    // is the only thing on it that decides anything, and the three states are named nowhere in its CODE.
    const code = stripComments(src);
    for (const verdict of ["'blocked'", "'warning'", "'ready'", 'isBlockingFinding', 'tablesReachNobody'])
      expect(code, `${verdict} would be a second opinion about what counts as healthy`).not.toContain(verdict);
  });

  it('the old page-level mount is GONE from the Leave types tab, which KEEPS the derivation', () => {
    const types = read(TYPES_PAGE);
    // The card, and its import, left together: two copies of one list drift the moment either improves.
    expect(types, 'the full listing must live at one address').not.toContain('<LeaveConfigHealthCard');
    expect(types, 'the import left with the mount').not.toContain('LeaveConfigHealthCard }');
    // …but the DERIVATION stays, because the leave-type rail reads it for the per-type "reaches nobody"
    // badge. Removing it would take a second surface away in a change nobody asked that of.
    expect(types).toContain('leaveConfigHealthAll(');
    expect(types).toContain('tablesReachNobody(h)');
    // The tab is otherwise untouched: same heading, same tab row, same workspace, same tables block.
    for (const kept of ['<LeaveConfigMap current="leaveTypes"', '<EntitlementTablesBlock', '<LeaveTypeWorkspace'])
      expect(types, kept).toContain(kept);
  });

  it('THE PER-TYPE NOTICE STAYS: the scoped arm of the ternary is untouched, flag order and all', () => {
    // The half of r209 that deliberately did not move. A warning on a different screen from the thing it
    // is about gets ignored — which is the whole reason the scoped arm exists, and the reason moving the
    // unscoped LIST is safe at all.
    const block = read(BLOCK);
    expect(block).toContain('{!showConfigHealth ? null : scopedHealth ? (');
    expect(block).toContain('<LeaveConfigHealthNotice health={scopedHealth} />');
    expect(block).toContain('<LeaveConfigHealthCard rows={allHealth} />');
    // Order is still load-bearing: a caller that said "do not draw this" must not fall through.
    expect(block.indexOf('!showConfigHealth ? null')).toBeLessThan(block.indexOf('<LeaveConfigHealthNotice'));
    // The leave type tab still mounts the block SCOPED, so the notice it draws is that type's own.
    const types = read(TYPES_PAGE);
    expect(types).toContain('leaveTypeId={leaveTypeId}');
    expect(types).not.toContain('showConfigHealth={false}');
    // …and the derivation the reporter was promised would not change is not touched by this round.
    expect(read('lib/leave-config-health.ts')).toContain('export function leaveConfigHealthAll(');
  });
});

// ────────────────────────────────── §B · HIGHLIGHTING ──────────────────────────────────

/** Every nav row EVERY registered pack contributes — flat rows and fly-out children alike — so "exactly
 *  one row lights" is a claim about the rail, not about the leave pack in isolation. */
const ALL_ROWS: { key: string; row: NavChildDescriptor }[] = listPacks('module').flatMap((p) => {
  const pack = p as { id: string; navLinks?: NavChildDescriptor[]; navNodes?: { children: NavChildDescriptor[] }[] };
  return [
    ...(pack.navLinks ?? []).map((row) => ({ key: `${pack.id}:${row.labelKey}`, row })),
    ...(pack.navNodes ?? []).flatMap((n) => n.children.map((row) => ({ key: `${pack.id}:${row.labelKey}`, row }))),
  ];
});

describe('r279 §B — the sidebar lights the new row on its own screen, and lights it alone', () => {
  it('the row set the predicate runs over is real, and contains the rows this block names', () => {
    // Non-vacuity for the table below: an empty or leave-only row set would make "exactly one" trivial.
    expect(ALL_ROWS.length).toBeGreaterThan(10);
    for (const key of ['leave:leaveBalanceHealth', 'leave:leaveEntitlements', 'leave:employeeLeaveInquiry'])
      expect(ALL_ROWS.map((r) => r.key), key).toContain(key);
  });

  const TRUTH: ReadonlyArray<readonly [string, string]> = [
    // pathname                                    the ONE pack row that must light
    [HEALTH_HREF, 'leave:leaveBalanceHealth'],
    // …and the tab it left still lights ITS row, including on the tab Entitlements owns. A prefix match
    // between two `/admin/leave-config/*` siblings is exactly the way this change could light two rows.
    [TYPES_HREF, 'leave:leaveEntitlements'],
    ['/admin/leave-config/entitlement-tables', 'leave:leaveEntitlements'],
  ];

  it.each(TRUTH)('on %s exactly one pack nav row lights, and it is %s', (pathname, expected) => {
    const lit = ALL_ROWS.filter(({ row }) => isNavRowActive(pathname, '', row)).map((r) => r.key);
    expect(lit, `on ${pathname}`).toEqual([expected]);
  });

  it('Leave config is the open section on the new screen', () => {
    const childPaths = NODE.children.flatMap((c) => [c.href, ...(c.ownedSubpaths ?? [])]);
    expect(isParentActive(HEALTH_HREF, childPaths), 'the fly-out must open on its own row').toBe(true);
    const litChildren = NODE.children.filter((c) => isNavRowActive(HEALTH_HREF, '', c));
    expect(litChildren.map((c) => c.labelKey)).toEqual(['leaveBalanceHealth']);
  });
});

// ────────────────────────────────── §C · RENDER ──────────────────────────────────

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

describe('r279 §C — the table is on the new page, in the real markup', () => {
  it('renders the row\'s heading and the health table itself', async () => {
    const html = visible(toMarkup(await settle(await BalanceHealthPage())));
    // The page is really this screen, headed by the menu row that opened it.
    expect(html).toContain(`<h1 class="text-xl font-semibold tracking-tight">${str('en', 'nav.leaveBalanceHealth')}</h1>`);
    // THE TABLE, not merely the words: the three column headers in a <th>, which only the card renders.
    for (const key of ['healthColLeaveType', 'healthColStatus', 'healthColWhatIsMissing'])
      expect(html, key).toContain(`>${et(key)}</th>`);
    expect(html).toContain(et('healthCardTitle'));
    expect(html).toContain(et('healthCardHelp'));
    // …and it is the listing, not an empty shell: the seed's leave types produce rows with a verdict.
    const statuses = ['healthStatusReady', 'healthStatusWarning', 'healthStatusBlocked'].filter((k) =>
      html.includes(et(k)),
    );
    expect(statuses.length, 'no leave type reported a verdict — the card rendered empty').toBeGreaterThan(0);
    // No tab strip and no second navigation: this row has one screen.
    expect((html.match(/<nav /g) ?? []).length).toBe(0);
  });
});

describe('r279 §C — and it is GONE from the Leave types tab, which still renders', () => {
  it('the Leave types tab renders without the card, keeping its heading, tabs and workspace', async () => {
    const html = visible(toMarkup(await settle(await LeaveTypesPage({ searchParams: Promise.resolve({}) }))));
    // The page is really the Leave types screen, not an error boundary that happens to lack a card.
    expect(html).toContain(`<h1 class="text-xl font-semibold tracking-tight">${str('en', 'nav.leaveEntitlements')}</h1>`);
    expect(html).toContain(str('en', 'admin.leaveConfigMap.item.leaveTypes'));
    expect(html).toContain(str('en', 'admin.leaveConfigMap.item.entitlementTables'));
    // THE ASSERTION THIS BLOCK EXISTS FOR, on rendered markup rather than on source: every string only
    // the CARD draws is absent. The per-type Notice renders none of these, so this cannot pass merely
    // because the notice was deleted too — the next assertion proves the notice is still there.
    for (const key of CARD_ONLY)
      expect(html, `${key} is still on the Leave types tab`).not.toContain(et(key));
    // …and the page really rendered its CONTENT, not just a header: the workspace section is here, so
    // "the card is absent" is a statement about a page that drew everything else.
    expect(html, 'the leave-type workspace must still render').toContain(str('en', 'admin.leave.typesSectionTitle'));
    //
    // ⚠️ THE PER-TYPE NOTICE IS PINNED IN §A, NOT HERE, AND THAT IS A LIMIT OF THIS HARNESS RATHER THAN A
    // gap in the claim. The notice is drawn by the shared tables block inside each leave type's tab 3,
    // and that node reaches `LeaveTypeTabs` as the `panels` PROP — not as `children` — so `settle()`
    // never awaits it and no amount of asserting here would see it either way. Asserting its absence
    // would be vacuous and asserting its presence impossible, so its survival is held where it can
    // actually fail: §A reads the ternary in the block's source, exactly as test/r209-leave-config-health
    // .test.ts has always held it.
  });
});
