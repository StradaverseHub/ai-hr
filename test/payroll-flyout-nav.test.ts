/**
 * 1459e116 — Payroll navigation moves from a horizontal tab strip to the sidebar fly-out.
 *
 * The reporter's complaint was that every payroll function sat in one crowded row of top-level tabs
 * that eats screen space and does not scale. The fix reuses machinery that already exists: the pack
 * contributes a fly-out NODE (packs/payroll/index.ts) instead of the single flat row it carried at
 * ADR-0080 rung 7, and components/payroll-tabs.tsx is deleted.
 *
 * Three properties are worth a regression guard, and they are the three ways this change could
 * quietly hurt someone:
 *
 *   1. NO BROKEN BOOKMARKS. The node's hrefs must be the retired tab strip's, character for
 *      character. A renamed route would 404 for anyone who saved a payroll link.
 *   2. NO DEAD ENTRIES. The approved plan promises the menu is built around pages that exist, so
 *      every href must resolve to a real route file — and the three requested-but-unbuilt
 *      destinations (Payroll Dashboard, Transaction Templates, Year-to-Date) must be absent.
 *   3. THE STRIP IS ACTUALLY GONE. Leaving it behind would give payroll two navigations at once,
 *      which is worse than the crowding the reporter reported.
 *
 * The pack node is imported for real; the sidebar/page halves are source-text checks, the house
 * idiom for `'use client'` module-private structure (test/helpers/sidebar-source.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { payrollPack } from '../packs/payroll';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const NODE = payrollPack.navNodes!.find((n) => n.group === 'admin')!;

/**
 * The retired components/payroll-tabs.tsx destinations, captured VERBATIM from the commit before
 * 1459e116. hrefs are the tab strip's; only the labelKey namespace moved (components.payrollTabs →
 * nav). This is the SET the fly-out must carry — no destination lost, no href renamed.
 *
 * 956cec85 — `/payroll/statutory-forms` is an ADDITION to that set, not a change to it. The guard's
 * promise is "no destination lost, no href renamed", which a new row cannot violate; every original
 * entry below is untouched. It is listed explicitly rather than the assertion being loosened to
 * "contains", because a set guard that only checks a subset stops noticing a deletion.
 *
 * a1d82340 STEP 3 — the ORDER is no longer asserted from a literal here. It is DERIVED from
 * packs/payroll/phases.ts, the one declaration of the payroll sequence (test/payroll-phase-order.test.ts).
 * A literal list could be edited to match a drifted menu without anyone noticing.
 */
const EXPECTED_SET = [
  // efe1d230 — `/payroll/guide` is REMOVED from this set, the only removal it has ever taken. It is a
  // deletion of a DESTINATION, which is exactly what this guard exists to catch, so it is recorded
  // here rather than quietly dropped: the Workflow Guide page is retired and its eight-check
  // per-company readiness report moved to /payroll/setup?readiness=full. Nothing else changed; the
  // remaining hrefs are still the retired tab strip's, character for character.
  { href: '/payroll', labelKey: 'payrollProcess' },
  { href: '/payroll/transactions', labelKey: 'payrollTransactions' },
  // 6d72816e — an ADDITION, like statutory-forms and individual-payslip below. The /admin/loans SCREEN
  // already existed and was reachable only from a card on the Transactions hub; this is its menu row.
  { href: '/admin/loans', labelKey: 'loans' },
  { href: '/payroll/transaction-view', labelKey: 'payrollTransactionView' },
  // 169e3c24 — an ADDITION to the set, like statutory-forms above. Every original entry is untouched, so
  // the guard's promise ("no destination lost, no href renamed") is not weakened by listing it.
  { href: '/payroll/individual-payslip', labelKey: 'payrollIndividualPayslip' },
  { href: '/payroll/reports', labelKey: 'payrollReports' },
  { href: '/payroll/statutory-forms', labelKey: 'payrollStatutoryForms' },
  { href: '/payroll/setup', labelKey: 'payrollSettings' },
] as const;

const byHref = (a: { href: string }, b: { href: string }) => a.href.localeCompare(b.href);

