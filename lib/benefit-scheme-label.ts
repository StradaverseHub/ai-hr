/**
 * How a BENEFIT SCHEME is named on screen — the ONE rule, defined here and nowhere else.
 *
 * r76 items 22de47c4 (Assign Template scheme picker) and 48224d12 (Service Based Entitlements) reported the
 * same underlying fault from two screens: a scheme's identity was re-composed inline at each call site, so
 * each site restated facts the tenant had already typed into the scheme's own name — "GRADE 12-15
 * (PERMANENT) (Permanent)", or a grade-group line with the scheme name repeated underneath it. Both plans
 * promise the fix is at the RENDER layer: nothing here writes, and nothing here rewrites
 * `benefit_scheme.name`. What the tenant stored is what the tenant keeps.
 *
 * The rule, in one sentence:
 *
 *   A benefit scheme is named in the tenant's own words, said ONCE — the employment type is appended only
 *   when those words do not already state it, and never twice.
 *
 * Deliberately NOT part of the rule: re-casing. "GRADE 12-15" stays "GRADE 12-15". Title-casing stored
 * tenant text would mangle acronyms ("HQ" → "Hq") and is a rewrite of their words, not a de-duplication of
 * ours; the reported defect is the repetition, so only the repetition is removed.
 *
 * This module is pure and import-free on purpose: it is consumed by a Server Component
 * (app/admin/leave/approval/page.tsx) and by two Client Components (components/benefit-scheme-config.tsx,
 * app/admin/leave-approval/template-manager.tsx). It holds no `core/` import, so it sits outside the
 * ADR-0080 leave pack boundary and cannot become a drift-guard entry.
 */

/**
 * Display order for employment types — the PRIMARY sort key wherever schemes are listed.
 *
 * Permanent (`full_time`) first, then Contract, then Part-time, then Intern: the order an administrator
 * reads a workforce in, not the alphabetical order of the stored codes. "Contract - Special" is NOT an
 * employment type in this product — it is wording a tenant puts in a grade-group or scheme NAME — so it
 * sorts inside the `contract` block on the secondary key, which is exactly where the reporter expects it.
 *
 * Adding a future employment type is one entry in this array: nothing else in the ordering reads a
 * hard-coded type. A type NOT listed here still sorts deterministically (after every listed one, then by
 * its own code), so a new type reaching the UI before this list is updated degrades to a stable order
 * rather than to an unstable one.
 */
export const EMPLOYMENT_TYPE_DISPLAY_ORDER: readonly string[] = ['full_time', 'contract', 'part_time', 'intern'];

/** Position of `employmentType` in the display order; unlisted types rank last, together. */
export function employmentTypeRank(employmentType: string): number {
  const i = EMPLOYMENT_TYPE_DISPLAY_ORDER.indexOf(employmentType);
  return i === -1 ? EMPLOYMENT_TYPE_DISPLAY_ORDER.length : i;
}

/** Tenant text as we agree to show it: whitespace collapsed and trimmed. No case change, no rewording. */
export function normalizeSchemeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The comparison key for "do these two pieces of wording SAY the same thing" — lower-cased with every
 * non-alphanumeric dropped, so "GRADE 12-15 (PERMANENT)" and "Grade 12-15 — Permanent" collapse alike.
 * Used for de-duplication only; never for display, never for storage.
 */
export function schemeTextKey(value: string | null | undefined): string {
  return normalizeSchemeText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Does this wording already state the employment type? (Empty label ⇒ nothing to state.) */
export function statesEmploymentType(base: string | null | undefined, employmentTypeLabel: string): boolean {
  const label = schemeTextKey(employmentTypeLabel);
  return label.length > 0 && schemeTextKey(base).includes(label);
}

/**
 * Append the employment type to `base` exactly once — the second half of the rule.
 *
 * Three branches, in order:
 *  1. `base` carries a parenthetical that is EXACTLY the employment type ("GRADE 12-15 (PERMANENT)") — drop
 *     that parenthetical and re-append the properly-cased label, so the type is stated once, in the
 *     administrator's own language.
 *  2. `base` otherwise already states the type ("GRADE H (CONTRACT - SPECIAL)", "Permanent staff") — leave
 *     it completely alone. Stripping here would eat the tenant's distinction ("- SPECIAL"), and appending
 *     would repeat them.
 *  3. `base` does not state it — append " (Label)".
 */
export function withEmploymentType(base: string | null | undefined, employmentTypeLabel: string): string {
  const text = normalizeSchemeText(base);
  const label = normalizeSchemeText(employmentTypeLabel);
  if (label.length === 0) return text;

  const labelKey = schemeTextKey(label);
  const stripped = normalizeSchemeText(
    text.replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => (schemeTextKey(inner) === labelKey ? '' : whole)),
  );
  if (stripped !== text) return stripped.length > 0 ? `${stripped} (${label})` : label;
  if (statesEmploymentType(text, label)) return text;
  return text.length > 0 ? `${text} (${label})` : label;
}

