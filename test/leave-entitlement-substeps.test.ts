/**
 * Restructure Entitlements Secondary Workflow (feedback 7b945408).
 *
 * The Entitlement step (step 3 of the c979aa8b workspace flow) becomes a guided THREE-SUB-STEP walk —
 * 1 Benefit Schemes · 2 Service Based Entitlements · 3 Adjustments — switched by the SAME reusable
 * SubStepBar the General restructure introduced (components/leave-sub-step-bar.tsx, the e1a51aea reuse
 * contract: secondary flows must REUSE it, never reinvent a nested bar). The active sub-step persists per
 * type alongside activeStep/generalSubStep/essSubStep in the leaveTypeCards:<id> localStorage shape
 * (backward-compatible: older payloads still hydrate, entitlementSubStep defaults to Benefit Schemes).
 *
 * Content contract (arrangement only — every tool keeps its exact data prep, actions and behaviour):
 *  - Benefit Schemes: the Grades catalogue relocated from the standalone page-bottom section (grades are
 *    TENANT-WIDE master data — one shared node with the company-wide badge convention and the surviving
 *    03557e76 fold + cookie), followed by the type-scoped scheme management (6c775d68) — so the
 *    grade → grade-group → scheme relationship reads in one place.
 *  - Service Based Entitlements: the per-type entitlement table (123c1e76, same rows + upsert action) plus
 *    the Preview Scenario checker (d778d2d3's LeaveRulePreviewDialog) as its checking tool.
 *  - Adjustments: the One-Off/Festive grant tool (fd7c8e20, still preset to the hosting type) plus the Run
 *    Accrual action (d778d2d3's EarnedAccrualDialog) relocated from the page header — it processes earned
 *    entitlement, so it belongs with entitlement adjustments. Both dialogs are self-contained (form-free —
 *    entitlement-standalone-sections-removal.test.ts pins that), so the new mounts carry no portal caveat.
 *  - Header coordination: this item only ADDS the new homes; item 962077a8 REMOVES the PageHeader buttons.
 *
 * Static source guard (the repo convention for this DOM-runner-less component; see
 * leave-type-config-categories.test.ts / leave-condition-substeps.test.ts). Browser verification covers
 * the interactive switching, scheme CRUD + DnD inside the sub-step, grades editing, entitlement-table
 * add, festive grant, accrual dry-run + confirm from Adjustments, preview from Service Based Entitlements
 * and mobile stacking — that assignment is not optional.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service', 'adjustments'] as const;

/** Slice the Entitlement card's segment (its CardTitle to the Condition card's CardTitle). */
function entitlementSegment(): string {
  const start = panelSrc.indexOf("<CardTitle>{t('categoryEntitlement')}</CardTitle>");
  const end = panelSrc.indexOf("<CardTitle>{t('categoryEssPolicy')}</CardTitle>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return panelSrc.slice(start, end);
}

/** Slice one sub-step's gated block out of the Entitlement segment. */
function subStepSlice(seg: string, key: (typeof ENTITLEMENT_SUB_STEP_KEYS)[number]): string {
  const start = seg.indexOf(`{entitlementSubStep === '${key}' && (`);
  expect(start, `sub-step '${key}' gate present`).toBeGreaterThan(-1);
  const i = ENTITLEMENT_SUB_STEP_KEYS.indexOf(key);
  const next =
    i + 1 < ENTITLEMENT_SUB_STEP_KEYS.length
      ? seg.indexOf(`{entitlementSubStep === '${ENTITLEMENT_SUB_STEP_KEYS[i + 1]}' && (`)
      : seg.length;
  expect(next).toBeGreaterThan(start);
  return seg.slice(start, next);
}

describe('7b945408 · the Entitlement step REUSES the SubStepBar (three sub-steps in walk order)', () => {
  it('renders the shared SubStepBar inside the Entitlement card — no reinvented nested bar', () => {
    expect(panelSrc).toContain("const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service', 'adjustments'] as const");
    const seg = entitlementSegment();
    expect(seg).toContain('<SubStepBar');
    expect(seg).toContain('ENTITLEMENT_SUB_STEP_KEYS.map((k) => ({ key: k, label: t(ENTITLEMENT_SUB_STEP_TITLE_KEY[k]) }))');
    // Exactly one sub-step's content renders at a time — each gates its own block.
    for (const key of ENTITLEMENT_SUB_STEP_KEYS) {
      expect(seg.includes(`{entitlementSubStep === '${key}' && (`), `sub-step '${key}' gated`).toBe(true);
    }
    // ONE SubStepBar component file serves every secondary flow — the reuse contract.
    expect(panelSrc).toMatch(/import \{ SubStepBar \} from '\.\/leave-sub-step-bar'/);
  });

  it('persists entitlementSubStep in the shared leaveTypeCards shape (compatible migration)', () => {
    // The ONE writer persists all four keys together…
    expect(panelSrc).toContain(
      'JSON.stringify({ activeStep: step, generalSubStep: sub, essSubStep: ess, entitlementSubStep: ent })',
    );
    // …and hydration tolerates an older payload (entitlementSubStep absent ⇒ default Benefit Schemes).
    expect(panelSrc).toContain("typeof parsed.entitlementSubStep === 'string'");
    expect(panelSrc).toContain("useState<EntitlementSubStepKey>('schemes')");
  });
});

describe('7b945408 · Benefit Schemes — grades relocated from the page bottom + the scoped scheme area', () => {
  it('the schemes sub-step renders gradesSection then benefitSchemeSection (grade → group → scheme order)', () => {
    const schemes = subStepSlice(entitlementSegment(), 'schemes');
    const grades = schemes.indexOf('{gradesSection}');
    const config = schemes.indexOf('{benefitSchemeSection}');
    expect(grades).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(grades);
    // Slot-shaped props, like the other server-composed sections.
    expect(panelSrc).toContain('gradesSection?: ReactNode');
  });

  it('the standalone page-bottom Grades Card is gone; the page composes ONE shared gradesSection slot', () => {
    // GradeCatalog is composed exactly once — inside the gradesSection const, not a page-bottom Card.
    expect(pageSrc.match(/<GradeCatalog/g)?.length).toBe(1);
    const slotStart = pageSrc.indexOf('const gradesSection = (');
    expect(slotStart).toBeGreaterThan(-1);
    const slot = pageSrc.slice(slotStart, pageSrc.indexOf('const previewScenarioSection'));
    expect(slot).toContain('<GradeCatalog');
    expect(slot).toContain('<CollapsibleCardSection');
    // Grade actions untouched — same CRUD wiring as the standalone section carried.
    for (const action of ['create: createJobGradeAction', 'update: updateJobGradeAction', 'archive: archiveJobGradeAction', 'delete: deleteJobGradeAction']) {
      expect(slot.includes(action), `${action} still wired`).toBe(true);
    }
    // Tenant-wide master data → the company-wide badge convention (08bc6841's pill).
    expect(slot).toContain("t('entitlementStep.gradesCompanyWideBadge')");
    // ONE shared node passed into every panel via the slot prop (grades are per-tenant, not per-type).
    expect(pageSrc).toContain('gradesSection={gradesSection}');
    // The page body after the workspace card hosts no grades Card anymore.
    const helpAt = pageSrc.indexOf("t.rich('typesHelp'");
    expect(helpAt).toBeGreaterThan(-1);
    expect(pageSrc.slice(helpAt).includes('<GradeCatalog')).toBe(false);
  });

  it('keeps the 03557e76 fold semantics: cookie SSR-read + CollapsibleCardSection ride along', () => {
    // The fold moved WITH the catalogue — cookie name, SSR read and defaultOpen wiring survive
    // (leave-grades-section-collapse.test.ts pins the fold behaviour itself).
    expect(pageSrc).toContain("const GRADES_OPEN_COOKIE = 'leave_grades_open'");
    expect(pageSrc).toMatch(/GRADES_OPEN_COOKIE\)\?\.value === '1'/);
    expect(pageSrc).toContain('defaultOpen={gradesOpen}');
  });
});

