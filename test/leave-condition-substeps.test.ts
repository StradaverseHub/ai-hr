/**
 * Restructure Leave Condition Secondary Workflow (feedback 08bc6841), plus the two layout follow-ups the
 * reporter filed against the result: 165baee5 (Criteria configurable in place, no "Edit rules" hop) and
 * f6d3be0b (Leave Application Rules fills the panel instead of stranding whitespace). Both are arrangement
 * only — every form below keeps its fields, tri-state marker, validation and save behaviour.
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
 *    updateTypeAction, values untouched; 165baee5 later made them render live instead of behind an
 *    "Edit rules" toggle. That left the Eligibility step holding only entitlement policies,
 *    which is why b8fcae73 later removed the step outright and moved the policies timeline into the
 *    Entitlement step's Company Entitlements sub-step (see leave-entitlement-substeps.test.ts).
 *  - Leave Application Rules: the SEVEN existing rule groups re-laid as a responsive card flow
 *    (f6d3be0b: balanced columns-1 md:columns-2 xl:columns-3) in the existing source order — durations, document,
 *    negativeBalance, backdating (EMERGENCY-hidden), minAdvance (EMERGENCY-hidden), duplicatePolicy,
 *    dayTypeInclusion — each group one card with its own edit marker so saves stay per-group. PLUS the
 *    company-wide Half-Day Deduction card relocated from the Application Rules tab (single home now),
 *    marked with an applies-company-wide badge. 10e96227 then replaced its per-company rows with ONE
 *    ChipMultiSelect over companyIds + ONE Save posting setLeaveHalfDayFullDeductionCompaniesAction; the
 *    stored shape is still one boolean per company, and the retired per-row action is asserted absent.
 *
 * c459bff9 REMOVED the third sub-step (Expiry) outright — for EVERY leave type, including the
 * explanatory-text variants Annual and Emergency saw. The sub-step bar is built unconditionally from
 * ESS_SUB_STEP_KEYS, so shortening that list is what makes the step disappear everywhere; only the
 * number+unit FORM was ever behind the !isAnnual && code !== 'EMERGENCY' gate. Condition is now TWO steps.
 * A tripwire below asserts the panel source carries no expiry form fields, so the step cannot creep back
 * in by accident. NOTE the Criteria test 'adds no new translation keys…' still pins expiryUnitMonths /
 * expiryUnitDays: those two keys SURVIVE because the Criteria sub-step's Min Service unit select
 * deliberately reuses them.
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
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2), which is what this whole item was raised about. The panel
 * became three files, so what this guard scans is their concatenation — the property it pins is about the
 * leave TYPE screen, not about one filename, and pinning it to a file that no longer exists would have
 * taken the guard out rather than moved it.
 */