/** The minimum a scheme has to carry to be named by the rule. */
export type BenefitSchemeNameParts = {
  /** The tenant's stored `benefit_scheme.name`. */
  name?: string | null;
  /** The scheme's grade group, when it has one. */
  gradeGroupName?: string | null;
};

/**
 * THE naming rule: one benefit scheme, ONE line.
 *
 * Head text is the grade group when the scheme has one (that is the population the scheme covers, and it is
 * what the entitlement screens' column asks for), falling back to the scheme's own name, falling back to
 * `allGradesLabel` for an ungrouped scheme with no name. The employment type is then applied by
 * `withEmploymentType`, i.e. said once or not at all.
 */
export function benefitSchemeDisplayName(
  scheme: BenefitSchemeNameParts,
  { employmentTypeLabel, allGradesLabel }: { employmentTypeLabel: string; allGradesLabel: string },
): string {
  const head = normalizeSchemeText(scheme.gradeGroupName) || normalizeSchemeText(scheme.name) || normalizeSchemeText(allGradesLabel);
  return withEmploymentType(head, employmentTypeLabel);
}

/**
 * Would printing the stored scheme name beneath `headLine` say the same thing twice?
 *
 * Compared with the employment type removed from BOTH sides, because that is the part the head line adds:
 * grade group "Leadership" + scheme "Leadership scheme" is a restatement; grade group "Leadership" + scheme
 * "Executive package" is not, and the second line is genuinely informative there. When in doubt the answer
 * is "not redundant" — losing the tenant's own name is worse than one extra muted line.
 */
export function schemeNameIsRedundant(
  schemeName: string | null | undefined,
  headLine: string,
  employmentTypeLabel: string,
): boolean {
  const labelKey = schemeTextKey(employmentTypeLabel);
  const strip = (v: string | null | undefined) => {
    const key = schemeTextKey(v);
    return labelKey.length > 0 ? key.split(labelKey).join('') : key;
  };
  const nameKey = strip(schemeName);
  const headKey = strip(headLine);
  if (nameKey.length === 0) return true;
  if (headKey.length === 0) return false;
  return nameKey === headKey || headKey.includes(nameKey) || nameKey.includes(headKey);
}

/**
 * The display order, as a comparator factory: primary employment type (the fixed list above), secondary the
 * grade wording each surface actually shows, and finally the scheme id.
 *
 * Total and stable by construction — the id tie-break means two schemes never compare equal, so the same
 * company lists its schemes in the same sequence on every render, in every browser, whatever order the
 * query returned them in. `sortTextOf` is supplied by the caller so the sort key is always the text on
 * screen: a list ordered by something the reader cannot see is the fault this replaces, not a fix for it.
 */
export function bySchemeDisplayOrder<T extends { id: string; employmentType: string }>(
  sortTextOf: (scheme: T) => string | null | undefined,
): (a: T, b: T) => number {
  return (a, b) => {
    const rank = employmentTypeRank(a.employmentType) - employmentTypeRank(b.employmentType);
    if (rank !== 0) return rank;
    // Two UNLISTED types share the last rank; order them by code so the result is still deterministic.
    if (a.employmentType !== b.employmentType) return a.employmentType < b.employmentType ? -1 : 1;

    const ta = normalizeSchemeText(sortTextOf(a));
    const tb = normalizeSchemeText(sortTextOf(b));
    // Numeric collation so "Grade 2" precedes "Grade 12" instead of sorting as raw strings.
    const byText = ta.localeCompare(tb, 'en', { numeric: true, sensitivity: 'base' });
    if (byText !== 0) return byText;
    // localeCompare can call two different strings equal (case, accents); fall through to code points so
    // the comparator never depends on the input order.
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}