describe('7b945408 · Service Based Entitlements — the per-type table + the Preview Scenario checker', () => {
  it('the service sub-step renders LeaveTypeEntitlementTable then the previewScenarioSection slot', () => {
    const service = subStepSlice(entitlementSegment(), 'service');
    const table = service.indexOf('<LeaveTypeEntitlementTable');
    const preview = service.indexOf('{previewScenarioSection}');
    expect(table).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(table);
    // Same rows + same upsert action as before (leave-type-config-categories.test.ts pins the reuse).
    expect(service).toContain('ents={schemeEntitlements} upsertEntitlement={upsertSchemeEntitlementAction}');
    expect(panelSrc).toContain('previewScenarioSection?: ReactNode');
  });

  it('the page composes the SAME LeaveRulePreviewDialog into the slot (page-level data prep, no fork)', () => {
    const slotStart = pageSrc.indexOf('const previewScenarioSection');
    expect(slotStart).toBeGreaterThan(-1);
    const slot = pageSrc.slice(slotStart, pageSrc.indexOf('const accrualSection'));
    expect(slot).toContain('<LeaveRulePreviewDialog');
    // Same inputs the header button feeds: the page-level previewPolicies/previewCompanies prep.
    expect(slot).toContain('policies={previewPolicies}');
    expect(slot).toContain('companies={previewCompanies}');
    expect(pageSrc).toContain('previewScenarioSection={previewScenarioSection}');
  });
});

