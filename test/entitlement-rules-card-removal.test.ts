/**
 * Remove Entitlement Rules card from the Leave Types tab (R53 · feedback 26e76a9f).
 *
 * The Leave Types tab used to render a read-only "Entitlement rules" card (effective-rules table +
 * resolution-order list + the live "preview a scenario" checker) below the leave-type master listing.
 * The same rules are MANAGED on the Entitlements tab, so the card read like a second place to configure
 * entitlements. This change removes the card from the Types tab and relocates the still-useful preview
 * checker to the Entitlements tab. Display-only: no entitlement records, calculations, balances or
 * configuration logic are touched — the resolver, services and schema are byte-identical.
 *
 * DB-free source guard (the suite has no DOM runner): the RSC pages can't be rendered here, so we assert
 * the composition + the source-of-truth wiring + the i18n pruning statically.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const typesPage = read('/app/admin/leave/page.tsx');
const entitlementsPage = read('/app/admin/leave/entitlements/page.tsx');
const previewComponent = read('/components/leave-rule-preview.tsx');
// R61 d778d2d3 — the checker lost its standalone section too: it now mounts inside a dialog (since
// R64 7b945408/962077a8 opened from the Service Based Entitlements sub-step, not the header). The
// relocation promise below follows it there.
const previewDialog = read('/components/leave/leave-rule-preview-dialog.tsx');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const PRUNED_KEYS = [
  'rulesCardTitle',
  'rulesCardHelp',
  'rulesColLeaveType',
  'rulesColCompany',
  'rulesColGrade',
  'rulesColEntitlement',
  'rulesColValidFrom',
  'rulesOrderTitle',
  'rulesOrderStep1',
  'rulesOrderStep2',
  'rulesOrderStep3',
  'rulesOrderStep4',
  'rulesOrderNoReorder',
] as const;
// Every key the relocated LeaveRulePreview (and its card heading) still reads — must survive the prune.
const KEPT_PREVIEW_KEYS = [
  'previewTitle',
  'previewLeaveTypeLabel',
  'previewCompanyLabel',
  'previewGradeLabel',
  'previewServiceYearsLabel',
  'previewNoCompany',
  'previewResultDays',
  'previewFloorDays',
  'previewPolicyDays',
  // fa3f4ccb replaced the "floor vs policy — which won" badge pair with a single below-minimum WARNING:
  // after fa3f4ccb the configured figure always wins, so a badge announcing the winner said nothing.
  'previewBelowFloorWarning',
  'previewNoPack',
  'gradeAll',
] as const;

describe('26e76a9f: the Types tab no longer renders the Entitlement rules card', () => {
  it('drops the rules card (title, help, columns, resolution order) from the page', () => {
    expect(typesPage.includes('rulesCardTitle')).toBe(false);
    expect(typesPage.includes('rulesCardHelp')).toBe(false);
    expect(typesPage.includes('rulesOrderTitle')).toBe(false);
    expect(typesPage.includes('rulesColLeaveType')).toBe(false);
  });

  it('drops the inline rules/preview data prep and the LeaveRulePreview composition', () => {
    expect(typesPage.includes('activeRules')).toBe(false);
    expect(typesPage.includes('previewPolicies')).toBe(false);
    expect(typesPage.includes('LeaveRulePreview')).toBe(false);
    expect(typesPage.includes("from '@/components/leave-rule-preview'")).toBe(false);
    // The page no longer loads policy rows at all — the master listing only needs the types.
    expect(typesPage.includes('listLeavePolicies')).toBe(false);
  });

  it('keeps the read-only leave-type master listing with its Entitlements deep-link + delete action', () => {
    expect(typesPage).toMatch(/typeMasterTitle/);
    expect(typesPage).toMatch(/\/admin\/leave\/entitlements#type-\$\{lt\.id\}/);
    expect(typesPage).toMatch(/deleteLeaveTypeAction/);
  });
});

describe('26e76a9f: the preview checker relocated to the Entitlements tab', () => {
  it('renders LeaveRulePreview on the Entitlements tab, dialog-mounted under the previewTitle heading (d778d2d3)', () => {
    // The page opens the checker from its "Preview Scenario" dialog button (in the Service Based
    // Entitlements sub-step since 962077a8); the dialog wraps the SAME LeaveRulePreview component
    // and titles the pop-up with the same previewTitle key.
    expect(entitlementsPage).toMatch(/import \{ LeaveRulePreviewDialog \} from '@\/components\/leave\/leave-rule-preview-dialog'/);
    expect(entitlementsPage).toMatch(/<LeaveRulePreviewDialog/);
    expect(previewDialog).toMatch(/import \{\s*\n?\s*LeaveRulePreview,/);
    expect(previewDialog).toMatch(/<LeaveRulePreview/);
    expect(previewDialog).toMatch(/Dialog\.Title[^>]*>\{t\('previewTitle'\)\}/);
  });

  it('feeds the preview from the SAME listLeavePolicies rows the tab already loads (active only)', () => {
    expect(entitlementsPage).toMatch(/listLeavePolicies\(s\)/);
    expect(entitlementsPage).toMatch(/const previewPolicies = policies\s*\n?\s*\.filter\(\(p\) => !p\.validTo\)/);
    // Companies keep their country so the statutory-floor half of the preview still works.
    expect(entitlementsPage).toMatch(/country: c\.country/);
  });

  it('leaves the designated entitlement location intact (per-type panels + benefit schemes)', () => {
    expect(entitlementsPage).toMatch(/<LeaveTypePanel/);
    expect(entitlementsPage).toMatch(/<BenefitSchemeConfig/);
  });
});

describe('26e76a9f: display-only removal — the shared resolver/component are untouched', () => {
  it('LeaveRulePreview still runs the exact server-side resolver, client-safely', () => {
    expect(previewComponent.trimStart().startsWith("'use client'")).toBe(true);
    expect(previewComponent).toMatch(/import \{ previewEntitlement, type GradePolicyRow \} from '@\/core\/leave-compute'/);
    expect(previewComponent).toMatch(/previewEntitlement\(rows, gradeId \|\| null, companyId \|\| null/);
  });
});

describe('26e76a9f: i18n pruned in all 6 locales, preview strings kept', () => {
  for (const locale of LOCALES) {
    it(`${locale}.json drops the rules-card keys and keeps the preview keys`, () => {
      const leave = JSON.parse(read(`/messages/${locale}.json`)).admin.leave as Record<string, unknown>;
      for (const key of PRUNED_KEYS) expect(leave, `${locale}: ${key} should be pruned`).not.toHaveProperty(key);
      for (const key of KEPT_PREVIEW_KEYS) expect(leave, `${locale}: ${key} must remain`).toHaveProperty(key);
    });
  }
});
