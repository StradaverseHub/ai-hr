/**
 * 9e2a89e9 (r269) — "WHO DOES THIS COVER", IN THE PICKER'S OWN WORDS, DERIVED ONCE.
 *
 * r266 gave the benefit-scheme list a Covers column. It was rendered inline, and it printed the raw
 * criteria KEYS with a count — `gradeIds: 4` — which is readable to whoever wrote the code and to nobody
 * else. This item adds the same column to the entitlement TABLES list, so the operator can see from one
 * screen which job grades and employment types each table covers.
 *
 * ⚠️ ONE SUMMARISER, TWO COLUMNS. The approved plan is explicit: "reuse that renderer rather than writing
 * a second criteria summariser". Two renderings of one criteria object would eventually disagree about the
 * same scheme on two halves of the same screen — which is the class of defect this whole area keeps
 * producing. So the derivation lives here, both columns call it, and neither holds any criteria logic.
 *
 * ⚠️ AND IT IS NOT A SECOND VOCABULARY EITHER. The axis labels and the option labels are NOT invented
 * here: they come from `buildOrgCriteriaSections` (core/org-criteria-form.ts), the ONE picker the rule
 * editor renders, already resolved in six locales and already loaded once per page. An axis renamed there
 * changes here for free; an axis this file does not recognise degrades to its raw key rather than to
 * `MISSING_MESSAGE` on a live screen.
 *
 * ⚠️ NEVER PRINT A RAW UUID. A criteria value whose catalogue row has been archived or deleted has no
 * option to name it, and printing the stored id would put a UUID in front of an operator. Those are
 * COUNTED (`unresolved`) and the caller says "+2 more" rather than showing them.
 *
 * PURE, DB-free, framework-free: a server component derives it and a test asserts it without a database.
 * Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */

/** The shape `CriteriaField` (core/org-criteria-form.ts) already has. Structural, so this file imports
 *  nothing from `core/` — which is what keeps it usable from a client island if one ever needs it. */
export type CriteriaFieldLike = { name: string; label: string; options?: { value: string; label: string }[] };
export type CriteriaSectionLike = { fields: readonly CriteriaFieldLike[] };

export type CriteriaAxisSummary = {
  /** The criteria key as stored, e.g. `gradeIds`. */
  axis: string;
  /** The picker's own label for that axis ("Job Grade"), or the raw key when the axis is unrecognised. */
  label: string;
  /** The chosen options, named, in the order they are stored. Empty for a scalar axis. */
  values: string[];
  /** How many chosen values had no option to name them — an archived or deleted catalogue row. */
  unresolved: number;
  /** For the non-list axes (minYearsOfService, hiredFrom, …): the value itself, as text. */
  scalar: string | null;
};

/** A value that narrows nothing: absent, empty string, or an empty list. An EMPTY criteria object is a
 *  real value meaning EVERYONE, and is never a blank cell. */
const narrows = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v != null && v !== '');

/** True when this criteria object narrows by nothing at all — i.e. it covers everyone the leave type is
 *  available to. The one predicate both columns test, so "everyone" cannot come to mean two things. */
export function isEveryoneCriteria(criteria: Record<string, unknown> | null | undefined): boolean {
  return !Object.values(criteria ?? {}).some(narrows);
}

/**
 * One entry per axis the criteria actually narrow by, in the criteria object's own key order.
 *
 * `sections` is what `buildOrgCriteriaSections` returned for this page; pass it and the axes and values
 * come out named. Pass an empty list and every axis degrades to its raw key with a count — still true,
 * just less readable — which is what makes this safe to call from a surface that has no catalogue.
 */
export function summariseOrgCriteria(
  criteria: Record<string, unknown> | null | undefined,
  sections: readonly CriteriaSectionLike[] = [],
): CriteriaAxisSummary[] {
  const fieldByName = new Map<string, CriteriaFieldLike>();
  for (const section of sections) for (const f of section.fields) fieldByName.set(f.name, f);

  const out: CriteriaAxisSummary[] = [];
  for (const [axis, value] of Object.entries(criteria ?? {})) {
    if (!narrows(value)) continue;
    const field = fieldByName.get(axis);
    const label = field?.label ?? axis;
    if (!Array.isArray(value)) {
      out.push({ axis, label, values: [], unresolved: 0, scalar: String(value) });
      continue;
    }
    const optionLabel = new Map((field?.options ?? []).map((o) => [o.value, o.label]));
    const values: string[] = [];
    let unresolved = 0;
    for (const v of value) {
      const name = optionLabel.get(String(v));
      if (name) values.push(name);
      else unresolved += 1;
    }
    out.push({ axis, label, values, unresolved, scalar: null });
  }
  return out;
}