describe('7b945408 · Adjustments — the festive grant tool + the relocated Run Accrual action', () => {
  it('the adjustments sub-step renders festiveGrantSection then the accrualSection slot', () => {
    const adjustments = subStepSlice(entitlementSegment(), 'adjustments');
    const festive = adjustments.indexOf('{festiveGrantSection}');
    const accrual = adjustments.indexOf('{accrualSection}');
    expect(festive).toBeGreaterThan(-1);
    expect(accrual).toBeGreaterThan(festive);
    expect(panelSrc).toContain('accrualSection?: ReactNode');
  });

  it('the page composes the SAME EarnedAccrualDialog into the slot (page-level data prep, no fork)', () => {
    const slotStart = pageSrc.indexOf('const accrualSection = (');
    expect(slotStart).toBeGreaterThan(-1);
    const slot = pageSrc.slice(slotStart, pageSrc.indexOf('return ('));
    expect(slot).toContain('<EarnedAccrualDialog');
    // Same inputs the header button feeds: the page-level leave-year prep.
    expect(slot).toContain('leaveYears={earnedLeaveYears}');
    expect(slot).toContain('defaultYear={earnedDefaultYear}');
    expect(pageSrc).toContain('accrualSection={accrualSection}');
  });

  it('coordination with 962077a8: the PageHeader still hosts the dialog buttons until that item lands', () => {
    // This item only ADDS the new homes. The header cluster keeps Import → Run Accrual → Preview
    // Scenario (entitlement-standalone-sections-removal.test.ts pins that order); 962077a8 removes it.
    const header = pageSrc.slice(pageSrc.indexOf('<PageHeader'), pageSrc.indexOf('<LeaveTabs'));
    expect(header).toContain('<EarnedAccrualDialog');
    expect(header).toContain('<LeaveRulePreviewDialog');
  });
});

describe('7b945408 · i18n — all six locales', () => {
  it('carries the entitlement sub-step keys in each locale (en pins the reported wording)', () => {
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8'));
    expect(en.admin.leave.entitlementStep.schemes).toBe('Benefit Schemes');
    expect(en.admin.leave.entitlementStep.service).toBe('Service Based Entitlements');
    expect(en.admin.leave.entitlementStep.adjustments).toBe('Adjustments');
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      expect(typeof leave.entitlementStepsLabel, `${loc} entitlementStepsLabel`).toBe('string');
      const sub = leave.entitlementStep ?? {};
      for (const key of ['schemes', 'service', 'adjustments', 'gradesCompanyWideBadge', 'previewHint', 'accrualHint']) {
        expect(typeof sub[key], `${loc}.admin.leave.entitlementStep.${key}`).toBe('string');
        expect((sub[key] as string).length, `${loc}.admin.leave.entitlementStep.${key} non-empty`).toBeGreaterThan(0);
      }
      // The relocated tools reuse the existing strings — they must stay present.
      for (const key of ['gradesTitle', 'gradesHelp', 'gradesToggle', 'runEarnedAccrual', 'previewTitle']) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
      }
    }
  });
});