describe('1459e116 — the payroll fly-out carries the retired tab strip, unbroken', () => {
  it('lists every tab-strip destination, with its href and label key unchanged', () => {
    // Order-insensitive: the SET is 1459e116's promise (no broken bookmark, no lost screen). The
    // sequence is a1d82340's, asserted below.
    expect([...NODE.children.map((c) => ({ href: c.href, labelKey: c.labelKey }))].sort(byHref)).toEqual(
      [...EXPECTED_SET].map((e) => ({ href: e.href, labelKey: e.labelKey })).sort(byHref),
    );
  });

  it('opens with Payroll Process (efe1d230’s landing-page promise)', () => {
    // 1459e116 asked for "read the guide, then run the payroll" and this assertion pinned the guide
    // first. efe1d230 WITHDRAWS that: the guide is "a menu row nobody starts from" and the approved
    // plan says "Payroll Process becomes the landing page when you open the Payroll module". The
    // fly-out focuses its first child on open (components/nav-flyout.tsx `firstLinkRef`), so the
    // first row IS the landing page — this is the assertion that promise reduces to. Updated, not
    // deleted: without it the menu's opening row is unguarded again.
    expect(NODE.children[0]!.href).toBe('/payroll');
  });

  it('no longer carries the retired Workflow Guide, and no route in the tree links to it', () => {
    // Both halves matter. A menu row pointing at a deleted page 404s; a LINK pointing at it 404s just
    // as hard and no nav guard would see it. The two links that existed (Payroll Settings and the
    // payroll run screen) were repointed at the report's new home, not removed.
    expect(NODE.children.some((c) => c.href === '/payroll/guide')).toBe(false);
    expect(exists('app/payroll/guide/page.tsx'), 'the guide route is still on disk').toBe(false);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.next' || e.name === 'graphify-out') continue;
          walk(rel);
        } else if (/\.tsx?$/.test(e.name) && read(rel).includes("'/payroll/guide'")) offenders.push(rel);
      }
    };
    for (const d of ['app', 'components', 'lib', 'packs']) walk(d);
    expect(offenders, 'links to the retired /payroll/guide').toEqual([]);
  });

  it('gates nothing per-row (the Administration group is adminOnly wholesale, as before)', () => {
    // A stray per-row flag here would be a silent access change, not a nav change.
    for (const c of NODE.children) {
      expect(c.adminOnly, `${c.href} adminOnly`).toBeUndefined();
      expect(c.managerUp, `${c.href} managerUp`).toBeUndefined();
    }
  });

  it('every href resolves to a route that exists (no dead entries)', () => {
    for (const c of NODE.children) {
      const page = `app${c.href === '/' ? '' : c.href}/page.tsx`;
      expect(exists(page), `${c.href} has no page at ${page}`).toBe(true);
    }
  });

  it('does not invent entries for the three requested-but-unbuilt destinations', () => {
    // Payroll Dashboard, Transaction Templates and Year-to-Date are in the reporter's tree but have
    // no screen. The plan promised room for them, not menu rows that lead nowhere.
    const labels = NODE.children.map((c) => c.labelKey.toLowerCase());
    for (const absent of ['dashboard', 'template', 'yeartodate', 'ytd']) {
      expect(labels.some((l) => l.includes(absent)), `no "${absent}" entry until the screen exists`).toBe(false);
    }
  });

  it('every label key exists in the nav namespace of all six locales', () => {
    // The flyout resolves child labels through useTranslations('nav'); a key missing from a locale
    // renders the raw key in the menu. (Whole-file coverage is test/i18n-coverage.test.ts; this
    // pins THESE keys so the guard names the payroll rows when it breaks.)
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const nav = JSON.parse(read(`messages/${loc}.json`)).nav as Record<string, string>;
      for (const c of [{ labelKey: NODE.labelKey }, ...NODE.children]) {
        expect(nav[c.labelKey], `nav.${c.labelKey} missing from ${loc}.json`).toBeTruthy();
      }
    }
  });
});

describe('1459e116 — the tab strip is gone, not merely bypassed', () => {
  it('components/payroll-tabs.tsx no longer exists', () => {
    expect(exists('components/payroll-tabs.tsx')).toBe(false);
  });

  it('no payroll page still renders or imports it', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.tsx') && read(rel).includes('PayrollTabs')) offenders.push(rel);
      }
    };
    walk('app/payroll');
    expect(offenders, 'PayrollTabs references left behind').toEqual([]);
  });

  it('its i18n namespace is retired with it (no orphaned components.payrollTabs block)', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const components = JSON.parse(read(`messages/${loc}.json`)).components as Record<string, unknown>;
      expect(components.payrollTabs, `components.payrollTabs still in ${loc}.json`).toBeUndefined();
    }
  });
});

describe('1459e116 — one row at a time reads as the current page', () => {
  it('the sidebar ranks a panel’s matching children by path specificity', () => {
    // Requirement 3 of the ticket ("clearly highlight the currently selected page"). isHrefActive
    // matches by path PREFIX, so the node's own /payroll row matches while the viewer sits on
    // /payroll/setup — without the longest-match tie-break two rows would light up at once.
    const sidebar = read('components/sidebar.tsx');
    expect(sidebar, 'panel active row is resolved once, not per-row').toContain('activeChildHref');
    expect(sidebar).toMatch(/href === activeChildHref/);
  });

  it('the parent row still highlights for the whole module', () => {
    // The rail keeps the query-insensitive parent predicate, so "Payroll" stays lit on every
    // payroll screen — that behaviour is unchanged by the row-level tie-break above.
    expect(read('components/sidebar.tsx')).toContain('isParentActive(pathname');
  });
});
