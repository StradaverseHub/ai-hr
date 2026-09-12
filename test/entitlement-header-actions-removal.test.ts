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
    const children = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
    expect(children.at(-1)!.labelKey).toBe('employeeLeaveInquiry');
    expect(children.at(-1)!.href).toBe('/leave/employee-balances');
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

describe('962077a8 → 10b59703: Run Accrual is mounted exactly once, on Generate Entitlement, and in no header', () => {
  it('EarnedAccrualDialog mounts once on generate/page.tsx, between the wizard and the run log, and never on the leave type screen', () => {
    expect(generatePage.match(/<EarnedAccrualDialog/g)).toHaveLength(1);
    expect(entitlementsPage.match(/<EarnedAccrualDialog/g) ?? []).toHaveLength(0);
    const wizardAt = generatePage.indexOf('<GenerateForm');
    const accrualAt = generatePage.indexOf('<EarnedAccrualDialog');
    const runsAt = generatePage.indexOf("t('generateRunsTitle')");
    expect(wizardAt).toBeGreaterThan(-1);
    expect(accrualAt).toBeGreaterThan(wizardAt);
    expect(runsAt).toBeGreaterThan(accrualAt);
    // Same page-level data prep the leave type screen fed it — nothing moved into a client component.
    expect(generatePage).toContain('leaveYears={earnedLeaveYears}');
    expect(generatePage).toContain('companies={accrualCompanies}');
    // Not in the Generate header either: 962077a8's rule holds on the page the tool moved to.
    const generateHeader = generatePage.slice(generatePage.indexOf('<PageHeader'), generatePage.indexOf('<LeaveConfigMap'));
    expect(generateHeader).not.toContain('EarnedAccrualDialog');
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
