/**
 * Restructure Leave Condition Secondary Workflow (feedback 08bc6841).
 *
 * The Condition step (step 4 of the c979aa8b workspace flow, storage key 'ess') becomes a guided
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
 *    updateTypeAction, values untouched. The Eligibility step now focuses purely on entitlement policies.
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

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
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

/** Slice the Eligibility card's segment (its CardTitle to the Entitlement card's CardTitle). */
function eligibilitySegment(): string {
  const start = panelSrc.indexOf("<CardTitle>{t('categoryEligibilityEntitlement')}</CardTitle>");
  const end = panelSrc.indexOf("<CardTitle>{t('categoryEntitlement')}</CardTitle>");
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
    expect(panelSrc).toContain("const STEP_KEYS = ['general', 'eligibility', 'entitlement', 'ess', 'custom'] as const");
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
      'eligibilitySummary()',
    ]) {
      expect(criteria.includes(needle), `${needle} inside criteria`).toBe(true);
    }
    // Same save path — the form still posts updateTypeAction (no fork, no new storage).
    expect(criteria).toContain('action={updateTypeAction}');
  });

  it('the Eligibility card no longer hosts the eligibility rules or the expiry form (policies only)', () => {
    const elig = eligibilitySegment();
    expect(elig.includes('name="eligibility"')).toBe(false);
    expect(elig.includes('name="expiry"')).toBe(false);
    // …but keeps the entitlement policy timeline + add form.
    expect(elig).toContain("t('companyEntitlements')");
    expect(elig).toContain("t('addEntitlement')");
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
