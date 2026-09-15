/**
 * Remove Unnecessary Action Buttons from Leave Configuration Header (R64 · feedback 962077a8).
 *
 * The Entitlements page header carried three buttons: + Import, Run Accrual and Preview Scenario
 * (d778d2d3's cluster). With 7b945408's Entitlement-step homes in place — Run Accrual inside the
 * Adjustments sub-step, Preview Scenario inside Service Based Entitlements — the two occasional-use
 * tools left the header. + Import stays as the single page-level action. Pure removal: the dialogs,
 * their wrapped tools and the page-level data prep are untouched; each dialog simply has ONE mount now
 * (its sub-step slot) instead of two. Sequenced strictly after 7b945408 so nothing is ever unreachable.
 *
 * DB-free source guard (the suite has no DOM runner): composition asserted statically, the repo
 * convention (see entitlement-standalone-sections-removal.test.ts, leave-entitlement-substeps.test.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leavePack } from '../packs/leave';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const entitlementsPage = read('/app/admin/leave-config/types/page.tsx');
const generatePage = read('/app/admin/leave-config/generate/page.tsx');
/** r281 (09386e29) — the page Run earned accrual moved to when it stopped being a section of Generate. */
const accrualPage = read('/app/admin/leave-config/earned-accrual/page.tsx');

/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. The leave TYPE screen is
 * `/admin/leave-config/types` and `<LeaveTabs>` (the retired horizontal strip) is not on it, so the
 * header cluster is sliced to the tab row that follows the header instead.
 *
 * 10b59703 (r266) — UPDATED, NOT LOOSENED. 962077a8's property was "ONE action in the header, and the
 * tools reachable only from their own sections". The one action is no longer + Import: the reporter's
 * instruction that the submenu IS the navigation moved Import under Leave Adjustments (it loads balance
 * movements) and the three Entitlements links into this page's own tab row, so the header keeps only the
 * ONE link that leaves Leave Config — r242's Employee Balances (F47). Run Accrual moved to Generate
 * Entitlement, still mounted exactly once, still not in any header.
 *
 * 5ca446db (r269) — UPDATED AGAIN, IN THE SAME DIRECTION 962077a8 was always pushing: the header now has
 * NO actions slot at all. The last survivor, r242's Employee Balances link, became the Leave Config
 * fly-out's sixth row ("Employee Leave Inquiry", packs/leave/index.ts), which is where the reporter twice
 * asked for it. F47's property is not dropped — it is carried by a row on every Leave Config screen instead
 * of a link on this one — so the assertion below pins BOTH halves: the header is empty AND the row exists.
 * Asserting only the emptiness would go green on a page that simply lost its way in.
 */
const header = entitlementsPage.slice(
  entitlementsPage.indexOf('<PageHeader'),
  entitlementsPage.indexOf('<LeaveConfigMap'),
);