const LEAVE_TYPE_SCREEN = [
  'app/admin/leave-config/types/page.tsx',
  'app/admin/leave-config/types/leave-type-tabs.tsx',
  'app/admin/leave-config/types/leave-type-sub-forms.tsx',
];
const panelSrc = LEAVE_TYPE_SCREEN.map((f) => readFileSync(resolve(here, '..', f), 'utf8')).join('\n');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave-config/types/page.tsx'), 'utf8');
// 1e4eb8af retired the Application Rules tab entirely; the route is a redirect stub now, so the
// "half-day card is gone from there" guard below holds a fortiori — kept as the tripwire against the card
// ever being re-added to that route.
const appRulesSrc = readFileSync(resolve(here, '../app/admin/leave/application-rules/page.tsx'), 'utf8');
const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');
// b55fdf33 — the half-day picker now lives behind a client wrapper (a server component may not pass
// function props across the boundary). The form contract it owns is asserted against this file.
const pickerSrc = readFileSync(resolve(here, '../components/leave/half-day-company-picker.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/**
 * ⚠️ a6fe37fc ROUND 5 — WHERE THE CONDITION STEP'S TWO SUB-STEPS WENT, and why this file did not shrink.
 *
 * The migration order's Round 2 table names this guard by name and says where each half of its case goes:
 * **Criteria becomes Tab 2** (`eligibility` — who may take this leave type at all), and the application
 * rule cards SPLIT — the balance card to Tab 3 (it is not an application rule, it is what an application
 * is measured against), the company half-day slot to Company rules (it is a COMPANY decision that was
 * being drawn once per leave type), and the rest to **Tab 4** (`application` — how it is applied for).
 *
 * So `essSegment()` becomes the two tabs that inherited the step, and `subStepSlice` becomes a tab
 * lookup. Every assertion below is unchanged in substance: the same fields, the same tri-state markers,
 * the same EMERGENCY gates, the same layout promises, the same expiry TRIPWIRE.
 */
const TABS = ['identity', 'eligibility', 'entitlement', 'application', 'approvers'] as const;
const tabsSrc = readFileSync(resolve(here, '../app/admin/leave-config/types/leave-type-tabs.tsx'), 'utf8');
const companyRulesSrc = readFileSync(
  resolve(here, '../app/admin/leave-config/company-rules/page.tsx'),
  'utf8',
);

/** Slice ONE tab's rendered block: from its own gate to the next tab's. */
function tabSegment(key: (typeof TABS)[number]): string {
  const start = tabsSrc.indexOf(`{activeTab === '${key}' && (`);
  expect(start, `tab '${key}' has no gated block`).toBeGreaterThan(-1);
  const next = TABS.slice(TABS.indexOf(key) + 1)
    .map((k) => tabsSrc.indexOf(`{activeTab === '${k}' && (`))
    .find((i) => i > start);
  return tabsSrc.slice(start, next ?? tabsSrc.length);
}

/** The two tabs that inherited the Condition step — the successor of the old `essSegment()`. */
function essSegment(): string {
  return `${tabSegment('eligibility')}\n${tabSegment('application')}`;
}

/** The tab that inherited the Entitlement step. */
function entitlementSegment(): string {
  return tabSegment('entitlement');
}

/** Criteria → tab 2, Leave Application Rules → tab 4. The successor of the old sub-step slice. */
function subStepSlice(_seg: string, key: 'criteria' | 'rules'): string {
  return key === 'criteria' ? tabSegment('eligibility') : tabSegment('application');
}

describe('08bc6841 · the Condition step REUSES the SubStepBar (two sub-steps in walk order, c459bff9)', () => {
  it('the two sub-steps are TABS now, each gating its own block — no nested bar was reinvented', () => {
    // 08bc6841's reuse contract was "secondary flows REUSE the SubStepBar, never reinvent a nested bar".
    // a6fe37fc removed the nesting entirely: Criteria and Leave Application Rules are two of five tabs on
    // ONE bar, which is the strongest possible form of "no second bar". The component itself survives and
    // is still mounted by Generate entitlement and Adjustments — see leave-type-general-substeps.test.ts.
    expect(tabsSrc).toContain(
      "export const TAB_KEYS = ['identity', 'eligibility', 'entitlement', 'application', 'approvers'] as const",
    );
    for (const key of ['eligibility', 'application'] as const) {
      expect(tabsSrc.includes(`{activeTab === '${key}' && (`), `tab '${key}' gated`).toBe(true);
    }
    expect(tabsSrc).not.toContain('<SubStepBar');
    expect(tabsSrc).not.toContain('ESS_SUB_STEP_KEYS');
  });

  it("a browser holding the retired 'ess' step key is REMAPPED onto the tab that inherited it", () => {
    // The compatible-migration promise, carried across. 'ess' was Condition's historical storage key and
    // an administrator's browser may still hold it; the new screen sends `ess` → Criteria's tab and each
    // retired sub-step to the tab that took it, rather than snapping back to tab 1.
    expect(tabsSrc).toContain("typeof parsed.essSubStep === 'string'");
    const table = tabsSrc.slice(
      tabsSrc.indexOf('const RETIRED_ESS_SUB_STEP_TO_TAB'),
      tabsSrc.indexOf('const RETIRED_ESS_SUB_STEP_TO_TAB') + 400,
    );
    expect(table).toMatch(/criteria: 'eligibility'/);
    expect(table).toMatch(/rules: 'application'/);
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
      // 165baee5: every control renders unconditionally — there is no non-edit view left to fall back to.
      'grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3',
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
    // 6e9a126e RELEASE THREE — the "policy timeline + add form came across intact" assertion is gone with
    // the timeline. It rendered leave_policy rows per company; 0410 drops that table, so there is nothing
    // left to have come across. The rest of this case — that eligibility and expiry stayed in Condition
    // rather than following the policies — is the part that was ever about THIS item, and it is untouched.
    // 6e9a126e RELEASE THREE — the 'add entitlement' form was the leave_policy timeline's own writer.
    // 0410 drops the table; the form went with it, and entitlement is written on the Entitlement
    // Tables screen now. The half of this case that still holds — the Eligibility card being gone,
    // and eligibility/expiry staying in Condition rather than following the policies — is above.
  });
});

/**
 * 165baee5 · Enhance Leave Condition Configuration Display Layout — supersedes 0c15db78.
 *
 * 0c15db78 made the criteria READABLE without a click by rendering a read-only two-column table over a
 * criteriaRows() helper, with "Edit rules" still swapping in the form to CHANGE anything. 165baee5 removes
 * that last hop: the configurable controls themselves render the moment the Criteria sub-step opens, laid
 * out as one labelled control per criterion on a responsive grid (marital status, gender, minimum service,
 * probation, then the eight Organisation Assignment fields). The read-only table and its helper are gone —
 * they described exactly the values the live controls now show.
 *
 * Presentation only: same single <form>, same eligibility=1 tri-state marker, same updateTypeAction, no
 * schema and no change to how eligibility is evaluated. Saving stays an EXPLICIT Save — auto-saving each
 * dropdown would let a mis-click silently change who may take leave. No new translation keys.
 */
describe('165baee5 · Criteria — the configurable fields shown directly, no "Edit rules" hop', () => {
  it('renders ONE always-live form: no edit-mode toggle, no read-only summary to fall back to', () => {
    const criteria = subStepSlice(essSegment(), 'criteria');
    // The toggle, its button and the branch it drove are gone from the whole panel…
    for (const dead of [
      'editingEligibility',
      'setEditingEligibility',
      'const criteriaRows =',
      'criteriaRows()',
    ]) {
      expect(panelSrc.includes(dead), `${dead} removed`).toBe(false);
    }
    // …and Criteria no longer offers "Edit rules". a6fe37fc Round 5 — the key's LAST consumer (the Day
    // Type Inclusion card's own edit toggle) went with the panel rewrite, so the assertion that it
    // survives elsewhere is dropped rather than inverted: what 165baee5 cared about is that this screen
    // has no edit-mode hop, and it now has none anywhere.
    expect(criteria.includes("t('eligibilityEdit')")).toBe(false);
    expect(panelSrc.includes("t('eligibilityEdit')")).toBe(false);
    // One form, unconditional, on the unchanged save path with the unchanged tri-state marker.
    expect(criteria).toContain('<form action={updateTypeAction}');
    expect(criteria).toContain('<input type="hidden" name="eligibility" value="1" />');
    // Explicit save retained; the Cancel that only existed to leave edit mode is gone.
    expect(criteria).toContain('<Button type="submit" size="sm">');
    expect(criteria.includes("t('cancel')")).toBe(false);
  });

  it('lays every criterion out as a labelled control on a grid that collapses to one column on a phone', () => {
    const criteria = subStepSlice(essSegment(), 'criteria');
    // grid-cols-1 is the phone promise; the wider breakpoints are what stops the controls stranding the
    // panel's width (the flex-wrap row they replaced wrapped raggedly instead).
    expect(criteria).toContain('grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3');
    expect(criteria.includes('flex flex-wrap items-end gap-2')).toBe(false);
    // No fixed-width control left to strand space inside its cell.
    expect(criteria.includes('${inputCls} w-20')).toBe(false);
    expect(criteria.includes('${inputCls} w-56')).toBe(false);
  });

  it('orders the criteria as the reporter tabulated them, each labelled by an existing key', () => {
    const criteria = subStepSlice(essSegment(), 'criteria');
    const order = [
      'eligibilityMaritalLabel',
      'eligibilityGenderLabel',
      'eligibilityMinServiceLabel',
      'eligibilityProbationLabel',
    ];
    let cursor = -1;
    for (const key of order) {
      const at = criteria.indexOf(`t('${key}')`);
      expect(at, `${key} labels a criterion, in order`).toBeGreaterThan(cursor);
      cursor = at;
    }
    // The eight Organisation Assignment pickers come last, from the single descriptor.
    expect(criteria.indexOf('ORG_ASSIGNMENT_CRITERIA.map((c) => (')).toBeGreaterThan(cursor);
  });

  it('keeps "No restriction" a spelled-out state on the two fields that can hold only one value', () => {
    const criteria = subStepSlice(essSegment(), 'criteria');
    // Probation offers it as a real option; an empty minimum service says it rather than reading blank.
    expect(criteria).toContain('<option value="">{t(\'eligibilityProbationNone\')}</option>');
    expect(criteria).toContain("placeholder={t('eligibilityProbationNone')}");
    // The multi-value pickers keep saying so in the hint that sits under them (leave empty ⇒ everyone).
    expect(criteria).toContain("t('eligibilityMultiHint')");
  });

  it('never drops a stored value from a live picker — an always-on form must not erase a rule on Save', () => {
    // ChipMultiSelect discards any defaultSelected absent from its options. With the form always live, a
    // plain Save would then silently clear a rule whose stored value is no longer offered, so every picker
    // unions the stored values onto its option list (the guard org fields already had, now shared).
    expect(panelSrc).toContain('const withStored = (options: { value: string; label: string }[], stored: string[]) => [');
    expect(panelSrc).toContain('...stored.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v })),');
    const criteria = subStepSlice(essSegment(), 'criteria');
    expect(criteria).toContain('options={withStored(');
    expect(criteria).toContain('ELIGIBILITY_MARITAL_OPTIONS.map((m) => ({ value: m, label: maritalLabel(m) ?? m })),');
    expect(criteria).toContain('ELIGIBILITY_GENDER_OPTIONS.map((g) => ({ value: g, label: genderLabel(g) ?? g })),');
    // The org fields keep their catalogue-backed variant, expressed through the same helper.
    expect(panelSrc).toContain('withStored(orgAssignmentOptions[category] ?? [], asEligList(eligibility?.[key]))');
  });

  it('adds no new translation keys, and retires the one the deleted summary was the sole consumer of', () => {
    const used = [
      'eligibilityMaritalLabel',
      'eligibilityGenderLabel',
      'eligibilityMinServiceLabel',
      'eligibilityProbationLabel',
      'eligibilityProbationNone',
      'eligibilityProbationConfirmedOnly',
      'eligibilityProbationProbationOnly',
      'eligibilityMultiHint',
      'expiryUnitMonths',
      'expiryUnitDays',
    ];
    for (const locale of LOCALES) {
      const leave = JSON.parse(readFileSync(resolve(here, `../messages/${locale}.json`), 'utf8')).admin.leave;
      for (const key of used) {
        expect(typeof leave[key], `${key} in ${locale}`).toBe('string');
      }
      // criteriaRows()'s "or" joiner had no other caller — it goes with it rather than lingering as an orphan.
      expect(leave.eligibilitySummaryOr, `${locale}.admin.leave.eligibilitySummaryOr retired`).toBeUndefined();
    }
    expect(panelSrc.includes("t('eligibilitySummaryOr')")).toBe(false);
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

  it('renders each org criterion EXACTLY once, labelled from the same descriptor (165baee5)', () => {
    // Before 165baee5 each org field appeared twice — once as a picker, once as a read-only summary row
    // built by criteriaRows(). Now the live picker IS the display, so a second rendering would be a
    // duplicated (and immediately stale) copy of the same rule.
    const criteria = subStepSlice(essSegment(), 'criteria');
    expect(criteria.split('ORG_ASSIGNMENT_CRITERIA.map(').length - 1).toBe(1);
    expect(criteria).toContain('label={tOrg(c.labelKey)}');
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
    // 56910869 — Override Leave Application, between Advance Notice and Duplicate Leave Applications
    // exactly as the reporter placed it. Its position in this list IS the placement assertion: the loop
    // below walks the markers in source order and fails if any card moves.
    'name="overrideRules"',
    'name="duplicatePolicy"',
    'name="dayTypeInclusion"',
  ] as const;

  /**
   * f6d3be0b · the card layout fills the panel instead of stranding whitespace. A CSS grid row is as tall
   * as its tallest card, so a short card beside a tall one left a block of dead space underneath it. The
   * flow is now multi-column: cards pack and the columns balance, while STILL collapsing 3 → 2 → 1 by
   * breakpoint — a fix that only widened the layout would move the same gap onto a narrower screen. Each
   * card is also ONE surface now (border + fill + padding) rather than a padded box inside a padded box.
   * Arrangement only: every rule group, marker, gate and action below is unchanged.
   */
  it('the rules sub-step flows the cards in balanced columns that collapse to one on a phone', () => {
    const rules = subStepSlice(essSegment(), 'rules');
    expect(rules).toContain('columns-1 gap-3 md:columns-2 xl:columns-3');
    // The height-locked grid it replaced must not come back.
    expect(rules.includes('grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3')).toBe(false);
    // Every card opts out of being split across a column boundary — one card, one column.
    // Feedback c6ffa725 added a NINTH: the Application Limits card (the per-YEAR maximum). c6ffa725
    // REVISION 2 adds the TENTH, Maximum Consecutive Leave (the per-APPLICATION maximum + its unit) — the
    // half of the same request that r86a did not ship. The count is asserted rather than ">= 1" on purpose
    // — a card that forgets the opt-out is invisible until a browser splits it across a column boundary,
    // so a new card must come here and say so. This is that saying-so.
    //
    // 56910869 adds the ELEVENTH: Override Leave Application — what the system does when one of the rules
    // in this grid is NOT met. It is the one card that is about the others, which is why the reporter
    // placed it below Advance Notice and above Duplicate Leave Applications rather than at the end; that
    // position is asserted separately below.
    const cards = rules.split('break-inside-avoid').length - 1;
    expect(cards, 'every rule card (plus the half-day slot wrapper) carries break-inside-avoid').toBe(11);
  });

  it('each rule card is a single surface — no padded box nested inside a padded box', () => {
    const rules = subStepSlice(essSegment(), 'rules');
    // The card carries the border + fill + padding…
    expect(rules).toContain('rounded-lg border border-border bg-background p-3');
    // …and the form inside it carries only spacing, so the fields keep the card's full width.
    expect(rules).toContain('<form action={updateTypeAction} className="space-y-2">');
    expect(rules.includes('className="space-y-2 rounded-lg bg-background p-3"')).toBe(false);
    // No fixed-width number box stranding the rest of its row.
    expect(rules.includes('${inputCls} w-24')).toBe(false);
  });

  it('the rule groups sit inside the grid in source order, and the BALANCE card moved to tab 3', () => {
    // ⚠️ a6fe37fc ROUND 5 SPLIT THIS LIST, DELIBERATELY, and the migration order says why: the negative
    // balance card is NOT an application rule — it is what an application is measured against, so it
    // belongs with the day tables that decide the balance (Tab 3). The remaining cards keep their exact
    // source order on Tab 4, which is what this loop has always been about: a card that moves is a card
    // an administrator has to hunt for.
    const rules = subStepSlice(essSegment(), 'rules');
    expect(entitlementSegment(), 'the balance card must be on tab 3, with the tables').toContain(
      '<NegativeBalanceForm',
    );
    expect(rules.includes('<NegativeBalanceForm'), 'and NOT also on tab 4 — one home per card').toBe(false);
    let cursor = -1;
    for (const marker of RULE_MARKERS.filter((m) => m !== 'name="negativeBalance"')) {
      const at = rules.indexOf(`<input type="hidden" ${marker} value="1" />`);
      expect(at, `${marker} rule card inside the rules grid, in source order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('every rule group still carries its own tri-state marker somewhere in the panel', () => {
    // The markers are what stop a save of one card silently clearing another, so they are asserted on the
    // whole file — extracting a card into a component must not be able to drop one.
    for (const marker of RULE_MARKERS) {
      expect(panelSrc, `${marker} tri-state marker`).toContain(`<input type="hidden" ${marker} value="1" />`);
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

  it('the Half-Day Deduction card is on COMPANY RULES now — one home, and it is the honest one', () => {
    // ⚠️ 08bc6841 RELOCATED THIS CARD ONTO THE LEAVE TYPE AND a6fe37fc RELOCATED IT AGAIN, for the reason
    // 08bc6841's own badge always admitted: it is a COMPANY decision. Composed once and handed into every
    // leave type through the `halfDaySection` slot, it was one company setting wearing twenty-five
    // costumes (IA §2.0.3). It is drawn ONCE on Company rules now.
    //
    // The invariant 08bc6841 bought — SINGLE HOME, same write — is what is asserted, and it is stronger
    // here than it was: the slot is gone from the leave type screen entirely, so there is no second copy
    // to drift.
    const rules = subStepSlice(essSegment(), 'rules');
    expect(rules.includes('{halfDaySection}')).toBe(false);
    expect(panelSrc.includes('halfDaySection')).toBe(false);
    expect(companyRulesSrc).toContain('action={setLeaveHalfDayFullDeductionCompaniesAction}');
    expect(companyRulesSrc).toContain("t('conditionStep.halfDayCompanyWideBadge')");
  });
});

describe('08bc6841 · Half-Day Deduction relocation — single home, same write', () => {
  it('the Application Rules tab no longer renders the half-day card (title, rows, action all gone)', () => {
    expect(appRulesSrc.includes('setLeaveHalfDayFullDeductionAction')).toBe(false);
    expect(appRulesSrc).not.toMatch(/SectionHeader title=\{t\('halfDayDeductionTitle'\)\}/);
    expect(appRulesSrc.includes('leaveHalfDayFullDeduction')).toBe(false);
  });

  // 10e96227 REPLACED THE PER-COMPANY ROWS WITH ONE MULTI-SELECT. What this describe still guards is the
  // RELOCATION (08bc6841): the card has exactly one home, it is composed once and shared via the slot, and
  // it still carries the company-wide badge and the frozen note. The row-shaped assertions below were
  // rewritten rather than deleted — the contract they pinned (one post carries the decision, and the user
  // is told it is company-wide) still exists, it is just expressed over a set instead of a single row.
  it('Company rules composes ONE multi-select carrying the whole company set + the badge', () => {
    // a6fe37fc Round 5 — RE-POINTED at the screen that now draws the card. Every assertion below is the
    // one 10e96227 and b55fdf33 wrote, unchanged: one post carries the whole decision, the picker is
    // reached through the client wrapper (a server component may not hand a closure across the boundary),
    // first render reproduces today's configuration, and the write scope and the picker's option list are
    // the SAME narrow list.
    const start = companyRulesSrc.indexOf('<SectionHeader title={t(\'halfDayDeductionTitle\')} />');
    expect(start).toBeGreaterThan(-1);
    const section = companyRulesSrc.slice(start, companyRulesSrc.indexOf('</Card>', start));
    const pageSrc = companyRulesSrc;
    expect(section).toContain('action={setLeaveHalfDayFullDeductionCompaniesAction}');
    // b55fdf33 — the picker moved BEHIND A CLIENT WRAPPER. This page is a server component, and passing
    // ChipMultiSelect's label closures across that boundary threw at render and took the tab down in
    // production. The card still carries the same one-post contract; it just reaches the control through
    // HalfDayCompanyPicker, which owns the translator on the client side. See test/server-client-boundary.
    expect(section).toContain('<HalfDayCompanyPicker');
    expect(section).not.toContain('<ChipMultiSelect');
    // The posted field name lives in the wrapper now. Asserted THERE rather than dropped, because it is
    // the whole contract between this form and setLeaveHalfDayFullDeductionCompaniesAction's getAll.
    expect(pickerSrc).toContain('name="companyIds"');
    // First render must reproduce today's configuration exactly, or an unrelated save silently rewrites it.
    expect(section).toContain('selected={halfDayEnabledCompanyIds}');
    expect(pickerSrc).toContain('defaultSelected={selected}');
    expect(pageSrc).toContain(
      'const halfDayEnabledCompanyIds = halfDayCompanies.filter((c) => c.leaveHalfDayFullDeduction).map((c) => c.id);',
    );
    // The picker is scoped to companies the caller can actually WRITE, so the screen and the set-write
    // agree. Offering the page's tenant-wide `companies` here would let a company-scoped admin deselect
    // a company whose row the write can never reach.
    // The read is one element of the page's own Promise.all rather than a standalone const — the shape
    // changed with the screen, the SCOPE did not, and the scope is what this case is about.
    expect(pageSrc).toMatch(/listCompanies\(s, \{ adminOnly: true \}\)/);
    expect(section).toContain('companies={halfDayCompanies.map((c) => ({ value: c.id, label: c.name }))}');
    // The company-wide marker + the existing half-day strings, all still shown.
    expect(section).toContain("t('conditionStep.halfDayCompanyWideBadge')");
    expect(companyRulesSrc).toContain("t('halfDayDeductionTitle')");
    expect(section).toContain("t('halfDayDeductionFrozenNote')");
    // An empty selection is a real decision, so the screen must say what it means.
    expect(section).toContain("t('halfDayDeductionEmptyNote')");
    // ⚠️ THE SLOT IS GONE, and its absence is the point: 08bc6841's "ONE shared node passed into every
    // panel" was the best a per-leave-type screen could do for a company-wide setting. Company rules draws
    // it once, for the company being configured, so there is no node to share and nothing to pass.
    expect(companyRulesSrc.includes('halfDaySection={')).toBe(false);
  });

  it('the per-company action is RETIRED — nothing posts one company any more', () => {
    // The r100 precedent: a server action retires with the screen that was its only caller. Kept as an
    // assertion rather than a deletion so re-adding a second write path is a visible decision.
    expect(actionsSrc).not.toMatch(/export async function setLeaveHalfDayFullDeductionAction\b/);
    expect(pageSrc.includes('setLeaveHalfDayFullDeductionAction')).toBe(false);
  });

  it('the set action posts companyIds and redirects to the Entitlements route (R45/R61 precedent)', () => {
    const fnStart = actionsSrc.indexOf('export async function setLeaveHalfDayFullDeductionCompaniesAction');
    expect(fnStart).toBeGreaterThan(-1);
    const fn = actionsSrc.slice(fnStart, actionsSrc.indexOf('\n}', fnStart));
    expect(fn).toMatch(/setLeaveHalfDayFullDeductionCompanies\(s, \{/);
    expect(fn).toMatch(/formData\.getAll\('companyIds'\)\.map\(String\)\.filter\(Boolean\)/);
    // a6fe37fc ROUND 5 — the return target moved WITH the card. It named ENTITLEMENTS because that is
    // where the card was drawn; the card is on Company rules now, and returning to the leave type list
    // would drop the administrator on a screen that does not show what they just changed — and, on the
    // error path, show a message about a form they can no longer see (the failEntitlements reasoning).
    expect(fn).toMatch(/fail\(COMPANY_RULES, e\)/);
    expect(fn).toMatch(/ok\(COMPANY_RULES\)/);
    // No empty-post guard: [] means "applies nowhere", which must stay reachable.
    expect(fn).not.toMatch(/length === 0/);
  });
});

describe('c459bff9 · the Expiry sub-step is GONE — for every leave type, form and pointers alike', () => {
  it('the Condition card has no expiry gate, no expiry form fields and no expiry marker', () => {
    const seg = essSegment();
    // The gate itself. Shortening ESS_SUB_STEP_KEYS alone would hide the bar entry but leave a dead block.
    expect(seg).not.toContain("{essSubStep === 'expiry' && (");
    // The form. This is the tripwire: these two names are what the server action keyed the write off.
    expect(panelSrc).not.toContain('name="expiryValue"');
    expect(panelSrc).not.toContain('name="expiryUnit"');
    expect(panelSrc).not.toContain('name="expiry" value="1"');
  });

  it('the explanatory-text variants Annual and Emergency saw are gone too, not just the form', () => {
    // The reporter's complaint was that EVERY leave type showed the step. The form was behind
    // !isAnnual && code !== 'EMERGENCY'; the POINTERS were not, so removing only the form would have
    // left Annual and Emergency still looking at a third step.
    expect(panelSrc).not.toContain("t('conditionStep.expiryAnnualPointer')");
    expect(panelSrc).not.toContain("t('conditionStep.expiryEmergencyNote')");
    expect(panelSrc).not.toContain("t('expirySectionTitle')");
    expect(panelSrc).not.toContain("t('expirySectionHelp')");
    expect(panelSrc).not.toContain("t('expiryValueLabel')");
    expect(panelSrc).not.toContain("t('expiryValuePlaceholder')");
    expect(panelSrc).not.toContain("t('expiryUnitLabel')");
  });

  it('the storage columns are gone from the panel props as well as the markup', () => {
    // A prop left threaded through would keep core/read.ts projecting a column that no longer exists.
    expect(panelSrc).not.toMatch(/\bexpiryValue\b/);
    expect(panelSrc).not.toMatch(/\bexpiryUnit\b(?!Months|Days)/);
  });
});

describe('08bc6841 · i18n — all six locales', () => {
  it('carries the condition sub-step keys in each locale (en pins the reported wording)', () => {
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8'));
    expect(en.admin.leave.conditionStep.criteria).toBe('Criteria');
    expect(en.admin.leave.conditionStep.rules).toBe('Leave Application Rules');
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      expect(typeof leave.conditionStepsLabel, `${loc} conditionStepsLabel`).toBe('string');
      const sub = leave.conditionStep ?? {};
      for (const key of ['criteria', 'rules', 'halfDayCompanyWideBadge']) {
        expect(typeof sub[key], `${loc}.admin.leave.conditionStep.${key}`).toBe('string');
        expect((sub[key] as string).length, `${loc}.admin.leave.conditionStep.${key} non-empty`).toBeGreaterThan(0);
      }
      // The relocated card reuses the existing half-day strings — they must stay present. 10e96227 dropped
      // `halfDayDeductionToggleLabel` (and the On/Off state captions) with the per-row tickbox that was
      // their only caller, and added the multi-select's own copy.
      for (const key of [
        'halfDayDeductionTitle',
        'halfDayDeductionHelp',
        'halfDayDeductionFrozenNote',
        'halfDayDeductionCompaniesLabel',
        'halfDayDeductionCompaniesPlaceholder',
        'halfDayDeductionSelectAll',
        'halfDayDeductionClearAll',
        'halfDayDeductionAllSelected',
        'halfDayDeductionCountSelected',
        'halfDayDeductionEmptyNote',
      ]) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
      }
      // Retired with the per-row form — leaving them would be dead copy translators keep maintaining.
      for (const key of ['halfDayDeductionOn', 'halfDayDeductionOff', 'halfDayDeductionToggleLabel']) {
        expect(leave[key], `${loc}.admin.leave.${key} should be retired`).toBeUndefined();
      }
    }
  });

  /**
   * c459bff9 orphan guard. THE LIST IS EXPLICIT ON PURPOSE — never a substring match on "expiry".
   * `expiryUnitMonths` and `expiryUnitDays` contain the word and MUST SURVIVE: the Criteria sub-step's
   * Min Service unit select deliberately reuses them, and deleting them fails i18n-coverage check C.
   * The positive half of this pair is asserted first so the two can never drift apart.
   */
  it('retires exactly the expiry copy the deleted sub-step owned, and keeps the two shared unit keys', () => {
    const RETIRED_LEAVE = [
      'expirySectionTitle',
      'expirySectionHelp',
      'expiryValueLabel',
      'expiryValuePlaceholder',
      'expiryUnitLabel',
    ];
    const RETIRED_CONDITION_STEP = ['expiry', 'expiryAnnualPointer', 'expiryEmergencyNote'];
    const KEPT_LEAVE = ['expiryUnitMonths', 'expiryUnitDays'];
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      for (const key of KEPT_LEAVE) {
        expect(typeof leave[key], `${loc}.admin.leave.${key} MUST survive (Min Service unit select)`).toBe('string');
      }
      for (const key of RETIRED_LEAVE) {
        expect(leave[key], `${loc}.admin.leave.${key} should be retired`).toBeUndefined();
      }
      for (const key of RETIRED_CONDITION_STEP) {
        expect(
          (leave.conditionStep ?? {})[key],
          `${loc}.admin.leave.conditionStep.${key} should be retired`,
        ).toBeUndefined();
      }
      // The Scheduled Actions row for the deleted sweep goes with the sweep.
      expect(
        msgs?.scheduledActions?.jobs?.['leave-expire-aged'],
        `${loc}.scheduledActions.jobs.leave-expire-aged should be retired`,
      ).toBeUndefined();
    }
  });
});
