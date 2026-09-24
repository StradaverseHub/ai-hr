/**
 * r212 (8ebf77ae) — THE TWO ELIGIBILITY SETTINGS, RECONCILED ON THE SCREEN THAT NEEDS IT.
 *
 * THE REPORTER'S QUESTION, and it is a fair one: "why must I configure eligibility TWICE?" They must not,
 * and the answer is that the two settings ask DIFFERENT questions:
 *
 *   leave_type.eligibility          — MAY THIS EMPLOYEE TAKE IT AT ALL? A yes/no over the whole type
 *                                     (`isLeaveEligible`, core/leave.ts). Fail it and the type is not
 *                                     offered and an application is refused.
 *   entitlement_eligibility_rule    — WHICH DAY TABLE APPLIES? A CHOICE among the type's entitlement
 *                                     templates (`buildTemplateEntitlementResolver`). A yes/no cannot
 *                                     pick between Annual Leave's sixteen tables, which is exactly why
 *                                     merging the two is not on the table.
 *
 * Where the reporter is RIGHT is the duplication of CONDITIONS: both speak the same vocabulary — company,
 * grade, employment type, division and the rest — so narrowing the leave type to confirmed staff and then
 * narrowing every rule to confirmed staff too keys one thing twice, and either copy can silently exclude
 * somebody. The remedy is not to merge them; it is to SHOW the inherited half, read-only, on the screen
 * where the second half is typed.
 *
 * ⚠️ THE WORDING IS DERIVED, NEVER RESTATED. Every label and every value below comes out of the SAME
 * `CriteriaSection[]` the rule editor's own pickers are built from (`buildOrgCriteriaSections`,
 * core/org-criteria-form.ts). Hand-writing a second list of axis names is precisely how the inherited
 * summary and the criteria builder beside it would come to describe one configuration two ways — the
 * defect this item is about, reproduced one layer up.
 *
 * PURE, DB-free and framework-free: it takes the sections and the four labels it cannot derive as plain
 * data, so it is unit-tested without a request and both the server block and the tests read one
 * definition. Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
// d272834b — the picker's option sets, from the CLIENT-SAFE leaf module (no DB import), so this block can
// apply the universal-list rule without pulling the kernel into a client bundle.
import { ELIGIBILITY_GENDERS, MARITAL_STATUSES } from '@/lib/person-vocabulary';
import type { CriteriaSection } from '@/core/org-criteria-form';

/**
 * The leave type's own eligibility, structurally.
 *
 * A MIRROR of `LeaveEligibility` (core/leave.ts), kept local for the reason `components/leave-type-panel.tsx`
 * keeps its own: core/leave.ts pulls in `db/client`, and this module must stay importable by a test with no
 * database and by any renderer. The keys are the contract and they are pinned by the tests.
 */
export type LeaveTypeEligibility = {
  gender?: string | string[];
  maritalStatus?: string | string[];
  minServiceMonths?: number;
  minServiceUnit?: 'months' | 'days';
  probation?: 'confirmed_only' | 'probation_only';
} & Partial<Record<(typeof ORG_ASSIGNMENT_CRITERIA)[number]['key'], string | string[]>>;

/** One inherited condition, ready to render: an axis name and the values it allows, both already labelled. */
export type InheritedCondition = { key: string; label: string; values: string[] };

/** Normalise a scalar-or-array eligibility field to a de-blanked list. Mirrors `asList` (core/leave.ts) —
 *  legacy rows written before multi-select store a scalar, and both shapes must read identically.
 *
 *  d272834b — and it mirrors `eligibilityRuleList` too, because this block tells HR which conditions a
 *  leave type INHERITS, and a list holding every option the picker offers inherits no condition at all.
 *  Printing "Gender: Male or Female" as an inherited condition told HR the type was restricted when it was
 *  not — the same misreading, on the screen where they would act on it. Kept LOCAL (no core import) for
 *  the reason the line above already gives; the option sets come from the shared client-safe module, so
 *  the two copies of the RULE can still only disagree if someone edits one of them. */
function asEligList(v: string | string[] | null | undefined, pickerOptions?: readonly string[]): string[] {
  if (v == null) return [];
  const list = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
  if (list.length === 0 || pickerOptions == null) return list;
  return pickerOptions.every((o) => list.includes(o)) ? [] : list;
}

/** Every criteria field the shared builder produced, flattened by field name. */
function fieldsByName(sections: readonly CriteriaSection[]) {
  const out = new Map<string, CriteriaSection['fields'][number]>();
  for (const s of sections) for (const f of s.fields) out.set(f.name, f);
  return out;
}

/**
 * A criteria FIELD NAME → the label the rule editor's picker carries for it, or null when the vocabulary
 * has no such field. Null rather than the raw name on purpose: `orgDivision` on a screen teaches nobody
 * anything, and a screen that cannot name an axis should say less, not say it in code.
 */