describe('962077a8 → 5ca446db: the PageHeader carries no actions at all, and the way in is a submenu row', () => {
  it('the actions slot is absent and the page carries no link to /leave/employee-balances', () => {
    expect(header, 'the actions slot is gone, not emptied').not.toMatch(/actions=\{/);
    expect(header).not.toContain('href="/leave/employee-balances"');
    expect(header).not.toMatch(/\{t\('employeeBalancesAction'\)\}/);
    // The whole page, not just the header cluster: one link moved to the bottom would be the same defect.
    expect(entitlementsPage).not.toContain('href="/leave/employee-balances"');
    expect(entitlementsPage).not.toContain('employeeBalancesAction');
    // THE REPLACEMENT, so this case cannot pass on a page that lost the way in with nothing put in its
    // place. The row's own shape is pinned in test/leave-flyout-nav.test.ts and test/r269-*.
    // r281 (a73d1e14) — UPDATED, NOT LOOSENED. The row was resolved as `children.at(-1)`, which was a
    // spelling of "the way in exists" that happened to work while it was the last child; an unrelated
    // item appended Special Setting below it, where the reporter drew it. The row is resolved BY NAME
    // here and its POSITION is pinned where positions belong — test/leave-flyout-nav.test.ts, which owns
    // the fly-out's exact order. What this case is about is that the link's replacement exists at all.
    const children = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
    const inquiry = children.find((c) => c.labelKey === 'employeeLeaveInquiry');
    expect(inquiry, 'the row that replaced the header link is gone').toBeTruthy();
    expect(inquiry!.href).toBe('/leave/employee-balances');
    // The importer button and the three tab links are gone from the header cluster…
    expect(header).not.toContain("leaveConfigScreenHref('importLeaveData')");
    expect(header).not.toContain("leaveConfigScreenHref('entitlementTables')");
    expect(header).not.toContain("leaveConfigScreenHref('entitlementArchive')");
    expect(header).not.toContain("leaveConfigScreenHref('ledgerArchive')");
    expect(header).not.toContain('importAction');
    // …so are the two triggers 962077a8 removed…
    expect(header.includes('<EarnedAccrualDialog')).toBe(false);
    expect(header.includes('<LeaveRulePreviewDialog')).toBe(false);
    // …and no header wrapper survives for a single action (the lone Link IS the slot content).
    expect(header.includes('flex flex-wrap items-center gap-2')).toBe(false);
    expect(header.includes('flex items-center gap-3')).toBe(false);
  });

  it('the page carries ZERO importer links; the one way into the importer is the Leave Adjustments tab', () => {
    expect(entitlementsPage.match(/href=\{leaveConfigScreenHref\('importLeaveData'\)\}/g) ?? []).toHaveLength(0);
    // …and never as a literal, which would be a second answer the menu could drift from.
    expect(entitlementsPage.match(/href="\/admin\/leave(-config)?\/import"/g) ?? []).toHaveLength(0);
    // The one entry in the module: the third tab of the Leave Adjustments row.
    const map = read('/components/leave-config-map.tsx');
    expect(map.match(/id: 'importLeaveData', href: '\/admin\/leave-config\/import'/g)).toHaveLength(1);
  });
});

describe('962077a8 → 10b59703 → r281: Run Accrual is mounted exactly once, on its own screen, and in no header', () => {
  it('EarnedAccrualDialog mounts once on earned-accrual/page.tsx, and on neither screen it has left', () => {
    // r281 (09386e29) — UPDATED, NOT LOOSENED. 962077a8's rule is "mounted exactly once, and never in a
    // PageHeader actions cluster", and that is what is still asserted. What moved is the one screen. r266
    // put the tool on Generate Entitlement, between the wizard and the run log; that page CREATES a leave
    // year's entitlement while this tool posts only what was already earned, so filing the second inside
    // the first put an operator one scroll from the operation it must never be confused with. The
    // ORDERING assertion (wizard → accrual → run log) retires with the arrangement it described: there is
    // nothing left to order on that page, and what replaced it is the stronger claim that the mount is
    // gone from it entirely.
    expect(accrualPage.match(/<EarnedAccrualDialog/g)).toHaveLength(1);
    expect(generatePage.match(/<EarnedAccrualDialog/g) ?? []).toHaveLength(0);
    expect(entitlementsPage.match(/<EarnedAccrualDialog/g) ?? []).toHaveLength(0);
    // Same page-level data prep both earlier screens fed it — nothing moved into a client component.
    expect(accrualPage).toContain('leaveYears={earnedLeaveYears}');
    expect(accrualPage).toContain('companies={accrualCompanies}');
    // Not in a header either: 962077a8's rule holds on the page the tool moved to.
    const accrualHeader = accrualPage.slice(accrualPage.indexOf('<PageHeader'), accrualPage.indexOf('<LeaveConfigMap'));
    expect(accrualHeader).not.toContain('EarnedAccrualDialog');
    // Generate Entitlement keeps the wizard and the run log, in that order, with nothing between them.
    const wizardAt = generatePage.indexOf('<GenerateForm');
    const runsAt = generatePage.indexOf("t('generateRunsTitle')");
    expect(wizardAt).toBeGreaterThan(-1);
    expect(runsAt).toBeGreaterThan(wizardAt);
    // The tab it left keeps the pointer where the button was.
    expect(entitlementsPage).toContain('accrualPointer={accrualPointer}');
  });

  // 6e9a126e RELEASE THREE — LeaveRulePreviewDialog and components/leave-rule-preview.tsx are DELETED.
  // The checker resolved days through leave_policy rows; with that layer gone it could only have answered
  // '—' to every question while still looking live.

  // 6e9a126e RELEASE THREE — previewScenarioAction labelled the deleted dialog's trigger and was retired
  // from all six catalogs with it. A live key for a button that cannot render is the orphan the i18n
  // ratchet exists to prevent.
});
