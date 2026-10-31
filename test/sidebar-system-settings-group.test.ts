/** Ops/Strata supersedes historical audience-position pins below; route, permission and source-inventory safeguards remain. */
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
 * 3f44a539 / 4a8a4fff additionally pin the relocated rows’ per-child admin flags: an installation
 * email operator can open this node, so inherited group gating alone would no longer preserve access.
 *
 * Deliberately NOT asserted for the original rows here:
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
import { navigationPlacement } from '../lib/navigation-workspaces';

const SIDEBAR = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
const LAYOUT = fs.readFileSync(path.resolve(__dirname, '../app/(app)/layout.tsx'), 'utf8');

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
  '/admin/settings/people-general',
  '/admin/settings/dashboard',
  '/admin/settings/system-labels',
  '/admin/system-settings/approval-delegation',
  '/admin/settings/movement',
  '/admin/settings/hiring-defaults',
  // 4509d2b8 — moved out of the Attendance settings node (packs/attendance/index.ts). It is company-wide
  // setup, not attendance config: one holiday list, read by leave, attendance and payroll alike.
  '/admin/holidays',
  // r261 (9583deac stage three) — Employee Change Requests: which fields an employee may ask to change,
  // and who approves. DECLARED here rather than tolerated, which is the whole point of asserting the
  // full list: a row spliced into the middle of this node is exactly where a neighbour gets clipped.
  '/admin/settings/profile-requests',
  '/admin/settings/login',
  '/admin/settings/email',
  '/admin/settings/email-templates',
  // 3f44a539 / 4a8a4fff — relocated existing rows; AI remains a flat Administration destination.
  '/admin/settings/notifications',
  '/admin/scheduled-actions',
  '/admin/privacy',
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
  // 3f44a539 / 4a8a4fff moved workflow email, scheduled actions and privacy into System Settings.
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
  // Prototype V3 places Personnel Management in Manage; its admin audience remains intact.
  // test/sidebar-personnel-manage.test.ts pins that row and the unchanged destination.
  // 6e122302 — the Notice Board is a flat row (one screen; its new/detail pages are routes on it),
  // sitting after PAYROLL_NODE and before /analytics. Added here deliberately: this list is an EXACT
  // set whose job is to catch a sibling accidentally CLIPPED by an edit, so a genuinely new row has to
  // be declared rather than the guard being loosened.
  '/admin/notice-board',
  '/analytics',
  '/admin/audit',
  // Security Center is now mounted from the closed SECURITY_PAGES inventory; its rendered
  // node and every authorized leaf are pinned by security-center-sidebar.dom.test.tsx.
] as const;

/** The admin group literal: from its labelKey to the end of the GROUPS array. It is the last group,
 *  so slicing to the array's closing `\n];` captures exactly its rows. */
function adminGroupBlock(): string {
  const start = SIDEBAR.indexOf(`labelKey: 'admin'`);
  expect(start, 'admin group exists in sidebar.tsx').toBeGreaterThan(-1);
  const end = SIDEBAR.indexOf('\n];', start);
  expect(end, 'GROUPS array is terminated after the admin group').toBeGreaterThan(start);
  const block = SIDEBAR.slice(start, end);
  expect(block.length, 'admin group slice is substantive').toBeGreaterThan(500);
  return block;
}

