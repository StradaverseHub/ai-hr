/**
 * Remove Standalone Sections from Leave Configuration Entitlement Page (R61 · feedback d778d2d3).
 *
 * The Entitlements tab used to carry three standalone sections below the leave-type workspace:
 *   1. Run Earned Accrual (EarnedAccrualCard — scope selectors, dry-run preview, confirm),
 *   2. Leave Cycle (per-company calendar-vs-anniversary forms posting setCompanyLeaveCycleAction),
 *   3. Preview a Scenario (LeaveRulePreview — the live entitlement-rule checker).
 * Each keeps its FUNCTION but loses its section:
 *   - Run Earned Accrual → a compact "Run Accrual" button opening the SAME EarnedAccrualCard in a wide
 *     dialog (components/leave/earned-accrual-dialog.tsx),
 *   - Preview a Scenario → a "Preview Scenario" button, same pattern
 *     (components/leave/leave-rule-preview-dialog.tsx),
 *   - Leave Cycle → a Card on the Application Rules tab beside the Leave Year settings (both are
 *     company-level calendar rules); setCompanyLeaveCycleAction is unchanged, only rendering moved,
 *     and the action now redirects back to the Application Rules route (the R45 cc816207 precedent).
 * No data, accrual behaviour or cycle semantics change — the wrapped components are byte-identical
 * tools in new frames.
 *
 * 1e4eb8af (Restructure Leave Year Configuration): the Application Rules tab is RETIRED, and with it the
 * per-company Leave Cycle card — it was a second place to decide what each leave type's Leave Year Type
 * override already decides (Custom Settings → Leave Year Configuration, whose a2a / a2c / c2c choices
 * cover every shape the company card offered). So the d778d2d3 relocation assertions below invert: the
 * card, its action and its strings must be gone from BOTH pages, and the route must be a redirect stub.
 * The two dialog relocations above are untouched. core/admin.setCompanyLeaveCycle is deliberately still
 * there — it is the write path stored cycles came from, and the DB tests exercise it directly.
 *
 * R64 962077a8 (after 7b945408): the two dialog buttons left the PageHeader again — they now open ONLY
 * from the Entitlement step's sub-steps (Run Accrual in Adjustments, Preview Scenario in Service Based
 * Entitlements). The header keeps just + Import. The dialogs, their wrapped tools and the page-level
 * data prep pinned below are all unchanged — only the mount moved.
 *
 * DB-free source guard (the suite has no DOM runner): the RSC pages can't be rendered here, so we
 * assert the composition + wiring + i18n statically. Portal caveat note: neither wrapped component
 * submits a <form> (EarnedAccrualCard calls its server actions directly via useTransition;
 * LeaveRulePreview is pure local state), so the ConfirmSubmit requestSubmit-inside-Radix-portal
 * caveat does not apply — asserted below by pinning both components form-free.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const entitlementsPage = read('/app/admin/leave/entitlements/page.tsx');
// 1e4eb8af — the route is a redirect stub now, kept only so old bookmarks resolve.
const applicationRulesStub = read('/app/admin/leave/application-rules/page.tsx');
const accrualDialog = read('/components/leave/earned-accrual-dialog.tsx');
const previewDialog = read('/components/leave/leave-rule-preview-dialog.tsx');
const accrualCard = read('/components/earned-accrual-card.tsx');
const previewComponent = read('/components/leave-rule-preview.tsx');
const actions = read('/app/admin/actions.ts');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

describe('d778d2d3: the three standalone sections are gone from the Entitlements page', () => {
  it('no longer renders the Run Earned Accrual section (card import + section heading)', () => {
    expect(entitlementsPage.includes("from '@/components/earned-accrual-card'")).toBe(false);
    expect(entitlementsPage.includes('<EarnedAccrualCard')).toBe(false);
    expect(entitlementsPage).not.toMatch(/SectionHeader title=\{t\('runEarnedAccrual'\)\}/);
  });

  it('no longer renders the Leave Cycle section (heading, help, per-company cycle forms)', () => {
    expect(entitlementsPage.includes('leaveCycleTitle')).toBe(false);
    expect(entitlementsPage.includes('leaveCycleHelp')).toBe(false);
    expect(entitlementsPage.includes('setCompanyLeaveCycleAction')).toBe(false);
    expect(entitlementsPage.includes('cycleCalendar')).toBe(false);
  });

  it('no longer renders the Preview a Scenario section (direct component render + heading)', () => {
    expect(entitlementsPage.includes("from '@/components/leave-rule-preview'")).toBe(false);
    expect(entitlementsPage.includes('<LeaveRulePreview ')).toBe(false);
    expect(entitlementsPage).not.toMatch(/SectionHeader title=\{t\('previewTitle'\)\}/);
  });

  it('keeps the leave-type workspace — the slimmed page body', () => {
    expect(entitlementsPage).toMatch(/<LeaveTypeWorkspace/);
    expect(entitlementsPage).toMatch(/<LeaveTypePanel/);
    // b1b81a08: the Grades catalog is no longer part of this page body at all — grade master data moved to
    // Settings → System Labels → Organisation Labels.
    expect(entitlementsPage).not.toMatch(/<GradeCatalog/);
  });
});

describe('d778d2d3 → 962077a8: the two tools are dialog buttons — mounted in the sub-steps, not the header', () => {
  // The whole actions cluster: from actions={ to the closing of the PageHeader element.
  const headerStart = entitlementsPage.indexOf('<PageHeader');
  const headerEnd = entitlementsPage.indexOf('<LeaveTabs');
  const header = entitlementsPage.slice(headerStart, headerEnd);

  it('the PageHeader actions slot carries ONLY the + Import link (962077a8)', () => {
    expect(header).toMatch(/actions=\{/);
    expect(header).toMatch(/<Link href="\/admin\/leave\/import" className=\{btnPrimary\}>/);
    expect(header.includes('<EarnedAccrualDialog')).toBe(false);
    expect(header.includes('<LeaveRulePreviewDialog')).toBe(false);
  });

  it('both dialogs stay mounted — once each, inside the Entitlement-step tool slots (never unreachable)', () => {
    // leave-entitlement-substeps.test.ts pins WHERE the slots render (Adjustments / Service Based
    // Entitlements); this guard pins that removing the header buttons left exactly one mount each.
    expect(entitlementsPage.match(/<EarnedAccrualDialog/g)).toHaveLength(1);
    expect(entitlementsPage.match(/<LeaveRulePreviewDialog/g)).toHaveLength(1);
  });

  it('still prepares the tools’ data at page level (leave-year options, preview policies)', () => {
    // The dialog path reuses the page-level prep — listLeaveYearConfigs feeds the accrual Leave-Year
    // selector; the ACTIVE-policy filter feeds the preview. Neither moved into a client component.
    expect(entitlementsPage).toMatch(/listLeaveYearConfigs\(s\)/);
    expect(entitlementsPage).toMatch(/earnedLeaveYears/);
    expect(entitlementsPage).toMatch(/const previewPolicies = policies\s*\n?\s*\.filter\(\(p\) => !p\.validTo\)/);
  });
});

describe('d778d2d3: the dialogs wrap the UNCHANGED tools', () => {
  it('EarnedAccrualDialog wraps EarnedAccrualCard in a wide Radix dialog titled runEarnedAccrual', () => {
    expect(accrualDialog).toMatch(/@radix-ui\/react-dialog/);
    expect(accrualDialog).toMatch(/EarnedAccrualCard,/);
    expect(accrualDialog).toMatch(/<EarnedAccrualCard/);
    expect(accrualDialog).toMatch(/Dialog\.Title[^>]*>\{t\('runEarnedAccrual'\)\}/);
    // The dry-run table sets min-w-[720px]; the dialog must be WIDE so the numbers show unclipped.
    expect(accrualDialog).toMatch(/max-w-4xl/);
    // Trigger label = the compact header-button key; the trigger must never submit an enclosing form.
    expect(accrualDialog).toMatch(/\{t\('runAccrualAction'\)\}/);
    expect(accrualDialog).toMatch(/Dialog\.Trigger asChild>\s*<Button type="button"/);
  });

  it('LeaveRulePreviewDialog wraps LeaveRulePreview in a Radix dialog titled previewTitle', () => {
    expect(previewDialog).toMatch(/@radix-ui\/react-dialog/);
    expect(previewDialog).toMatch(/LeaveRulePreview,/);
    expect(previewDialog).toMatch(/<LeaveRulePreview/);
    expect(previewDialog).toMatch(/Dialog\.Title[^>]*>\{t\('previewTitle'\)\}/);
    expect(previewDialog).toMatch(/\{t\('previewScenarioAction'\)\}/);
    expect(previewDialog).toMatch(/Dialog\.Trigger asChild>\s*<Button type="button"/);
  });

  it('both wrapped tools stay form-free, so posting from inside the portal cannot break (requestSubmit caveat)', () => {
    // EarnedAccrualCard invokes its server actions directly (useTransition), never via <form action=…>;
    // LeaveRulePreview is read-only local state. If either ever grows a <form>, the dialog mount must be
    // revisited per the ConfirmSubmit portal-caveat convention — this assertion is the tripwire.
    expect(accrualCard.includes('<form')).toBe(false);
    expect(accrualCard).toMatch(/previewEarnedAccrualAction\(scope\)/);
    expect(accrualCard).toMatch(/runEarnedAccrualAction\(scope\)/);
    expect(previewComponent.includes('<form')).toBe(false);
  });
});

describe('1e4eb8af: the Leave Cycle card is retired with the Application Rules tab', () => {
  it('the route is a bare redirect stub — no card, no data reads, no guard of its own', () => {
    expect(applicationRulesStub).toContain("import { redirect } from 'next/navigation'");
    expect(applicationRulesStub).toContain("redirect(`/admin/leave/entitlements");
    // Nothing survives of the page it replaced.
    expect(applicationRulesStub.includes('leaveCycleTitle')).toBe(false);
    expect(applicationRulesStub.includes('leaveYearTitle')).toBe(false);
    expect(applicationRulesStub.includes('<LeaveTabs')).toBe(false);
    expect(applicationRulesStub.includes('requireAdmin')).toBe(false);
  });

  it('no page renders the per-company cycle form any more (one home: the per-type Leave Year Type)', () => {
    for (const src of [entitlementsPage, applicationRulesStub]) {
      expect(src.includes('setCompanyLeaveCycleAction')).toBe(false);
      expect(src.includes('leaveCycleTitle')).toBe(false);
      expect(src.includes('cycleCalendar')).toBe(false);
      expect(src.includes('name="cycle"')).toBe(false);
    }
  });

  it('setCompanyLeaveCycleAction is gone from the admin actions (nothing posts it)', () => {
    expect(actions.includes('export async function setCompanyLeaveCycleAction')).toBe(false);
    // …but the core write it wrapped is untouched: stored company cycles still drive every leave type
    // left on "Company default", and the DB tests set them through it.
    const core = read('/core/admin.ts');
    expect(core).toContain('export async function setCompanyLeaveCycle(');
  });

  it('the retired tab is not a guarded route any more (a redirect stub guards nothing)', () => {
    const permissions = read('/lib/permissions.ts');
    expect(permissions.includes("'/admin/leave/application-rules'")).toBe(false);
    const tabs = read('/components/leave-tabs.tsx');
    expect(tabs.includes('application-rules')).toBe(false);
    expect(tabs.includes('applicationRules')).toBe(false);
  });
});

describe('d778d2d3 / 1e4eb8af: i18n — button keys added, retired cycle keys pruned, in all 6 locales', () => {
  for (const locale of LOCALES) {
    it(`${locale}.json carries the new action keys and has dropped the retired cycle keys`, () => {
      const leave = JSON.parse(read(`/messages/${locale}.json`)).admin.leave as Record<string, unknown>;
      for (const key of ['runAccrualAction', 'previewScenarioAction', 'close']) {
        expect(leave, `${locale}: ${key} must exist`).toHaveProperty(key);
      }
      // Reused unchanged: the two dialog titles.
      for (const key of ['runEarnedAccrual', 'previewTitle']) {
        expect(leave, `${locale}: ${key} must remain`).toHaveProperty(key);
      }
      // 1e4eb8af retired the Leave Cycle card, so its strings go with it (the pendingEngineNote precedent).
      for (const key of ['leaveCycleTitle', 'leaveCycleHelp', 'cycleCalendar', 'cycleAnniversary']) {
        expect(leave, `${locale}: ${key} must be pruned`).not.toHaveProperty(key);
      }
    });
  }
});
