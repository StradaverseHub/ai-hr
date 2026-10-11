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
 * The node has since grown past a4e49748's three (476f23ed Movement Settings, 7b5f18c3 Hiring Defaults,
 * deec1691 System Analysis, 4509d2b8 Holidays), so SYSTEM_SETTINGS_CHILD_HREFS pins the WHOLE child list
 * in order — the same anti-clipping argument as ADMIN_GROUP_FLAT_HREFS below. A genuinely new row is
 * declared there; it is not enough for it to simply not break the three original assertions.
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
 * The node's FULL child order, every row of it.
 *
 * a4e49748 asserted only its own three screens, which was right while the node held three. It now holds
 * seven, grown one item at a time, and the same argument that produced ADMIN_GROUP_FLAT_HREFS below
 * applies here: splicing a row into the middle of a long literal is exactly where a neighbour gets
 * clipped. Asserting the whole list means a new row must be DECLARED rather than tolerated.
 *
 * 4509d2b8 added Holidays — after Hiring Defaults, before System Analysis. System Analysis is last on
 * purpose (it is a reference screen, not a setup step), so a new setup row lands ahead of it.
 *
 * e6be5a3b (r330) REFINES that rule rather than breaking it. The node now ends in TWO vendor-facing
 * reference surfaces — System Analysis, then System Testing — and the rule is unchanged for every row
 * that matters: a SETUP row still lands ahead of both. The pair is asserted by position below, so
 * "System Analysis is last among the setup rows" keeps its force and a third reference screen cannot be
 * quietly wedged between the setup rows and these two.
 */
const SYSTEM_SETTINGS_CHILD_HREFS = [
  '/admin/settings/employee-id',
  '/admin/settings/dashboard',
  '/admin/settings/system-labels',
  '/admin/settings/movement',
  '/admin/settings/hiring-defaults',
  // 4509d2b8 — moved out of the Attendance settings node (packs/attendance/index.ts). It is company-wide
  // setup, not attendance config: one holiday list, read by leave, attendance and payroll alike.
  '/admin/holidays',
  // r261 (9583deac stage three) — Employee Change Requests: which fields an employee may ask to change,
  // and who approves. DECLARED here rather than tolerated, which is the whole point of asserting the
  // full list: a row spliced into the middle of this node is exactly where a neighbour gets clipped.
  '/admin/settings/profile-requests',
  '/admin/system-explorer',
  // e6be5a3b (r330) — System Testing, the test-case library. DECLARED here, and last: like System
  // Analysis directly above it, it is a vendor-facing reference surface rather than company setup, and
  // like it, it is entitlement-gated (a sellable module that defaults OFF) as well as admin-gated.
  '/admin/system-testing',
] as const;

/**
 * The admin group's FULL flat-row href list, in order. Splicing three rows out of the middle of a
 * long array literal is exactly where an adjacent row gets clipped, so assert the whole list — a
 * dropped or reordered sibling fails loudly. Rows referenced by const name, not href — the
 * collapsible nodes (SYSTEM_SETTINGS_NODE, REPORTS_NODE) and, since ADR-0080, the registry-mounted
 * CLAIMS_CONFIG_ROW (rung 3, /admin/claims → packs/claims) and LEAVE_CONFIG_NODE (rung 6,
 * /admin/leave → packs/leave) — are asserted separately by position.
 */