describe('sidebar System Settings group (a4e49748 consolidation)', () => {
  const node = nodeBlock(SIDEBAR, 'SYSTEM_SETTINGS_NODE');

  it('declares a SYSTEM_SETTINGS_NODE labelled with the nav.systemSettings key', () => {
    expect(node, 'SYSTEM_SETTINGS_NODE declaration exists in sidebar.tsx').not.toBeNull();
    expect(node!.length, 'System Settings slice is substantive').toBeGreaterThan(500);
    expect(node!).toMatch(/labelKey:\s*'systemSettings'/);
  });

  it('retains the original setup destinations and places employee configuration separately from shared system settings', () => {
    for (const href of TICKET_HREFS) {
      expect(node!.indexOf(`'${href}'`), `${href} retains its authorized source descriptor`).toBeGreaterThan(-1);
    }
    expect(navigationPlacement('/admin/settings/employee-id')).toEqual({area:'ops',module:'people',section:'config'});
    expect(navigationPlacement('/admin/settings/dashboard')).toEqual({area:'system'});
    expect(navigationPlacement('/admin/settings/system-labels')).toEqual({area:'system'});
  });

  it('carries EVERY child in the declared order — no row appended, clipped or reshuffled unnoticed', () => {
    const hrefs = [...node!.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    expect(hrefs).toEqual([...SYSTEM_SETTINGS_CHILD_HREFS]);
  });

  it('keeps Email templates adjacent to delivery and restricted to administrators', () => {
    expect(node!).toContain("{ href: '/admin/settings/email-templates', labelKey: 'emailTemplates', icon: Mail, adminOnly: true }");
    expect(countQuoted(SIDEBAR, '/admin/settings/email-templates')).toBe(1);
    expect(navigationPlacement('/admin/settings/email-templates')).toEqual({area:'system'});
  });

  it('relocates the exact three entries once, preserving keys, icons and the inherited admin audience', () => {
    const rows = [
      ['/admin/settings/notifications', 'workflowEmail', 'Bell'],
      ['/admin/scheduled-actions', 'scheduledActions', 'Timer'],
      ['/admin/privacy', 'dataPrivacy', 'Lock'],
    ] as const;
    for (const [href, labelKey, icon] of rows) {
      expect(node!).toContain(`{ href: '${href}', labelKey: '${labelKey}', icon: ${icon}, adminOnly: true }`);
      expect([...SIDEBAR.matchAll(/\{ href: '([^']+)'/g)].filter(match => match[1] === href)).toHaveLength(1);
      expect(adminGroupBlock()).not.toContain(`href: '${href}'`);
    }
    expect(adminGroupBlock()).not.toContain("href: '/admin/ai'");
    expect(node!).not.toContain("href: '/admin/ai'");
    expect(SIDEBAR).toContain("['/admin/settings/notifications','notifications'] as const");
    const source = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    expect(source('app/(app)/admin/settings/notifications/page.tsx')).toContain("await scopedAdmin();await requireModule('notifications')");
    expect(source('app/(app)/admin/scheduled-actions/page.tsx')).toContain("if (!isGroupAdmin(s)) redirect('/')");
    expect(source('app/(app)/admin/privacy/page.tsx')).toContain('await requireAdmin()');
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
  it('keeps each original config owner while placing module setup in its own Configuration section', () => {
    const block = adminGroupBlock();
    for (const name of ['LEAVE_CONFIG_NODE','CLAIMS_CONFIG_ROW','PAYROLL_NODE','SYSTEM_SETTINGS_NODE']) {
      expect(block.split('\n').some(line=>line.trim()===`${name},`), `${name}: no legacy authorized source owner lost`).toBe(true);
    }
    expect(navigationPlacement('/admin/leave-config/types')).toEqual({area:'ops',module:'leave',section:'config'});
    expect(navigationPlacement('/admin/claims')).toEqual({area:'ops',module:'claims',section:'config'});
    expect(navigationPlacement('/payroll/setup')).toEqual({area:'ops',module:'payroll',section:'config'});
  });

  it('separates People configuration and daily HR work from the shared System Configuration gear', () => {
    expect(navigationPlacement('/admin/organization')).toEqual({area:'ops',module:'people',section:'config'});
    expect(navigationPlacement('/admin/personnel')).toEqual({area:'ops',module:'people',section:'hr'});
    for (const href of ['/admin/holidays','/admin/settings/system-labels','/admin/settings/email','/admin/ai']) {
      expect(navigationPlacement(href), href).toEqual({area:'system'});
    }
  });

  // fdc20776 (flyout redesign) removed per-group open/closed persistence entirely: panels are
  // show-on-demand, so there are no cookieKeys in sidebar.tsx and no nav_*_open SSR cookie reads
  // in app/(app)/layout.tsx any more. The former cookieKey↔layout-read invariant is therefore obsolete;
  // this guard keeps the machinery from silently coming back half-wired (a reintroduced cookieKey
  // with no SSR read was the original always-closed bug).
  it('per-group nav cookies stay fully removed (no cookieKey without an SSR read coming back)', () => {
    const keys = [...SIDEBAR.matchAll(/cookieKey: '([^']+)'/g)].map((m) => m[1]);
    for (const key of keys) {
      expect(
        LAYOUT.includes(`cookieStore.get('${key}')`),
        `app/(app)/layout.tsx SSR-reads the '${key}' cookie`,
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
