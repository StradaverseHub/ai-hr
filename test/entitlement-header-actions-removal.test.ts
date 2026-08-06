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

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const entitlementsPage = read('/app/admin/leave/entitlements/page.tsx');

// The header cluster: from <PageHeader to the next sibling (<LeaveTabs).
const header = entitlementsPage.slice(entitlementsPage.indexOf('<PageHeader'), entitlementsPage.indexOf('<LeaveTabs'));

describe('962077a8: the PageHeader keeps only the + Import action', () => {
  it('the actions slot renders the importer link and nothing else opens from the header', () => {
    expect(header).toMatch(/actions=\{/);
    expect(header).toMatch(/<Link href="\/admin\/leave\/import" className=\{btnPrimary\}>/);
    expect(header).toMatch(/\{t\('importAction'\)\}/);
    // The two removed triggers are gone from the header cluster…
    expect(header.includes('<EarnedAccrualDialog')).toBe(false);
    expect(header.includes('<LeaveRulePreviewDialog')).toBe(false);
    // …and no header wrapper survives for a single action (the lone Link IS the slot content).
    expect(header.includes('flex flex-wrap items-center gap-2')).toBe(false);
  });

  it('exactly one importer link remains page-wide (the header action; e8f2398f guard still holds)', () => {
    expect(entitlementsPage.match(/href="\/admin\/leave\/import"/g)).toHaveLength(1);
  });
});

describe('962077a8: both tools stay reachable from their sub-step homes (7b945408 slots)', () => {
  it('Run Accrual: EarnedAccrualDialog mounts exactly once — inside the accrualSection slot (Adjustments)', () => {
    expect(entitlementsPage.match(/<EarnedAccrualDialog/g)).toHaveLength(1);
    const slot = entitlementsPage.slice(entitlementsPage.indexOf('const accrualSection = ('), entitlementsPage.indexOf('return ('));
    expect(slot).toContain('<EarnedAccrualDialog');
    // Same page-level data prep as the header button fed — nothing moved into a client component.
    expect(slot).toContain('leaveYears={earnedLeaveYears}');
    expect(entitlementsPage).toContain('accrualSection={accrualSection}');
  });

  // 6e9a126e RELEASE THREE — LeaveRulePreviewDialog and components/leave-rule-preview.tsx are DELETED.
  // The checker resolved days through leave_policy rows; with that layer gone it could only have answered
  // '—' to every question while still looking live.

  // 6e9a126e RELEASE THREE — previewScenarioAction labelled the deleted dialog's trigger and was retired
  // from all six catalogs with it. A live key for a button that cannot render is the orphan the i18n
  // ratchet exists to prevent.
});
