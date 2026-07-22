/**
 * System Settings nav consolidation guard (item a4e49748).
 *
 * The ticket consolidates the three system-wide setup screens — Employee ID Auto Running Number
 * (/admin/settings/employee-id), Dashboard Cards (/admin/settings/dashboard) and System Labels
 * (/admin/settings/system-labels) — under a single collapsible "System Settings" parent inside the
 * Administration nav group, in that order, with NO functional change to the screens themselves.
 *
 * `GROUPS` / `SYSTEM_SETTINGS_NODE` are module-private consts in a `'use client'` component, so this
 * is a source-text check on components/sidebar.tsx (see test/helpers/sidebar-source.ts), mirroring
 * test/sidebar-attendance-group.test.ts.
 *
 * Deliberately NOT asserted here:
 *   - the per-child `adminOnly: true` flags — they are redundant today (the admin group is gated
 *     adminOnly wholesale before per-child filtering runs) and kept only for consistency with
 *     REPORTS_NODE; leaving them unasserted lets a future cleanup remove them without a red build;
 *   - the en display string for nav.systemSettings — key coverage lives in test/i18n-coverage.test.ts,
 *     and pinning copy here would break a structure test on any future copy tweak or rebrand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countQuoted, nodeBlock } from './helpers/sidebar-source';

const SIDEBAR = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
const LAYOUT = fs.readFileSync(path.resolve(__dirname, '../app/layout.tsx'), 'utf8');

/** The ticket's three relocated screens, in its required order. */
const TICKET_HREFS = [
  '/admin/settings/employee-id',
  '/admin/settings/dashboard',
  '/admin/settings/system-labels',
] as const;

/**
 * The admin group's FULL flat-row href list, in order. Splicing three rows out of the middle of a
 * long array literal is exactly where an adjacent row gets clipped (the /admin/leave row that
 * follows carries a multi-line comment, 0d147b78), so assert the whole list — a dropped or
 * reordered sibling fails loudly. Collapsible nodes (SYSTEM_SETTINGS_NODE, REPORTS_NODE) are
 * referenced by const name, not href, so they are asserted separately by position.
 */
const ADMIN_GROUP_FLAT_HREFS = [
  '/admin/organization',
  '/admin/personnel',
  '/admin/leave',
  '/admin/claims',
  '/payroll',
  '/analytics',
  '/admin/audit',
  '/admin/scheduled-actions',
  '/admin/privacy',
  '/admin/ai',
  '/admin/users',
] as const;

/** The admin group literal: from its labelKey to the end of the GROUPS array. It is the last group,
 *  so slicing to the array's closing `\n];` captures exactly its rows. */
function adminGroupBlock(): string {
  const start = SIDEBAR.indexOf(`labelKey: 'admin'`);
  expect(start, 'admin group exists in sidebar.tsx').toBeGreaterThan(-1);
  const end = SIDEBAR.indexOf('\n];', start);
  expect(end, 'GROUPS array is terminated after the admin group').toBeGreaterThan(start);
  return SIDEBAR.slice(start, end);
}

describe('sidebar System Settings group (a4e49748 consolidation)', () => {
  const node = nodeBlock(SIDEBAR, 'SYSTEM_SETTINGS_NODE');

  it('declares a SYSTEM_SETTINGS_NODE labelled with the nav.systemSettings key', () => {
    expect(node, 'SYSTEM_SETTINGS_NODE declaration exists in sidebar.tsx').not.toBeNull();
    expect(node!).toMatch(/labelKey:\s*'systemSettings'/);
  });

  it('contains the three setup screens as children, in the ticket order', () => {
    const positions = TICKET_HREFS.map((href) => {
      const idx = node!.indexOf(`'${href}'`);
      expect(idx, `${href} is a child of the System Settings node`).toBeGreaterThan(-1);
      return idx;
    });
    const sorted = [...positions].sort((a, b) => a - b);
    expect(
      positions,
      'children follow the ticket order (Employee ID → Dashboard Cards → System Labels)',
    ).toEqual(sorted);
  });

  it('lists each of the three hrefs exactly once across the whole sidebar (old flat rows removed, not duplicated)', () => {
    for (const href of TICKET_HREFS) {
      expect(countQuoted(SIDEBAR, href), `${href} appears exactly once in sidebar.tsx`).toBe(1);
    }
  });

  it('keeps the admin group’s full flat-row href list intact and in order (no sibling clipped by the splice)', () => {
    const block = adminGroupBlock();
    const hrefs = [...block.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    expect(hrefs).toEqual([...ADMIN_GROUP_FLAT_HREFS]);
  });

  it('places SYSTEM_SETTINGS_NODE immediately after the /admin/personnel row (before /admin/leave)', () => {
    const block = adminGroupBlock();
    const personnel = block.indexOf(`'/admin/personnel'`);
    const nodeRef = block.indexOf('SYSTEM_SETTINGS_NODE');
    const leave = block.indexOf(`'/admin/leave'`);
    expect(personnel, '/admin/personnel row exists').toBeGreaterThan(-1);
    expect(nodeRef, 'SYSTEM_SETTINGS_NODE is referenced in the admin group').toBeGreaterThan(personnel);
    expect(leave, 'SYSTEM_SETTINGS_NODE sits before the /admin/leave row').toBeGreaterThan(nodeRef);
  });

  // fdc20776 (flyout redesign) removed per-group open/closed persistence entirely: panels are
  // show-on-demand, so there are no cookieKeys in sidebar.tsx and no nav_*_open SSR cookie reads
  // in app/layout.tsx any more. The former cookieKey↔layout-read invariant is therefore obsolete;
  // this guard keeps the machinery from silently coming back half-wired (a reintroduced cookieKey
  // with no SSR read was the original always-closed bug).
  it('per-group nav cookies stay fully removed (no cookieKey without an SSR read coming back)', () => {
    const keys = [...SIDEBAR.matchAll(/cookieKey: '([^']+)'/g)].map((m) => m[1]);
    for (const key of keys) {
      expect(
        LAYOUT.includes(`cookieStore.get('${key}')`),
        `app/layout.tsx SSR-reads the '${key}' cookie`,
      ).toBe(true);
    }
  });
});

describe('sidebar System Settings label (a4e49748 i18n parity)', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const nav = Object.fromEntries(
    LOCALES.map((l) => [
      l,
      (
        JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${l}.json`), 'utf8')) as {
          nav: Record<string, string>;
        }
      ).nav,
    ]),
  ) as Record<(typeof LOCALES)[number], Record<string, string>>;

  it('nav.systemSettings exists and is non-empty in all six locales', () => {
    for (const l of LOCALES) {
      const v = nav[l].systemSettings;
      expect(typeof v, `${l}: nav.systemSettings present`).toBe('string');
      expect(v.trim().length, `${l}: nav.systemSettings non-empty`).toBeGreaterThan(0);
    }
  });

  // test/i18n-coverage.test.ts only fails on missing/empty/null keys, so pasting the English value
  // into all six files would ship five locales in English with a fully green build — the single most
  // likely failure mode of this change. Guard actual translation, not just presence.
  it('nav.systemSettings is actually translated in the five non-English locales', () => {
    const en = nav.en.systemSettings;
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      expect(nav[l].systemSettings, `${l}: nav.systemSettings differs from the en value`).not.toBe(en);
    }
  });
});