export function criteriaAxisLabeller(sections: readonly CriteriaSection[]): (axis: string) => string | null {
  const byName = fieldsByName(sections);
  return (axis) => byName.get(axis)?.label ?? null;
}

/** A criteria field's stored VALUE → its display label, falling back to the stored value itself (which is
 *  what an option deactivated since the rule was written leaves behind, and is still recognisable). */
export function criteriaValueLabeller(
  sections: readonly CriteriaSection[],
): (axis: string, value: string) => string {
  const byName = fieldsByName(sections);
  return (axis, value) => byName.get(axis)?.options?.find((o) => o.value === value)?.label ?? value;
}

/**
 * WHICH CRITERIA FIELD SAYS THE SAME THING AS THIS LEAVE-TYPE ELIGIBILITY KEY.
 *
 * The eight Organisation-Assignment axes are the same key on both sides by construction (see
 * core/leave-org-criteria.ts), so they map to themselves and cannot drift. Gender is `gender` on the leave
 * type and `genders` in the criteria vocabulary — one axis, two spellings, and this is the only place that
 * fact is written down. Probation maps onto `confirmationStatuses`, which core/org-criteria.ts's own header
 * calls out as answering both "Confirmation Status" and "Probation Status" with one predicate.
 *
 * MARITAL STATUS AND MINIMUM SERVICE HAVE NO COUNTERPART, and that is not an oversight to be papered over:
 * marital status was deliberately never made a criteria axis (core/org-criteria.ts's header says so), and
 * `minServiceMonths` is measured in months or DAYS while `minYearsOfService` is measured in years — near
 * neighbours, not the same axis. They are labelled from this screen's own copy instead of being forced
 * onto a field that means something slightly different.
 */
const ELIGIBILITY_TO_CRITERIA_AXIS: Record<string, string> = {
  gender: 'genders',
  probation: 'confirmationStatuses',
  ...Object.fromEntries(ORG_ASSIGNMENT_CRITERIA.map((c) => [c.key, c.key])),
};

/** `confirmed_only` / `probation_only` in the criteria vocabulary's own words. */
const PROBATION_TO_CONFIRMATION: Record<string, string> = {
  confirmed_only: 'confirmed',
  probation_only: 'probation',
};

/**
 * The leave type's own conditions, as rows a screen renders read-only above the criteria builder.
 *
 * Order is the reporter's reading order and the one the mockup they approved shows: the demographic and
 * service rules first (they are what "may this employee take it" mostly means), then the organisation
 * axes in the criteria vocabulary's own order.
 *
 * An EMPTY result means the leave type carries no conditions of its own — a real answer ("it is open to
 * everyone"), never a blank space.
 */
export function inheritedConditions(
  eligibility: LeaveTypeEligibility | null | undefined,
  sections: readonly CriteriaSection[],
  labels: {
    /** "Marital Status" — no criteria axis exists for it; see `ELIGIBILITY_TO_CRITERIA_AXIS`. */
    maritalStatus: string;
    /** "Minimum service" — likewise. */
    minService: string;
    /** The figure with its unit, e.g. "12 months". The caller formats it, because the plural rules are
     *  the message catalogue's business and this module holds no translator. */
    minServiceValue: (n: number, unit: 'months' | 'days') => string;
    /** A marital-status value's own label, from the leave-type screen's existing vocabulary. */
    maritalValue: (value: string) => string;
  },
): InheritedCondition[] {
  const e = eligibility ?? {};
  const axisLabel = criteriaAxisLabeller(sections);
  const valueLabel = criteriaValueLabeller(sections);
  const out: InheritedCondition[] = [];

  /** Push one row through the SHARED vocabulary; silently skip an axis the vocabulary does not carry —
   *  a label we cannot derive is not one to invent here (see `criteriaAxisLabeller`). */
  const pushMapped = (eligKey: string, values: string[]) => {
    if (values.length === 0) return;
    const axis = ELIGIBILITY_TO_CRITERIA_AXIS[eligKey];
    const label = axis ? axisLabel(axis) : null;
    if (!axis || !label) return;
    out.push({ key: eligKey, label, values: values.map((v) => valueLabel(axis, v)) });
  };

  pushMapped('gender', asEligList(e.gender, ELIGIBILITY_GENDERS));

  const marital = asEligList(e.maritalStatus, MARITAL_STATUSES);
  if (marital.length > 0) {
    out.push({ key: 'maritalStatus', label: labels.maritalStatus, values: marital.map(labels.maritalValue) });
  }

  if (e.minServiceMonths) {
    out.push({
      key: 'minServiceMonths',
      label: labels.minService,
      values: [labels.minServiceValue(e.minServiceMonths, e.minServiceUnit === 'days' ? 'days' : 'months')],
    });
  }

  if (e.probation) pushMapped('probation', [PROBATION_TO_CONFIRMATION[e.probation] ?? e.probation]);

  for (const c of ORG_ASSIGNMENT_CRITERIA) pushMapped(c.key, asEligList(e[c.key]));

  return out;
}
