/**
 * 645e67c4 — Leave config moves from a horizontal tab strip to the sidebar fly-out.
 *
 * The reporter asked for Replacement Leave "under Leave Configuration… the same navigation style as
 * Leave Type / Leave Adjustments / Generate Entitlement", and then contested `491c499f` in the same
 * words: "move this leave adjustment in the Leave Config left-hand menu from a single line into an
 * expandable group, the same way Payroll and Attendance already work". ONE build answers both.
 *
 * The direct analogue of test/payroll-flyout-nav.test.ts, which guards 1459e116's identical conversion.
 * Three properties are worth a regression guard, and they are the three ways this change could quietly
 * hurt someone:
 *
 *   1. NO BROKEN BOOKMARKS. The node's hrefs must be the retired strip's, character for character.
 *      A renamed route would 404 for anyone who saved a leave-config link.
 *   2. NO DEAD ENTRIES. Every href must resolve to a real route file, and must be registered on the
 *      leaveConfig screen in lib/permissions.ts — a menu row whose route is unregistered is either
 *      invisible or refused by our own access check (the trap 4b0e76ae's tab hit).
 *   3. THE STRIP IS ACTUALLY GONE. Leaving it behind would give leave two navigations at once, which
 *      is worse than the crowding being fixed.
 *
 * The pack node is imported for real; the sidebar half is a source-text check, the house idiom for
 * `'use client'` module-private structure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leavePack } from '../packs/leave';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
/**
 * Comments are not code. The sidebar legitimately NAMES the retired `LEAVE_CONFIG_ROW` in its
 * provenance comment, and r134 established the rule the hard way: a guard that reports correct code as
 * wrong is worse than no guard. Strip commentary before asserting on structure, so the history can stay
 * written down.
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const NODE = leavePack.navNodes!.find((n) => n.group === 'admin')!;

/**
 * The retired components/leave-tabs.tsx destinations, captured VERBATIM from the commit before this
 * change, IN THE STRIP'S OWN ORDER. hrefs are the strip's; only the labelKey namespace moved
 * (admin.leaveTabs → nav). This is the SET AND SEQUENCE the fly-out must carry — no destination lost,
 * no href renamed, no re-sorting.
 *
 * EIGHT, not the six an earlier revision of the plan described: `491c499f` added Leave Adjustments and
 * `4b0e76ae` added Generate Entitlement while this item waited. Listed explicitly rather than asserted
 * as a subset, because a set guard that only checks "contains" stops noticing a deletion.
 */
const RETIRED_STRIP: readonly { href: string; labelKey: string }[] = [
  // df00b85f — `{ '/admin/leave', 'leaveSummary' }` STOOD HERE and is DELIBERATELY GONE, not lost.
  //
  // This list is an exact-set guard, so it fails on a clipped sibling; the only correct way to retire a
  // destination is to delete its line here in the same commit that deletes the row, which is what this is.
  // The two properties the removal has to keep are asserted below by their own tests rather than by this
  // list: the ROUTE still resolves (as a redirect stub, so no bookmark 404s) and Entitlements is now first.
  { href: '/admin/leave/entitlements', labelKey: 'leaveEntitlements' },
  { href: '/admin/leave/adjustments', labelKey: 'leaveAdjustments' },
  { href: '/admin/leave/generate', labelKey: 'leaveGenerate' },
  { href: '/admin/leave/approval', labelKey: 'leaveApprovalWorkflow' },
  { href: '/admin/leave/payroll', labelKey: 'leavePayroll' },
  { href: '/admin/leave/replacement', labelKey: 'leaveReplacement' },
  // f1b994e3 — `{ '/admin/leave/audit', 'leaveAudit' }` STOOD HERE and is DELIBERATELY GONE, not lost,
  // for the reason the df00b85f note above states: this list is an exact-set guard, so the ONLY correct
  // way to retire a destination is to delete its line here in the same commit that deletes the row. The
  // two properties the removal has to keep have their own tests below: the ROUTE still resolves (as a
  // redirect stub carrying ?module=leave, so no bookmark 404s) and the label key is pruned rather than
  // left as an untranslatable orphan.
] as const;

/** href → the route file that must exist for it to be a live destination. */
const routeFile = (href: string) => `app${href}/page.tsx`;

