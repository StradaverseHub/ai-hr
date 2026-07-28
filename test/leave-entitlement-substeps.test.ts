/**
 * Restructure Entitlements Secondary Workflow (feedback 7b945408).
 *
 * The Entitlement step (step 3 of the c979aa8b workspace flow — still step 3 after b8fcae73 shortened and
 * reordered the walk) becomes a guided SUB-STEP walk: originally three (1 Benefit Schemes · 2 Service Based
 * Entitlements · 3 Adjustments), four since b8fcae73 inserted Company Entitlements at position 3 and pushed
 * Adjustments to 4, and three again since bc9be1e8 + 0d9cf710 removed that tab — switched by the SAME reusable
 * SubStepBar the General restructure introduced (components/leave-sub-step-bar.tsx, the e1a51aea reuse
 * contract: secondary flows must REUSE it, never reinvent a nested bar). The active sub-step persists per
 * type alongside activeStep/generalSubStep/essSubStep in the leaveTypeCards:<id> localStorage shape
 * (backward-compatible: older payloads still hydrate, entitlementSubStep defaults to Benefit Schemes).
 *
 * Content contract (arrangement only — every tool keeps its exact data prep, actions and behaviour):
 *  - Benefit Schemes: the type-scoped scheme management (6c775d68) — grade groups and benefit schemes, side
 *    by side inside BenefitSchemeConfig. It used to also host the Grades catalogue (as Panel A of a
 *    three-panel workbench, 387792a4); b1b81a08 moved grade MASTER data out of Leave Config to Settings →
 *    System Labels → Organisation Labels, so the workbench is two panels and this page composes no grade
 *    editor at all. The grade LIST is still loaded here for the policy scope dropdown and the groups.
 *  - Service Based Entitlements: the per-type entitlement table (123c1e76, same rows + upsert action), the
 *    per-company entitlement-policies timeline, and the Preview Scenario checker (d778d2d3's
 *    LeaveRulePreviewDialog) as its checking tool.
 *  - Company Entitlements (b8fcae73) hosted that timeline behind its own tab; 2bba9e35 merged it into a gate
 *    shared with Service, and bc9be1e8 + 0d9cf710 then REMOVED the tab. The timeline — days per
 *    company/grade, carry-forward, accrual method, effective dates, add/edit/remove — is Service Based
 *    Entitlements' own content now, and the only place a policy can be added or deleted.
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

const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service', 'adjustments'] as const;

/** Slice the Entitlement card's segment (its CardTitle to the Condition card's CardTitle). */
function entitlementSegment(): string {
  const start = panelSrc.indexOf("<CardTitle>{t('categoryEntitlement')}</CardTitle>");
  const end = panelSrc.indexOf("<CardTitle>{t('categoryEssPolicy')}</CardTitle>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return panelSrc.slice(start, end);
}

/** The source index of a sub-step's gated block. bc9be1e8 removed the Company Entitlements sub-step, so
 *  every remaining sub-step has its own exclusive gate again — there is no shared gate any more. */
function gateIndex(seg: string, key: (typeof ENTITLEMENT_SUB_STEP_KEYS)[number]): number {
  return seg.indexOf(`{entitlementSubStep === '${key}' && (`);
}

/** Slice one sub-step's gated block out of the Entitlement segment. */
function subStepSlice(seg: string, key: (typeof ENTITLEMENT_SUB_STEP_KEYS)[number]): string {
  const start = gateIndex(seg, key);
  expect(start, `sub-step '${key}' gate present`).toBeGreaterThan(-1);
  const i = ENTITLEMENT_SUB_STEP_KEYS.indexOf(key);
  const next =
    i + 1 < ENTITLEMENT_SUB_STEP_KEYS.length ? gateIndex(seg, ENTITLEMENT_SUB_STEP_KEYS[i + 1]) : seg.length;
  expect(next).toBeGreaterThan(start);
  return seg.slice(start, next);
}

describe('7b945408 · the Entitlement step REUSES the SubStepBar (three sub-steps in walk order)', () => {
  it('renders the shared SubStepBar inside the Entitlement card — no reinvented nested bar', () => {
    // bc9be1e8 removed 'policies' again: 1 Benefit Schemes · 2 Service Based Entitlements · 3 Adjustments.
    expect(panelSrc).toContain(
      "const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service', 'adjustments'] as const",
    );
    const seg = entitlementSegment();
    expect(seg).toContain('<SubStepBar');
    expect(seg).toContain('ENTITLEMENT_SUB_STEP_KEYS.map((k) => ({ key: k, label: t(ENTITLEMENT_SUB_STEP_TITLE_KEY[k]) }))');
    // Exactly one sub-step's content renders at a time — each gates its own block.
    for (const key of ENTITLEMENT_SUB_STEP_KEYS) {
      expect(gateIndex(seg, key) > -1, `sub-step '${key}' gated`).toBe(true);
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

describe('7b945408 · Benefit Schemes sub-step — the scoped scheme area', () => {
  // b1b81a08 re-pinned: grade MASTER data left Leave Config entirely for Settings → System Labels →
  // Organisation Labels, so there is no gradesSection slot, no gradesPanel prop and no GradeCatalog on
  // this page any more (test/grade-system-label-relocation.test.ts owns the destination). What this
  // sub-step still hosts is the benefitSchemeSection workbench: grade GROUPS and benefit schemes.
  it('the schemes sub-step renders the benefitSchemeSection workbench and nothing grade-master shaped', () => {
    const schemes = subStepSlice(entitlementSegment(), 'schemes');
    expect(schemes).toContain('{benefitSchemeSection}');
    // No grades slot remains anywhere — the panel neither renders nor accepts one.
    expect(schemes.includes('{gradesSection}')).toBe(false);
    expect(panelSrc.includes('gradesSection?: ReactNode')).toBe(false);
    expect(pageSrc.includes('gradesPanel=')).toBe(false);
  });

  it('the page composes no grade catalogue at all, and no fold cookie survives it', () => {
    expect(pageSrc.includes('<GradeCatalog')).toBe(false);
    expect(pageSrc.includes('const gradesSection = (')).toBe(false);
    expect(pageSrc.includes('leave_grades_open')).toBe(false);
    // The grade LIST is still loaded — it feeds the policy scope dropdown, the preview dialog and the
    // benefit-scheme grade groups. Relocating the editor must not orphan those consumers.
    expect(pageSrc).toContain('listJobGrades(s, { includeArchived: true })');
    expect(pageSrc).toContain('grades={gradeOptions}');
  });
});

describe('Service Based Entitlements — the company-driven scheme table + the Preview Scenario checker', () => {
  // Restructure Service-Based Leave Entitlements by Company and Grade: the service sub-step is the
  // company-driven ServiceEntitlementTable. 9816a5ad changed WHAT its rows are — the company's benefit
  // schemes rather than job grades — and with it the writer: rows post the scheme entitlement upsert, so
  // this sub-step maintains the figures leave calculation actually reads instead of a second set.
  it('the service sub-step renders ServiceEntitlementTable, then the policy timeline, then the preview', () => {
    const seg = entitlementSegment();
    const service = subStepSlice(seg, 'service');
    const table = service.indexOf('<ServiceEntitlementTable');
    expect(table).toBeGreaterThan(-1);
    // bc9be1e8 folded the former shared policy block into this one gate, so the timeline is part of the
    // service slice. The preview checker stays LAST — it follows the service content it checks.
    const timeline = service.indexOf("t('companyEntitlements')");
    const preview = service.indexOf('{previewScenarioSection}');
    expect(timeline).toBeGreaterThan(table);
    expect(preview).toBeGreaterThan(timeline);
    // The company-driven table is fed the leave type identity, companies, the tenant's benefit schemes and
    // their grade groups, and saves through the SAME scheme upsert the Benefit Schemes surface posts — the
    // single-source-of-truth requirement of 9816a5ad. A second writer here would be the duplicate
    // maintenance the item exists to remove.
    expect(service).toContain('leaveTypeId={id}');
    expect(service).toContain('companies={companies}');
    expect(service).toContain('schemes={benefitSchemes}');
    expect(service).toContain('gradeGroups={gradeGroups}');
    expect(service).toContain('upsertEntitlement={upsertSchemeEntitlementAction}');
    expect(service.includes('saveServiceEntitlementAction')).toBe(false);
    // The scheme-days table of the Benefit Schemes sub-step is not re-mounted here — one mount each.
    expect(service.includes('<LeaveTypeEntitlementTable')).toBe(false);
    expect(panelSrc).toContain('previewScenarioSection?: ReactNode');
  });

  it('the benefit-scheme per-type table stays reachable under the Benefit Schemes sub-step', () => {
    const schemes = subStepSlice(entitlementSegment(), 'schemes');
    // The scheme-days editor is not retired — it lives beside the scheme management, over the SAME rows +
    // upsert action (never forked).
    expect(schemes).toContain('<LeaveTypeEntitlementTable');
    expect(schemes).toContain('ents={schemeEntitlements} upsertEntitlement={upsertSchemeEntitlementAction}');
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

describe('bc9be1e8 + 0d9cf710 · Company Entitlements is gone; its timeline lives in Service Based Entitlements', () => {
  it('the sub-step, its tab label and its gate are all removed', () => {
    const seg = entitlementSegment();
    // No fourth tab: neither the key nor the label mapping that named it survives.
    expect(panelSrc.includes("'schemes', 'service', 'policies', 'adjustments'")).toBe(false);
    expect(panelSrc.includes("policies: 'companyEntitlements'")).toBe(false);
    // No gate can route to it — neither the exclusive one b8fcae73 shipped nor 2bba9e35's shared one.
    expect(seg.includes("{entitlementSubStep === 'policies' && (")).toBe(false);
    expect(seg.includes("entitlementSubStep === 'policies' ||")).toBe(false);
  });

  it('the timeline + add form + the full CRUD wiring stay reachable, inside the service sub-step', () => {
    // The removal must not take the ONLY place a policy can be added or deleted with it.
    const service = subStepSlice(entitlementSegment(), 'service');
    expect(service).toContain("t('companyEntitlements')");
    expect(service).toContain("t('addEntitlement')");
    for (const action of ['action={createPolicyAction}', 'action={updatePolicyAction}', 'action={deletePolicyAction}']) {
      expect(service.includes(action), `${action} still wired`).toBe(true);
    }
  });

  it('0d9cf710 · the duplicated Earning / Rounding front door is gone from the service sub-step', () => {
    // It rendered the SAME EarningMethodForm over the SAME policy row as General → Earning Method, so it was
    // one setting shown twice. The General mount is the survivor — both controls stay configurable there.
    const service = subStepSlice(entitlementSegment(), 'service');
    expect(service.includes('<PolicyFrontDoor')).toBe(false);
    expect(service.includes('<EarningMethodForm')).toBe(false);
    const general = panelSrc.slice(panelSrc.indexOf("{generalSubStep === 'earning' && ("));
    expect(general.indexOf('<EarningMethodForm')).toBeGreaterThan(-1);
    // …and with the only alwaysShowScope caller gone, the prop went with it (no dead capability).
    expect(panelSrc.includes('alwaysShowScope')).toBe(false);
  });

  it('a persisted pointer at the retired Eligibility step or Company Entitlements tab lands on Service', () => {
    // Without a remap the stored value no longer matches STEP_KEYS / the sub-step keys and would snap back
    // to step 1 (or sub-step 1) with no explanation.
    expect(panelSrc).toContain("const RETIRED_ELIGIBILITY_STEP = 'eligibility'");
    expect(panelSrc).toContain('parsed.activeStep === RETIRED_ELIGIBILITY_STEP');
    // …and the legacy accordion shape ({ eligibility: true }) gets the same treatment.
    expect(panelSrc).toContain('parsed[RETIRED_ELIGIBILITY_STEP] === true');
    // The remap WINS over any stored entitlementSubStep, otherwise the user would not see the content.
    expect(panelSrc).toContain('!wantedEligibility');
    // bc9be1e8's own remap: the retired sub-step key resolves to where its content went.
    expect(panelSrc).toContain("const RETIRED_COMPANY_ENTITLEMENTS_SUB_STEP = 'policies'");
    expect(panelSrc).toContain('parsed.entitlementSubStep === RETIRED_COMPANY_ENTITLEMENTS_SUB_STEP');
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
