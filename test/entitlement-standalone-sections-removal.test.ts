/**
 * Remove Standalone Sections from Leave Configuration Entitlement Page (R61 · feedback d778d2d3).
 *
 * The Entitlements tab used to carry three standalone sections below the leave-type workspace:
 *   1. Run Earned Accrual (EarnedAccrualCard — scope selectors, dry-run preview, confirm),
 *   2. Leave Cycle (per-company calendar-vs-anniversary forms posting setCompanyLeaveCycleAction),
 *   3. Preview a Scenario (LeaveRulePreview — the live entitlement-rule checker).
 * Each keeps its FUNCTION but loses its section:
 *   - Run Earned Accrual → a compact "Run Accrual" button in the PageHeader actions cluster opening
 *     the SAME EarnedAccrualCard in a wide dialog (components/leave/earned-accrual-dialog.tsx),
 *   - Preview a Scenario → a "Preview Scenario" button, same pattern
 *     (components/leave/leave-rule-preview-dialog.tsx),
 *   - Leave Cycle → a Card on the Application Rules tab beside the Leave Year settings (both are
 *     company-level calendar rules); setCompanyLeaveCycleAction is unchanged, only rendering moved,
 *     and the action now redirects back to the Application Rules route (the R45 cc816207 precedent).
 * Header cluster order: Import, Run Accrual, Preview Scenario. No data, accrual behaviour or cycle
 * semantics change — the wrapped components are byte-identical tools in new frames.
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
const applicationRulesPage = read('/app/admin/leave/application-rules/page.tsx');
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

  it('keeps the leave-type workspace and the Grades catalog — the slimmed page body', () => {
    expect(entitlementsPage).toMatch(/<LeaveTypeWorkspace/);
    expect(entitlementsPage).toMatch(/<LeaveTypePanel/);
    expect(entitlementsPage).toMatch(/<GradeCatalog/);
  });
});

describe('d778d2d3: the two tools become PageHeader action buttons (Import, Run Accrual, Preview Scenario)', () => {
  // The whole actions cluster: from actions={ to the closing of the PageHeader element.
  const headerStart = entitlementsPage.indexOf('<PageHeader');
  const headerEnd = entitlementsPage.indexOf('<LeaveTabs');
  const header = entitlementsPage.slice(headerStart, headerEnd);

  it('renders all three actions inside the PageHeader actions slot', () => {
    expect(header).toMatch(/actions=\{/);
    expect(header).toMatch(/<Link href="\/admin\/leave\/import" className=\{btnPrimary\}>/);
    expect(header).toMatch(/<EarnedAccrualDialog/);
    expect(header).toMatch(/<LeaveRulePreviewDialog/);
  });

  it('keeps the cluster order Import → Run Accrual → Preview Scenario', () => {
    const importIdx = header.indexOf('href="/admin/leave/import"');
    const accrualIdx = header.indexOf('<EarnedAccrualDialog');
    const previewIdx = header.indexOf('<LeaveRulePreviewDialog');
    expect(importIdx).toBeGreaterThan(-1);
    expect(accrualIdx).toBeGreaterThan(importIdx);
    expect(previewIdx).toBeGreaterThan(accrualIdx);
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

describe('d778d2d3: the Leave Cycle card lives on the Application Rules tab now', () => {
  it('renders the per-company cycle rows with the same options and the same action', () => {
    expect(applicationRulesPage).toMatch(/SectionHeader title=\{t\('leaveCycleTitle'\)\} count=\{companies\.length\}/);
    expect(applicationRulesPage).toMatch(/\{t\('leaveCycleHelp'\)\}/);
    expect(applicationRulesPage).toMatch(/action=\{setCompanyLeaveCycleAction\}/);
    expect(applicationRulesPage).toMatch(/<input type="hidden" name="companyId" value=\{c\.id\} \/>/);
    expect(applicationRulesPage).toMatch(/name="cycle" defaultValue=\{c\.leaveCycle \?\? 'calendar'\}/);
    expect(applicationRulesPage).toMatch(/<option value="calendar">\{t\('cycleCalendar'\)\}<\/option>/);
    expect(applicationRulesPage).toMatch(/<option value="anniversary">\{t\('cycleAnniversary'\)\}<\/option>/);
  });

  it('sits beside the kindred company-calendar rules (Leave Year card on the same page)', () => {
    expect(applicationRulesPage).toMatch(/leaveYearTitle/);
    const leaveYearIdx = applicationRulesPage.indexOf("t('leaveYearTitle')");
    const cycleIdx = applicationRulesPage.indexOf("t('leaveCycleTitle')");
    expect(leaveYearIdx).toBeGreaterThan(-1);
    expect(cycleIdx).toBeGreaterThan(leaveYearIdx);
  });

  it('setCompanyLeaveCycleAction redirects back to the Application Rules route (R45 precedent)', () => {
    const fnStart = actions.indexOf('export async function setCompanyLeaveCycleAction');
    expect(fnStart).toBeGreaterThan(-1);
    const fn = actions.slice(fnStart, actions.indexOf('\n}', fnStart));
    expect(fn).toMatch(/fail\(APPLICATION_RULES, e\)/);
    expect(fn).toMatch(/ok\(APPLICATION_RULES\)/);
    // The cycle WRITE is untouched — same core call, same field coercion.
    expect(fn).toMatch(/setCompanyLeaveCycle\(s, \{/);
    expect(fn).toMatch(/cycle: String\(formData\.get\('cycle'\) \|\| 'calendar'\)/);
  });
});

describe('d778d2d3: i18n — new button keys added, cycle keys kept, in all 6 locales', () => {
  for (const locale of LOCALES) {
    it(`${locale}.json carries the new action keys and keeps the relocated/reused section keys`, () => {
      const leave = JSON.parse(read(`/messages/${locale}.json`)).admin.leave as Record<string, unknown>;
      for (const key of ['runAccrualAction', 'previewScenarioAction', 'close']) {
        expect(leave, `${locale}: ${key} must exist`).toHaveProperty(key);
      }
      // Reused unchanged: dialog titles + the relocated Leave Cycle card's strings.
      for (const key of ['runEarnedAccrual', 'previewTitle', 'leaveCycleTitle', 'leaveCycleHelp', 'cycleCalendar', 'cycleAnniversary']) {
        expect(leave, `${locale}: ${key} must remain`).toHaveProperty(key);
      }
    });
  }
});
