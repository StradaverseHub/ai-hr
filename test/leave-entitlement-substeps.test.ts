/**
 * Restructure Entitlements Secondary Workflow (feedback 7b945408).
 *
 * The Entitlement step (step 3 of the c979aa8b workspace flow — still step 3 after b8fcae73 shortened and
 * reordered the walk) becomes a guided SUB-STEP walk: originally three (1 Benefit Schemes · 2 Service Based
 * Entitlements · 3 Adjustments), four since b8fcae73 inserted Company Entitlements at position 3 and pushed
 * Adjustments to 4 — switched by the SAME reusable
 * SubStepBar the General restructure introduced (components/leave-sub-step-bar.tsx, the e1a51aea reuse
 * contract: secondary flows must REUSE it, never reinvent a nested bar). The active sub-step persists per
 * type alongside activeStep/generalSubStep/essSubStep in the leaveTypeCards:<id> localStorage shape
 * (backward-compatible: older payloads still hydrate, entitlementSubStep defaults to Benefit Schemes).
 *
 * Content contract (arrangement only — every tool keeps its exact data prep, actions and behaviour):
 *  - Benefit Schemes: the Grades catalogue relocated from the standalone page-bottom section (grades are
 *    TENANT-WIDE master data — one shared node with the company-wide badge convention and the surviving
 *    03557e76 fold + cookie), joined with the type-scoped scheme management (6c775d68). 387792a4: the two
 *    no longer stack — the catalogue is Panel A of the three-panel workbench inside BenefitSchemeConfig
 *    (gradesPanel slot), so the grade → grade-group → scheme relationship reads side by side.
 *  - Service Based Entitlements: the per-type entitlement table (123c1e76, same rows + upsert action) plus
 *    the Preview Scenario checker (d778d2d3's LeaveRulePreviewDialog) as its checking tool.
 *  - Company Entitlements (b8fcae73): the per-company entitlement-policies timeline relocated verbatim from
 *    the retired Eligibility step — days per company/grade, carry-forward, accrual method, effective dates,
 *    add/edit/remove. Same state, same create/update/delete actions; its tab label reuses the EXISTING
 *    companyEntitlements string, so no new locale key. It gets its OWN sub-step rather than joining Service
 *    Based Entitlements so the two similar "days per X" editors cannot be confused.
 *  - Adjustments: the One-Off/Festive grant tool (fd7c8e20, still preset to the hosting type) plus the Run
 *    Accrual action (d778d2d3's EarnedAccrualDialog) relocated from the page header — it processes earned
 *    entitlement, so it belongs with entitlement adjustments. Both dialogs are self-contained (form-free —
 *    entitlement-standalone-sections-removal.test.ts pins that), so the new mounts carry no portal caveat.
 *  - Header coordination: this item only ADDED the new homes; item 962077a8 then REMOVED the PageHeader
 *    buttons, so the sub-step slots are the tools' only mounts.
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

const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service', 'policies', 'adjustments'] as const;

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

describe('7b945408 · the Entitlement step REUSES the SubStepBar (four sub-steps in walk order)', () => {
  it('renders the shared SubStepBar inside the Entitlement card — no reinvented nested bar', () => {
    // b8fcae73 inserted 'policies' between service and adjustments (the relocated Company Entitlements).
    expect(panelSrc).toContain(
      "const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service', 'policies', 'adjustments'] as const",
    );
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
  // 387792a4 re-pinned: the schemes sub-step no longer stacks a separate gradesSection slot above the
  // config — the Grades catalogue is Panel A of the three-panel workbench INSIDE BenefitSchemeConfig
  // (threaded via its gradesPanel prop; entitlement-grade-workbench.test.ts guards the workbench itself).
  it('the schemes sub-step renders the benefitSchemeSection workbench (grades live inside it as Panel A)', () => {
    const schemes = subStepSlice(entitlementSegment(), 'schemes');
    expect(schemes).toContain('{benefitSchemeSection}');
    // No separate grades slot remains — the panel neither renders nor accepts one.
    expect(schemes.includes('{gradesSection}')).toBe(false);
    expect(panelSrc.includes('gradesSection?: ReactNode')).toBe(false);
    // The page threads the ONE shared grades node into the config as its Panel A slot.
    expect(pageSrc).toContain('gradesPanel={gradesSection}');
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
    // ONE shared node fed into every panel's workbench via the config's gradesPanel slot (387792a4).
    expect(pageSrc).toContain('gradesPanel={gradesSection}');
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

describe('b8fcae73 · Company Entitlements — the per-company policy timeline relocated from Eligibility', () => {
  it('the policies sub-step hosts the timeline + add form the retired Eligibility step used to own', () => {
    const policies = subStepSlice(entitlementSegment(), 'policies');
    // The timeline heading and the add-entitlement affordance came across verbatim.
    expect(policies).toContain("t('companyEntitlements')");
    expect(policies).toContain("t('addEntitlement')");
    // Same CRUD wiring — create/update/delete reused, not forked.
    for (const action of ['action={createPolicyAction}', 'action={updatePolicyAction}', 'action={deletePolicyAction}']) {
      expect(policies.includes(action), `${action} still wired`).toBe(true);
    }
    // The tab label REUSES the existing companyEntitlements string — no new locale key.
    expect(panelSrc).toContain("policies: 'companyEntitlements'");
  });

  it('a persisted activeStep pointing at the retired Eligibility step lands on this sub-step', () => {
    // Without a remap the stored value no longer matches STEP_KEYS and would snap back to step 1.
    expect(panelSrc).toContain("const RETIRED_ELIGIBILITY_STEP = 'eligibility'");
    expect(panelSrc).toContain('parsed.activeStep === RETIRED_ELIGIBILITY_STEP');
    // …and the legacy accordion shape ({ eligibility: true }) gets the same treatment.
    expect(panelSrc).toContain('parsed[RETIRED_ELIGIBILITY_STEP] === true');
    // The remap WINS over any stored entitlementSubStep, otherwise the user would not see the content.
    expect(panelSrc).toContain('!wantedEligibility');
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

  it('coordination with 962077a8: the PageHeader no longer hosts the dialog buttons (sub-steps only)', () => {
    // 7b945408 ADDED the new homes; 962077a8 then removed the header cluster's Run Accrual / Preview
    // Scenario buttons (entitlement-standalone-sections-removal.test.ts pins the Import-only header).
    const header = pageSrc.slice(pageSrc.indexOf('<PageHeader'), pageSrc.indexOf('<LeaveTabs'));
    expect(header.includes('<EarnedAccrualDialog')).toBe(false);
    expect(header.includes('<LeaveRulePreviewDialog')).toBe(false);
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