const ADMIN_GROUP_FLAT_HREFS = [
  // Workflow email category policy; separate from installation-wide SMTP settings.
  '/admin/settings/notifications',
  '/admin/settings/email',
  '/admin/organization',
  // 639bf4a5 (r336) — '/admin/work-locations' (Physical Work Location) STOOD HERE, immediately after
  // Organization, having come from the attendance pack's settings node. rev 2 (r338) — IT IS GONE FROM
  // THIS GROUP, and the removal is DECLARED rather than the list being quietly shortened, for the same
  // reason the Notice Board note below requires a new row to be declared: this list's whole job is to
  // catch a sibling clipped by an edit, and a row that leaves has to say so.
  //
  // WHY IT LEFT. The reporter contested the r336 move after it shipped: they want the screen under
  // ATTENDANCE, renamed "Locations", with a company listing and dedicated screens. It is a child of
  // ATTENDANCE_NAV again (packs/attendance/index.ts), which also re-gates it behind the billable
  // attendance module — stated, not hidden. The ADDRESS did not move back and neither did the
  // screenKey. Pinned at its home by test/work-location-organization-relocation.test.ts and
  // test/sidebar-attendance-group.test.ts.
  '/admin/personnel',
  // 6e122302 — the Notice Board is a flat row (one screen; its new/detail pages are routes on it),
  // sitting after PAYROLL_NODE and before /analytics. Added here deliberately: this list is an EXACT
  // set whose job is to catch a sibling accidentally CLIPPED by an edit, so a genuinely new row has to
  // be declared rather than the guard being loosened.
  '/admin/notice-board',
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

  it('carries EVERY child in the declared order — no row appended, clipped or reshuffled unnoticed', () => {
    const hrefs = [...node!.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    expect(hrefs).toEqual([...SYSTEM_SETTINGS_CHILD_HREFS]);
  });

  it('4509d2b8: the Holidays row sits between Hiring Defaults and System Analysis', () => {
    // Position is the ticket's actual ask (found where a business user looks for company-wide setup), and
    // "last" is reserved for System Analysis. Asserted here as well as in the full-order case above,
    // because the full list would also be satisfied by a wholesale reordering that happens to match.
    const hiring = node!.indexOf(`'/admin/settings/hiring-defaults'`);
    const holidays = node!.indexOf(`'/admin/holidays'`);
    const explorer = node!.indexOf(`'/admin/system-explorer'`);
    expect(holidays, 'Holidays is a child of the System Settings node').toBeGreaterThan(-1);
    expect(holidays, 'after Hiring Defaults').toBeGreaterThan(hiring);
    expect(holidays, 'before System Analysis, which stays last among the setup rows').toBeLessThan(explorer);
    // e6be5a3b (r330) — the reference PAIR sits at the end, in this order, and nothing comes after it.
    // Without this the two could be reordered, or a setup row appended past them, and the full-list
    // assertion above would have to be re-read line by line to notice.
    const testing = node!.indexOf(`'/admin/system-testing'`);
    expect(testing, 'System Testing is a child of the System Settings node').toBeGreaterThan(-1);
    expect(testing, 'System Testing follows System Analysis').toBeGreaterThan(explorer);
    const allHrefs = [...node!.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    expect(allHrefs[allHrefs.length - 1], 'the reference pair ends the node').toBe('/admin/system-testing');
    expect(
      node!.split('\n').find((l) => l.includes(`'/admin/holidays'`)),
      'labelled by the existing nav key — the move creates no new string',
    ).toContain(`labelKey: 'holidays'`);
    // The row's own adminOnly flag is deliberately NOT asserted, for the reason in this file's header:
    // it is redundant under the wholesale-gated Administration group and a future cleanup may drop every
    // one of them. What actually keeps the screen administrators-only is its requireAdmin page guard and
    // its lib/permissions.ts column, both pinned in test/holidays-system-settings-relocation.test.ts.
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

  // ADR-0080 rung 3 + rung 6: the /admin/claims and /admin/leave rows moved onto their packs and
  // mount by const reference (CLAIMS_CONFIG_ROW, LEAVE_CONFIG_NODE), like the collapsible nodes — so
  // they are asserted by position here, keeping the anti-clipping guard whole. Row content parity is
  // test/claims-pack.test.ts and test/leave-pack.test.ts.
  //
  // 645e67c4 turned the leave reference from a flat row into a flyout node (LEAVE_CONFIG_ROW ->
  // LEAVE_CONFIG_NODE) WITHOUT moving it — the same rename 1459e116 made for payroll. This guard is
  // about POSITION, which is unchanged; the node's contents are test/leave-flyout-nav.test.ts.
  it('keeps the config rows in order: LEAVE_CONFIG_NODE → CLAIMS_CONFIG_ROW → PAYROLL_NODE', () => {
    const block = adminGroupBlock();
    const leaveRef = block.indexOf('LEAVE_CONFIG_NODE');
    const claimsRef = block.indexOf('CLAIMS_CONFIG_ROW');
    // ADR-0080 rung 7: the payroll entry moved onto the payroll pack and mounts by const reference,
    // like the claims/leave config rows — asserted by position here. 1459e116 turned that reference
    // from a flat row into a flyout node (PAYROLL_ROW → PAYROLL_NODE) without moving it; its
    // contents are test/payroll-flyout-nav.test.ts.
    const payroll = block.indexOf('PAYROLL_NODE');
    expect(leaveRef, 'LEAVE_CONFIG_NODE is referenced in the admin group').toBeGreaterThan(-1);
    expect(claimsRef, 'CLAIMS_CONFIG_ROW is referenced after LEAVE_CONFIG_NODE').toBeGreaterThan(leaveRef);
    expect(payroll, 'PAYROLL_NODE sits after CLAIMS_CONFIG_ROW').toBeGreaterThan(claimsRef);
  });

  it('places SYSTEM_SETTINGS_NODE immediately after the /admin/personnel row (before LEAVE_CONFIG_NODE)', () => {
    const block = adminGroupBlock();
    const personnel = block.indexOf(`'/admin/personnel'`);
    const nodeRef = block.indexOf('SYSTEM_SETTINGS_NODE');
    const leaveRef = block.indexOf('LEAVE_CONFIG_NODE');
    expect(personnel, '/admin/personnel row exists').toBeGreaterThan(-1);
    expect(nodeRef, 'SYSTEM_SETTINGS_NODE is referenced in the admin group').toBeGreaterThan(personnel);
    expect(leaveRef, 'SYSTEM_SETTINGS_NODE sits before the LEAVE_CONFIG_NODE row').toBeGreaterThan(nodeRef);
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