describe('645e67c4 — Leave config is a sidebar fly-out, not a tab strip', () => {
  it('carries every retired tab destination, same hrefs, same order — no broken bookmarks', () => {
    expect(NODE.children.map((c) => ({ href: c.href, labelKey: c.labelKey }))).toEqual(RETIRED_STRIP);
    expect(NODE.labelKey).toBe('leaveConfig');
    expect(NODE.group).toBe('admin');
  });

  it('every destination is a real page AND registered on the leaveConfig screen — no dead entries', () => {
    const permissions = read('lib/permissions.ts');
    for (const child of NODE.children) {
      expect(exists(routeFile(child.href)), `${child.href} has no route file`).toBe(true);
      // A row whose route is unregistered is invisible or refused by our own access check.
      expect(permissions, `${child.href} is not registered in lib/permissions.ts`).toContain(`'${child.href}'`);
    }
  });

  /**
   * df00b85f — the Summary entry is retired and Entitlements leads the menu.
   *
   * The listing it opened (code / name / description / paid / status, an Edit link INTO Entitlements, a
   * delete) is rendered in full by the Entitlements per-type panel, so the row was a second door onto one
   * screen's settings. Three things make the removal safe rather than merely tidy, and each is pinned:
   * the route still resolves so no saved link 404s; the stub carries NO page guard, which is what lets
   * `/admin/leave` leave lib/permissions.ts without test/function-access.test.ts reddening in either
   * direction; and the label key retires WITH the row instead of lingering as an untranslatable orphan.
   */
  it('the Summary row is gone and Entitlements is first', () => {
    expect(NODE.children.map((c) => c.href)).not.toContain('/admin/leave');
    expect(NODE.children[0].href).toBe('/admin/leave/entitlements');
    expect(read('packs/leave/index.ts')).not.toContain("labelKey: 'leaveSummary'");
  });

  it('/admin/leave survives as an UNGUARDED redirect stub — bookmarks land, the grid stays honest', () => {
    const stub = read('app/admin/leave/page.tsx');
    expect(stub, 'the route file must still exist').toContain("redirect(");
    expect(stub).toContain('/admin/leave/entitlements');
    // A stub is not a guarded page. If it ever calls one of these, test/function-access.test.ts's
    // reverse-completeness check fails — because the route is (correctly) no longer registered.
    expect(stub).not.toMatch(/requireAdmin|scopedAdmin|scopedSession|requirePayrollAccess/);
    const permissions = read('lib/permissions.ts');
    expect(permissions).not.toContain("'/admin/leave',");
    // The screen column survives, re-pointed at the page a reader can actually open.
    expect(permissions).toContain("href: '/admin/leave/entitlements'");
  });

  /**
   * f1b994e3 — the Audit row is retired into the ONE central Audit Trail (/admin/audit), which gained an
   * Area filter plus every filter the leave page had. The three things that make that removal safe rather
   * than merely tidy are each pinned here: the route still resolves so no saved link 404s and it lands
   * with Leave already chosen; the stub carries NO page guard, which is what lets `/admin/leave/audit`
   * leave lib/permissions.ts without test/function-access.test.ts reddening in either direction; and the
   * label key retires WITH the row instead of lingering as an orphan.
   */
  it('the Audit row is gone and Replacement is last', () => {
    expect(NODE.children.map((c) => c.href)).not.toContain('/admin/leave/audit');
    expect(NODE.children.at(-1)!.href).toBe('/admin/leave/replacement');
    expect(read('packs/leave/index.ts')).not.toContain("labelKey: 'leaveAudit'");
  });

  it('/admin/leave/audit survives as an UNGUARDED redirect stub to the central Audit Trail', () => {
    const stub = read('app/admin/leave/audit/page.tsx');
    expect(stub, 'the route file must still exist').toContain('redirect(');
    // The destination is the one audit page, with the Leave area already chosen — a bookmark opens the
    // same view it always did, not an unfiltered firehose.
    expect(stub).toContain('/admin/audit');
    expect(stub).toContain("usp.set('module', 'leave')");
    expect(stub).not.toMatch(/requireAdmin|scopedAdmin|scopedSession|requirePayrollAccess/);
    // A stub is not a guarded page, so the route MUST have left the permission grid in the same change.
    const permissions = read('lib/permissions.ts');
    expect(permissions).not.toContain("'/admin/leave/audit',");
    // The export route retires the same way, so an old download link still returns a file.
    const exportStub = read('app/admin/leave/audit/export/route.ts');
    expect(exportStub).toContain('redirect(');
    expect(exportStub).toContain('/admin/audit/export');
    expect(exportStub).toContain("out.set('module', 'leave')");
  });

  it('nav.leaveAudit is pruned in all six catalogues — no orphan label', () => {
    // Grepped first, the r137 way: `nav.leaveAudit` had exactly ONE reader, the row deleted above, and
    // no computed `nav.${x}` form can reach it now that no descriptor names it.
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      expect(dict.nav.leaveAudit, `${loc}: nav.leaveAudit must be pruned`).toBeUndefined();
    }
  });

  /**
   * This assertion ABSORBS test/leave-summary-tab-rename.test.ts, which df00b85f deleted. That file
   * guarded the "Leave Types" → "Summary" rename of this row's label in six locales; the row is gone, so
   * the rename has no subject, and the only thing left worth pinning about that key is that it went away
   * cleanly. It lives here because this file owns the menu.
   */
  it("nav.leaveSummary is pruned in all six catalogues, and people.detail.leaveSummary is NOT", () => {
    // r137 deleted three shared labels by prefix and broke a surviving consumer. The key removed here was
    // grepped first: `nav.leaveSummary` had exactly ONE reader, the row above. The identically-named key
    // under people.detail is a DIFFERENT label (the personnel profile's leave summary card) and must live.
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      expect(dict.nav.leaveSummary, `${loc}: nav.leaveSummary must be pruned`).toBeUndefined();
      expect(dict.people.detail.leaveSummary, `${loc}: people.detail.leaveSummary must survive`).toBeTruthy();
    }
  });

  it('the tab strip is gone and nothing still renders it — one way in, not two', () => {
    expect(exists('components/leave-tabs.tsx'), 'components/leave-tabs.tsx must be deleted').toBe(false);
    // Any surviving import would be a build error, but a surviving RENDER in a comment or a stale
    // string would mislead the next author, so scan the leave admin surface for the symbol at all.
    const dir = path.join(ROOT, 'app', 'admin', 'leave');
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(d, e.name);
        return e.isDirectory() ? walk(full) : /\.tsx?$/.test(e.name) ? [full] : [];
      });
    for (const file of walk(dir)) {
      expect(fs.readFileSync(file, 'utf8'), `${path.relative(ROOT, file)} still names LeaveTabs`).not.toContain('LeaveTabs');
    }
  });

  it('the sidebar mounts it as a collapsible node, in its unchanged Admin-group position', () => {
    const sidebar = stripComments(read('components/sidebar.tsx'));
    expect(sidebar).toContain('LEAVE_CONFIG_NODE');
    expect(sidebar, 'the old flat row must be gone, not merely unused').not.toContain('LEAVE_CONFIG_ROW');
    // a324a4b3 rev3 put Attendance literally between Leave config and Claims config on the reporter's
    // instruction. Assert the order survives the conversion rather than trusting it did.
    const order = ['SYSTEM_SETTINGS_NODE', 'LEAVE_CONFIG_NODE', 'ATTENDANCE_NODE', 'CLAIMS_CONFIG_ROW', 'PAYROLL_NODE'];
    const positions = order.map((k) => sidebar.lastIndexOf(k));
    expect(positions.every((p) => p > 0), 'every admin-group anchor must still be mounted').toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('every child label resolves in all six catalogs, and admin.leaveTabs is retired', () => {
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      for (const child of NODE.children) {
        const label = dict.nav?.[child.labelKey];
        expect(typeof label, `${loc}: nav.${child.labelKey}`).toBe('string');
        expect(String(label).trim().length, `${loc}: nav.${child.labelKey} is empty`).toBeGreaterThan(0);
      }
      // The labels MOVED; a leftover admin.leaveTabs would be a second copy free to drift.
      expect(dict.admin?.leaveTabs, `${loc}: admin.leaveTabs must be gone, not duplicated`).toBeUndefined();
    }
  });

  it('the menu does NOT hijack nav.leaveApproval, which labels a different screen', () => {
    // nav.leaveApproval is read by lib/permissions.ts for the separate `leaveApproval` SCREEN. Pointing
    // this menu child at it renames that screen silently — the exact bug the render check caught here.
    const permissions = read('lib/permissions.ts');
    expect(permissions).toContain("labelKey: 'nav.leaveApproval'");
    for (const loc of LOCALES) {
      const nav = JSON.parse(read(`messages/${loc}.json`)).nav;
      expect(nav.leaveApproval, `${loc}: the screen label must survive`).toBeTruthy();
      expect(nav.leaveApprovalWorkflow, `${loc}: the menu label must be its own key`).toBeTruthy();
      expect(nav.leaveApproval, `${loc}: the two must stay distinct`).not.toBe(nav.leaveApprovalWorkflow);
    }
  });

  it('the leave pack keeps its self-service row, which is not part of this move', () => {
    // /leave is the employee's own My Absence home. Folding it into the admin node would put a
    // self-service page behind the Administration group's adminOnly gate.
    const main = leavePack.navLinks!.filter((l) => l.group === 'main');
    expect(main.map((l) => l.href)).toEqual(['/leave']);
    expect(leavePack.navLinks!.some((l) => l.group === 'admin'), 'the flat admin row is replaced by the node').toBe(false);
  });
});
