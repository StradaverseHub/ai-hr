/**
 * Restructure Leave Condition Secondary Workflow (feedback 08bc6841).
 *
 * The Condition step (storage key 'ess'; step 4 of the c979aa8b workspace flow, step 2 since b8fcae73
 * dropped Eligibility and reordered the walk) becomes a guided
 * THREE-SUB-STEP walk — 1 Criteria · 2 Leave Application Rules · 3 Expiry — switched by the SAME reusable
 * SubStepBar the General restructure introduced (components/leave-sub-step-bar.tsx, the e1a51aea reuse
 * contract: secondary flows must REUSE it, never reinvent a nested bar). The active sub-step persists per
 * type alongside activeStep/generalSubStep in the leaveTypeCards:<id> localStorage shape
 * (backward-compatible: older payloads still hydrate, essSubStep defaults to Criteria).
 *
 * Content contract (arrangement only — every form keeps its exact fields, tri-state marker, validation and
 * save behaviour):
 *  - Criteria: the eligibility rules moved here from the main Eligibility step — gender / marital
 *    ChipMultiSelects, min-service (value + unit), probation — same eligibility=1 marker, same
 *    updateTypeAction, values untouched. That left the Eligibility step holding only entitlement policies,
 *    which is why b8fcae73 later removed the step outright and moved the policies timeline into the
 *    Entitlement step's Company Entitlements sub-step (see leave-entitlement-substeps.test.ts).
 *  - Leave Application Rules: the SEVEN existing rule groups re-laid as a responsive card grid
 *    (grid-cols-1 md:grid-cols-2 xl:grid-cols-3) in the existing source order — durations, document,
 *    negativeBalance, backdating (EMERGENCY-hidden), minAdvance (EMERGENCY-hidden), duplicatePolicy,
 *    dayTypeInclusion — each group one card with its own edit marker so saves stay per-group. PLUS the
 *    company-wide Half-Day Deduction card relocated from the Application Rules tab (single home now):
 *    per-company rows posting the SAME setLeaveHalfDayFullDeductionAction (write unchanged; the action
 *    redirects to the Entitlements route per the R45/R61 relocation precedent), marked with an
 *    applies-company-wide badge.
 *  - Expiry: the fec49317 age-from-earning expiry moved here from Eligibility — same expiry=1 marker, same
 *    non-Annual/non-EMERGENCY gate. Annual types see a pointer to General → Carry Forward Policy (their
 *    carry-expiry stays there); Emergency Leave gets a no-balance note instead of a dead form.
 *
 * Static source guard (the repo convention for this DOM-runner-less component; see
 * leave-type-config-categories.test.ts / leave-type-general-substeps.test.ts). Browser verification covers
 * the interactive switching, each rule group's edit/save in the grid, the half-day round-trip and mobile
 * stacking — that assignment is not optional.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_ASSIGNMENT_CRITERIA } from '../core/leave-org-criteria';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
// 1e4eb8af retired the Application Rules tab entirely; the route is a redirect stub now, so the
// "half-day card is gone from there" guard below holds a fortiori — kept as the tripwire against the card
// ever being re-added to that route.
const appRulesSrc = readFileSync(resolve(here, '../app/admin/leave/application-rules/page.tsx'), 'utf8');
const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const ESS_SUB_STEP_KEYS = ['criteria', 'rules', 'expiry'] as const;

/** Slice the Condition card's segment (its CardTitle to the Custom card's CardTitle). */
function essSegment(): string {
  const start = panelSrc.indexOf("<CardTitle>{t('categoryEssPolicy')}</CardTitle>");
  const end = panelSrc.indexOf("<CardTitle>{t('categoryCustom')}</CardTitle>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return panelSrc.slice(start, end);
}

/** Slice the Entitlement card's segment (its CardTitle to the Condition card's CardTitle) — where
 *  b8fcae73 relocated the entitlement policy timeline that used to live on the retired Eligibility card. */
function entitlementSegment(): string {
  const start = panelSrc.indexOf("<CardTitle>{t('categoryEntitlement')}</CardTitle>");
  const end = panelSrc.indexOf("<CardTitle>{t('categoryEssPolicy')}</CardTitle>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return panelSrc.slice(start, end);
}

/** Slice one sub-step's gated block out of the Condition segment. */
function subStepSlice(seg: string, key: (typeof ESS_SUB_STEP_KEYS)[number]): string {
  const start = seg.indexOf(`{essSubStep === '${key}' && (`);
  expect(start, `sub-step '${key}' gate present`).toBeGreaterThan(-1);
  const i = ESS_SUB_STEP_KEYS.indexOf(key);
  const next = i + 1 < ESS_SUB_STEP_KEYS.length ? seg.indexOf(`{essSubStep === '${ESS_SUB_STEP_KEYS[i + 1]}' && (`) : seg.length;
  expect(next).toBeGreaterThan(start);
  return seg.slice(start, next);
}

describe('08bc6841 · the Condition step REUSES the SubStepBar (three sub-steps in walk order)', () => {
  it('renders the shared SubStepBar inside the Condition card — no reinvented nested bar', () => {
    expect(panelSrc).toContain("const ESS_SUB_STEP_KEYS = ['criteria', 'rules', 'expiry'] as const");
    const seg = essSegment();
    expect(seg).toContain('<SubStepBar');
    expect(seg).toContain('ESS_SUB_STEP_KEYS.map((k) => ({ key: k, label: t(ESS_SUB_STEP_TITLE_KEY[k]) }))');
    // Exactly one sub-step's content renders at a time — each gates its own block.
    for (const key of ESS_SUB_STEP_KEYS) {
      expect(seg.includes(`{essSubStep === '${key}' && (`), `sub-step '${key}' gated`).toBe(true);
    }
    // ONE SubStepBar component file serves both secondary flows — the reuse contract.
    expect(panelSrc).toMatch(/import \{ SubStepBar \} from '\.\/leave-sub-step-bar'/);
  });

  it("keeps 'ess' as the Condition step's storage key and persists essSubStep in the shared shape", () => {
    // b8fcae73 shortened + reordered the walk; 'ess' survives verbatim as Condition's storage key.
    expect(panelSrc).toContain("const STEP_KEYS = ['general', 'ess', 'entitlement', 'custom'] as const");
    // The ONE writer persists the keys together (7b945408 extended the shape with entitlementSubStep)…
    expect(panelSrc).toContain(
      'JSON.stringify({ activeStep: step, generalSubStep: sub, essSubStep: ess, entitlementSubStep: ent })',
    );
    // …and hydration tolerates an older payload (essSubStep absent ⇒ default Criteria).
    expect(panelSrc).toContain("typeof parsed.essSubStep === 'string'");
  });
});

describe('08bc6841 · Criteria — the eligibility rules moved from the Eligibility step, untouched', () => {
  it('the whole eligibility sub-form (marker, pickers, min-service, probation) lives in the criteria sub-step', () => {
    const criteria = subStepSlice(essSegment(), 'criteria');
    for (const needle of [
      '<input type="hidden" name="eligibility" value="1" />',
      'name="gender"',
      'name="maritalStatus"',
      'name="minServiceMonths"',
      'name="minServiceUnit"',
      'name="probation"',
      // 0c15db78: the non-edit view is now the criteria table, not the one-line eligibilitySummary().
      'criteriaRows()',
    ]) {
      expect(criteria.includes(needle), `${needle} inside criteria`).toBe(true);
    }
    // Same save path — the form still posts updateTypeAction (no fork, no new storage).
    expect(criteria).toContain('action={updateTypeAction}');
  });

  it('the Eligibility card is gone; its policy timeline survives inside the Entitlement card', () => {
    // b8fcae73 removed the card entirely — 08bc6841 had already emptied it of eligibility rules + expiry.
    expect(panelSrc.includes("<CardTitle>{t('categoryEligibilityEntitlement')}</CardTitle>")).toBe(false);
    const ent = entitlementSegment();
    // The rules and the expiry form live in Condition, NOT with the relocated policies.
    expect(ent.includes('name="eligibility"')).toBe(false);
    expect(ent.includes('name="expiry"')).toBe(false);
    // …and the entitlement policy timeline + add form came across intact.
    expect(ent).toContain("t('companyEntitlements')");
    expect(ent).toContain("t('addEntitlement')");
  });
});

/**
 * 0c15db78 · Display Secondary Step 1 Criteria Directly — the four eligibility rules render as a labelled
 * two-column table the moment the Criteria sub-step opens, instead of a condensed one-line summary that
 * pushed the reader into "Edit rules" to see each rule. Presentation only: no schema, no service, no new
 * translation keys (every label and value reuses a key the edit form already ships in all 6 locales).
 */
describe('0c15db78 · Criteria — the four rules shown directly, no "Edit rules" click', () => {
  const criteriaRowsBody = () => {
    const start = panelSrc.indexOf('const criteriaRows =');
    expect(start, 'criteriaRows() helper exists').toBeGreaterThan(-1);
    return panelSrc.slice(start, panelSrc.indexOf('\n  };', start));
  };

  it('renders the non-edit view as a headerless two-column table over criteriaRows()', () => {
    const criteria = subStepSlice(essSegment(), 'criteria');
    // The always-on table replaced the summary div; the branch is still gated on editingEligibility so
    // "Edit rules" keeps swapping in the untouched form.
    expect(criteria).toContain('{criteriaRows().map((row) => (');
    expect(criteria).toContain('{row.label}');
    expect(criteria).toContain('{row.value}');
    expect(criteria).toContain('editingEligibility ? (');
    // Headerless by construction — a Criterion/Value header row is the only thing that would need new keys.
    expect(criteria.includes('<thead')).toBe(false);
  });

  it('derives one row per criterion in order, each from an existing translation key', () => {
    const body = criteriaRowsBody();
    const order = [
      'eligibilityMaritalLabel',
      'eligibilityGenderLabel',
      'eligibilityMinServiceLabel',
      'eligibilityProbationLabel',
    ];
    let cursor = -1;
    for (const key of order) {
      const at = body.indexOf(`t('${key}')`);
      expect(at, `${key} labels a row`).toBeGreaterThan(cursor);
      cursor = at;
    }
    // Values reuse the edit form's own label helpers and the min-service unit keys.
    expect(body).toContain('joinOr(asEligList(eligibility?.maritalStatus), maritalLabel)');
    expect(body).toContain('joinOr(asEligList(eligibility?.gender), genderLabel)');
    expect(body).toContain("eligibility.minServiceUnit === 'days' ? t('expiryUnitDays') : t('expiryUnitMonths')");
    expect(body).toContain("t('eligibilityProbationConfirmedOnly')");
    expect(body).toContain("t('eligibilityProbationProbationOnly')");
  });

  it('uses ONE shared empty marker for every unset rule, guards a stored 0, and never swallows unknown values', () => {
    const body = criteriaRowsBody();
    // ONE existing key ("No restriction") for all four empty cells — not a mix of Any / N/A, and not a
    // newly invented key.
    expect(body).toContain("const noRestriction = t('eligibilityProbationNone');");
    expect(body.includes("t('eligibilityGenderAny')")).toBe(false);
    expect(body.includes("t('eligibilityMaritalAny')")).toBe(false);
    expect(body.includes("t('criteriaNa')")).toBe(false);
    // Same falsy guard as the old summary — a stored 0 reads "No restriction", never "0 Months".
    expect(body).toContain('eligibility?.minServiceMonths\n      ?');
    // Unmappable-value guard: fall back to the raw stored value, show the marker only on an empty list.
    expect(body).toContain('values.length === 0 ? noRestriction');
    expect(body).toContain('label(v) ?? v');
  });

  it('drops the dead one-line summary helpers it replaced', () => {
    for (const dead of ['const eligibilitySummary =', 'eligibilitySummary()', 'const orJoin =']) {
      expect(panelSrc.includes(dead), `${dead} removed`).toBe(false);
    }
    // …while the still-used join key stays.
    expect(panelSrc).toContain("t('eligibilitySummaryOr')");
  });

  it('adds no new translation keys — every key the table uses already ships in all 6 locales', () => {
    const used = [
      'eligibilityMaritalLabel',
      'eligibilityGenderLabel',
      'eligibilityMinServiceLabel',
      'eligibilityProbationLabel',
      'eligibilityProbationNone',
      'eligibilityProbationConfirmedOnly',
      'eligibilityProbationProbationOnly',
      'eligibilitySummaryOr',
      'expiryUnitMonths',
      'expiryUnitDays',
    ];
    for (const locale of LOCALES) {
      const msgs = readFileSync(resolve(here, `../messages/${locale}.json`), 'utf8');
      for (const key of used) {
        expect(msgs.includes(`"${key}"`), `${key} in ${locale}`).toBe(true);
      }
    }
  });
});

/**
 * Enhance Leave Criteria Configuration — the eight catalogue-backed Organisation Assignment fields join the
 * Criteria selector ALONGSIDE gender / marital / min-service / probation. ONE descriptor
 * (core/leave-org-criteria.ts ORG_ASSIGNMENT_CRITERIA) drives the picker, the read-only summary row and the
 * gates, so this suite asserts the panel iterates that descriptor (not eight hand-wired blocks) and that every
 * reused label key already ships in all six locales — zero new translation strings.
 */
describe('org-criteria · the eight Organisation Assignment fields join the Criteria selector', () => {
  const EXPECTED_KEYS = [
    'orgDivision',
    'orgBranch',
    'orgRegion',
    'orgLine',
    'orgSection',
    'orgTeam',
    'orgBase',
    'employmentCategory',
  ];

  it('the descriptor carries exactly the eight catalogue-backed org fields (no typed-field creep)', () => {
    expect(ORG_ASSIGNMENT_CRITERIA.map((c) => c.key)).toEqual(EXPECTED_KEYS);
    // The five DEFERRED typed fields must NOT appear in this tranche's descriptor.
    for (const deferred of ['businessUnitId', 'departmentId', 'positionId', 'employmentType', 'gradeId']) {
      expect(ORG_ASSIGNMENT_CRITERIA.some((c) => (c.key as string) === deferred)).toBe(false);
    }
  });

  it('renders one ChipMultiSelect per org field from the single descriptor (eight names), inside Criteria', () => {
    const criteria = subStepSlice(essSegment(), 'criteria');
    // Driven by the descriptor map — one <ChipMultiSelect> emitting name={c.key} per entry (the same
    // one-hidden-input-per-value FORM contract gender/marital use, so the action's getAll(key) reads them).
    expect(criteria).toContain('ORG_ASSIGNMENT_CRITERIA.map((c) => (');
    expect(criteria).toContain('name={c.key}');
    expect(criteria).toContain('defaultSelected={asEligList(eligibility?.[c.key])}');
    // Picker values are the ACTIVE catalogue unioned with any already-stored value (survive re-save).
    expect(criteria).toContain('options={orgCriterionOptions(c.category, c.key)}');
    expect(panelSrc).toContain("import { ORG_ASSIGNMENT_CRITERIA, type OrgAssignmentCriterionKey } from '@/core/leave-org-criteria'");
  });

  it('adds one criteriaRows() summary row per org field from the same descriptor (eight rows)', () => {
    const start = panelSrc.indexOf('const criteriaRows =');
    expect(start).toBeGreaterThan(-1);
    const body = panelSrc.slice(start, panelSrc.indexOf('\n  };', start));
    // The four existing rows stay, then the org rows come from the descriptor map with the reused label.
    expect(body).toContain('...ORG_ASSIGNMENT_CRITERIA.map((c) => {');
    expect(body).toContain('tOrg(c.labelKey)');
    expect(body).toContain('joinOr(asEligList(eligibility?.[c.key]), orgLabel)');
  });

  it('reuses the existing profile-option category labels — every label key resolves in all six locales', () => {
    for (const locale of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${locale}.json`), 'utf8'));
      const cat = msgs?.admin?.profileOptions?.category ?? {};
      for (const c of ORG_ASSIGNMENT_CRITERIA) {
        expect(typeof cat[c.labelKey], `${locale}.admin.profileOptions.category.${c.labelKey}`).toBe('string');
        expect((cat[c.labelKey] as string).length, `${locale} ${c.labelKey} non-empty`).toBeGreaterThan(0);
      }
    }
    // The scoped translator the panel uses to resolve them (no new admin.leave keys minted).
    expect(panelSrc).toContain("const tOrg = useTranslations('admin.profileOptions.category');");
  });

  it('the entitlements page feeds active-only catalogue values, keyed by category, to every panel', () => {
    expect(pageSrc).toContain('listAllProfileOptions(s, { activeOnly: true })');
    expect(pageSrc).toContain('const orgAssignmentOptions = Object.fromEntries(');
    expect(pageSrc).toContain('orgAssignmentOptions={orgAssignmentOptions}');
  });

  it('the save action reads one getAll() array per org field, from the same descriptor', () => {
    expect(actionsSrc).toContain('for (const c of ORG_ASSIGNMENT_CRITERIA) {');
    expect(actionsSrc).toContain("eligibility[c.key] = fd.getAll(c.key).map(String);");
  });
});

describe('08bc6841 · Leave Application Rules — the seven rule groups as a card grid', () => {
  const RULE_MARKERS = [
    'name="durations"',
    'name="document"',
    'name="negativeBalance"',
    'name="backdating"',
    'name="minAdvance"',
    'name="duplicatePolicy"',
    'name="dayTypeInclusion"',
  ] as const;

  it('the grid renders inside the rules sub-step with the responsive column classes', () => {
    const rules = subStepSlice(essSegment(), 'rules');
    expect(rules).toContain('grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3');
  });

  it('all seven rule groups sit inside the grid, in the existing source order, markers intact', () => {
    const rules = subStepSlice(essSegment(), 'rules');
    let cursor = -1;
    for (const marker of RULE_MARKERS) {
      const at = rules.indexOf(`<input type="hidden" ${marker} value="1" />`);
      expect(at, `${marker} tri-state marker inside the rules grid`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('the EMERGENCY gates on backdating + advance-notice survive the re-layout (the EL config-trap)', () => {
    const rules = subStepSlice(essSegment(), 'rules');
    // Both gated groups still render only for non-EMERGENCY types.
    const gates = rules.match(/\{code !== 'EMERGENCY' && \(/g) ?? [];
    expect(gates.length).toBe(2);
    // And each gate wraps its own group: backdating first, then minAdvance.
    const g1 = rules.indexOf("{code !== 'EMERGENCY' && (");
    const g2 = rules.indexOf("{code !== 'EMERGENCY' && (", g1 + 1);
    expect(rules.indexOf('name="backdating"')).toBeGreaterThan(g1);
    expect(rules.indexOf('name="backdating"')).toBeLessThan(g2);
    expect(rules.indexOf('name="minAdvance"')).toBeGreaterThan(g2);
  });

  it('the relocated Half-Day Deduction card (halfDaySection slot) completes the grid', () => {
    const rules = subStepSlice(essSegment(), 'rules');
    expect(rules).toContain('{halfDaySection}');
    // Slot-shaped prop, like the other server-composed sections.
    expect(panelSrc).toContain('halfDaySection?: ReactNode');
  });
});

describe('08bc6841 · Half-Day Deduction relocation — single home, same write', () => {
  it('the Application Rules tab no longer renders the half-day card (title, rows, action all gone)', () => {
    expect(appRulesSrc.includes('setLeaveHalfDayFullDeductionAction')).toBe(false);
    expect(appRulesSrc).not.toMatch(/SectionHeader title=\{t\('halfDayDeductionTitle'\)\}/);
    expect(appRulesSrc.includes('leaveHalfDayFullDeduction')).toBe(false);
  });

  it('the Entitlements page composes the per-company rows with the SAME action and field names + the badge', () => {
    const start = pageSrc.indexOf('const halfDaySection = (');
    expect(start).toBeGreaterThan(-1);
    const section = pageSrc.slice(start, pageSrc.indexOf('return (', start));
    expect(section).toContain('action={setLeaveHalfDayFullDeductionAction}');
    // Identical FormData contract to the old card: companyId hidden + `enabled` checkbox.
    expect(section).toContain('<input type="hidden" name="companyId" value={c.id} />');
    expect(section).toContain('name="enabled"');
    expect(section).toContain('defaultChecked={!!c.leaveHalfDayFullDeduction}');
    // The company-wide marker + the existing half-day strings.
    expect(section).toContain("t('conditionStep.halfDayCompanyWideBadge')");
    expect(section).toContain("t('halfDayDeductionTitle')");
    expect(section).toContain("t('halfDayDeductionFrozenNote')");
    // ONE shared node passed into every panel via the slot prop.
    expect(pageSrc).toContain('halfDaySection={halfDaySection}');
  });

  it('the action keeps the SAME core write and now redirects to the Entitlements route (R45/R61 precedent)', () => {
    const fnStart = actionsSrc.indexOf('export async function setLeaveHalfDayFullDeductionAction');
    expect(fnStart).toBeGreaterThan(-1);
    const fn = actionsSrc.slice(fnStart, actionsSrc.indexOf('\n}', fnStart));
    expect(fn).toMatch(/setLeaveHalfDayFullDeduction\(s, \{/);
    expect(fn).toMatch(/companyId: String\(formData\.get\('companyId'\)\)/);
    expect(fn).toMatch(/enabled: formData\.get\('enabled'\) === 'on'/);
    expect(fn).toMatch(/fail\(ENTITLEMENTS, e\)/);
    expect(fn).toMatch(/ok\(ENTITLEMENTS\)/);
  });
});

describe('08bc6841 · Expiry — moved from Eligibility, Annual points at the General carry flow', () => {
  it('the expiry sub-form lives in the expiry sub-step with its marker + non-Annual gate verbatim', () => {
    const expiry = subStepSlice(essSegment(), 'expiry');
    expect(expiry).toContain('<input type="hidden" name="expiry" value="1" />');
    expect(expiry).toContain("{!isAnnual && code !== 'EMERGENCY' && (");
    expect(expiry).toContain('name="expiryValue"');
    expect(expiry).toContain('name="expiryUnit"');
    expect(expiry).toContain('action={updateTypeAction}');
  });

  it('Annual shows the carry-forward pointer; Emergency shows the no-balance note (no dead forms)', () => {
    const expiry = subStepSlice(essSegment(), 'expiry');
    expect(expiry).toContain('{isAnnual && (');
    expect(expiry).toContain("t('conditionStep.expiryAnnualPointer')");
    expect(expiry).toContain("{!isAnnual && code === 'EMERGENCY' && (");
    expect(expiry).toContain("t('conditionStep.expiryEmergencyNote')");
  });
});

describe('08bc6841 · i18n — all six locales', () => {
  it('carries the condition sub-step keys in each locale (en pins the reported wording)', () => {
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8'));
    expect(en.admin.leave.conditionStep.criteria).toBe('Criteria');
    expect(en.admin.leave.conditionStep.rules).toBe('Leave Application Rules');
    expect(en.admin.leave.conditionStep.expiry).toBe('Expiry');
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      expect(typeof leave.conditionStepsLabel, `${loc} conditionStepsLabel`).toBe('string');
      const sub = leave.conditionStep ?? {};
      for (const key of [
        'criteria',
        'rules',
        'expiry',
        'halfDayCompanyWideBadge',
        'expiryAnnualPointer',
        'expiryEmergencyNote',
      ]) {
        expect(typeof sub[key], `${loc}.admin.leave.conditionStep.${key}`).toBe('string');
        expect((sub[key] as string).length, `${loc}.admin.leave.conditionStep.${key} non-empty`).toBeGreaterThan(0);
      }
      // The relocated card reuses the existing half-day strings — they must stay present.
      for (const key of ['halfDayDeductionTitle', 'halfDayDeductionHelp', 'halfDayDeductionFrozenNote', 'halfDayDeductionToggleLabel']) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
      }
    }
  });
});
