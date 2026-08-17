/**
 * 74d00fd2 — Employee Eligibility: Select all / Deselect all, search, and the count on the closed control.
 *
 * WHAT WAS ALREADY TRUE and is NOT rebuilt here: ticking several values in one eligibility field, and those
 * ticks surviving a close-and-reopen. `entitlementEligibilityRule.criteria` has always been a jsonb array
 * per axis, `criteriaFrom` has always read it with `formData.getAll`, and `resolveOrgCriteriaTargets` has
 * always used `inArray` per axis (OR within an axis, AND across axes). Nothing about storage, posting or
 * resolution changes in this item, and this file asserts that by pinning the hidden-input contract.
 *
 * WHAT CHANGED, all of it in the UI:
 *   1. The eligibility pickers now pass the bulk affordances that were already opt-in props of the shared
 *      control — searchPlaceholder / selectAllLabel / clearAllLabel — at THIS call site, so no other
 *      screen's picker changes.
 *   2. `triggerSummaryFor` (new, opt-in) puts the summary on the trigger itself. 26 collapsed sections of
 *      pickers all reading "Add…" cannot be read at a glance; the old count line appeared BELOW the control
 *      and only past four, which is exactly the range where the chips were already legible.
 *   3. "Clear all" became filter-aware in components/ui/chip-multi-select.tsx — the mirror of the rule
 *      "Select all" has followed since 18103ba4. It used to clear the whole field regardless of the search
 *      box, silently dropping the picks the filter was HIDING.
 *   4. Stored values are unioned back into the offered options, so a rule saved before a nationality was
 *      deactivated does not silently widen on the next plain Save.
 *
 * This file is the SOURCE-SHAPE guard (the node project has no DOM). The behaviour those shapes produce —
 * a filtered Deselect all keeping the hidden picks, the trigger text at each count, chips vs no chips — is
 * rendered and asserted in test/eligibility-bulk-select.dom.test.tsx. Neither file replaces the other.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
/** Strip block comments so prose in doc comments can neither satisfy nor trip a markup assertion. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const FORM = 'components/leave/eligibility-rule-form.tsx';
const CHIP = 'components/ui/chip-multi-select.tsx';
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The four keys this item adds, all in the ONE namespace the form uses (admin.entitlementTemplates). */
const NEW_KEYS = ['chipSelectAll', 'chipDeselectAll', 'chipSearchPlaceholder', 'chipAllSelected'] as const;
/** Already shipped in that namespace before this item — the summary reuses them rather than adding twins. */
const KEPT_KEYS = ['chipAddPlaceholder', 'chipRemoveLabel', 'chipCountLabel'] as const;

/**
 * EVERY caller of the shared control, enumerated so "opt-in" is a fact rather than an intention. The
 * component has six-plus call sites and its defaults must not move; only the eligibility form may pass the
 * new trigger summary. Adding a caller means adding it here and deciding, deliberately, which side it is on.
 */
const CHIP_CALLERS = [
  'app/performance/new-cycle-form.tsx',
  'components/leave-shared-group-config.tsx',
  'components/leave-type-panel.tsx',
  'components/notice/notice-form.tsx',
  'components/leave/half-day-company-picker.tsx',
  'components/leave/eligibility-rule-form.tsx',
  'components/leave/generate-form.tsx',
  'components/leave/adjustment-form.tsx',
] as const;

describe('74d00fd2 · eligibility pickers get Select all / Deselect all / search / a count on the control', () => {
  const form = stripComments(read(FORM));
  const chip = read(CHIP);
  const chipCode = stripComments(chip);

  it('the eligibility pickers pass the three bulk props the Adjustments builder already passes', () => {
    // Same criteria builder, same three props — the shape copied from adjustment-form.tsx / generate-form.tsx.
    expect(form).toMatch(/searchPlaceholder=\{t\('chipSearchPlaceholder'\)\}/);
    expect(form).toMatch(/selectAllLabel=\{t\('chipSelectAll'\)\}/);
    expect(form).toMatch(/clearAllLabel=\{t\('chipDeselectAll'\)\}/);
  });

  it('the summary moves onto the trigger and covers BOTH sentences (all-selected and a plain count)', () => {
    expect(form).toMatch(/triggerSummaryFor=\{\(n, allSelected\) =>/);
    expect(form).toMatch(/allSelected \? t\('chipAllSelected'\) : t\('chipCountLabel', \{ count: n \}\)/);
  });

  it('countLabelFor is NOT also passed — the below-control line is suppressed, so it would be dead copy', () => {
    // The point of the new prop is that the same sentence is never printed twice. A leftover countLabelFor
    // here would read as though the count still appears under the box; it does not.
    expect(form).not.toMatch(/countLabelFor=/);
  });

  it('only the eligibility form opts into the trigger summary — no other caller changes', () => {
    for (const caller of CHIP_CALLERS) {
      const src = stripComments(read(caller));
      const passes = /triggerSummaryFor=/.test(src);
      expect(passes, `${caller} ${caller === FORM ? 'must' : 'must NOT'} pass triggerSummaryFor`).toBe(
        caller === FORM,
      );
    }
  });

  it('triggerSummaryFor is an OPTIONAL prop and the component still defaults to the plain placeholder', () => {
    expect(chip).toMatch(/triggerSummaryFor\?: \(count: number, allSelected: boolean\) => string;/);
    // Nothing selected ⇒ addPlaceholder, whether or not the prop is supplied.
    expect(chipCode).toMatch(/\{triggerSummary \?\? addPlaceholder\}/);
    expect(chipCode).toMatch(/summaryOnTrigger && selected\.length > 0/);
    // summaryThreshold keeps its default: the chip strip and its remove buttons are untouched.
    expect(chipCode).toMatch(/summaryThreshold = 4/);
  });

  it('supplying it suppresses BOTH below-control summary lines, so nothing is printed twice', () => {
    expect(chipCode).toMatch(/const showAllSummary =\s*!summaryOnTrigger && allSelected && allSelectedLabel != null/);
    expect(chipCode).toMatch(/!summaryOnTrigger && !showAllSummary && countLabelFor != null/);
    // …and the strip below becomes chips-or-nothing, so a 197-value field prints no chip wall.
    expect(chipCode).toMatch(/const showChips = !summaryOnTrigger \|\| selected\.length <= summaryThreshold;/);
  });

  it('Clear all removes only the VISIBLE values — the mirror of the Select all rule', () => {
    // Before: apply([]) regardless of the filter, which dropped the picks the search box was hiding.
    expect(chipCode).toMatch(/apply\(selected\.filter\(\(v\) => !visible\.some\(\(o\) => o\.value === v\)\)\)/);
    expect(chipCode).not.toMatch(/onClick=\{\(\) => apply\(\[\]\)\}/);
    // Select all is unchanged: union of what is already picked with what is currently visible.
    expect(chipCode).toMatch(/apply\(\[\.\.\.selected, \.\.\.visible\.map\(\(o\) => o\.value\)/);
  });

  it('a stored value that has since been deactivated stays offered, so a plain Save cannot widen the rule', () => {
    // 9a65f808 — the call site now reads `optionsFor(f)`, which is `withStored` plus one more union for
    // the grade axis (below). UPDATED rather than loosened: the property is that every picker's option
    // list still passes through `withStored` with this rule's own stored values, and it does.
    expect(form).toMatch(/options=\{optionsFor\(f\)\}/);
    expect(form).toMatch(/const optionsFor = \(f: \{ name: string; options\?: CriteriaOption\[\] \}\): CriteriaOption\[\] =>\s*\n\s*withStored\(/);
    expect(form).toMatch(/const withStored = \(options: CriteriaOption\[\], stored: string\[\]\): CriteriaOption\[\]/);
    expect(form).toMatch(/stored\.filter\(\(v\) => !options\.some\(\(o\) => o\.value === v\)\)\.map\(\(v\) => \(\{ value: v, label: v \}\)\)/);
    // Read from `initial`, not from live state — a live-derived option list would move under the operator.
    expect(form).toMatch(/const v = initial\?\.criteria\?\.\[name\];/);
  });

  it('…and 9a65f808 extends the SAME rule to every grade a group holds', () => {
    // The Grade Group picker expands to member grades, and `ChipMultiSelect` drops any defaultSelected
    // value it cannot find in `options`. A group holding an archived grade would therefore expand to seven
    // and post six — the identical silent widening the case above exists to prevent, arriving by a new
    // route. Pinned here, beside it, because the two are one rule.
    expect(form).toMatch(/f\.name === 'gradeIds'\s*\?\s*\[\.\.\.storedFor\(f\.name\), \.\.\.allGroupMemberGradeIds\]/);
  });

  it('the FORM CONTRACT is untouched: one hidden input per value, outside the open guard', () => {
    expect(chip).toMatch(/type="hidden" name=\{name\} value=\{v\}/);
    const hiddenAt = chipCode.indexOf('type="hidden"');
    const openGuardAt = chipCode.indexOf('{open &&');
    expect(hiddenAt).toBeGreaterThan(-1);
    expect(hiddenAt, 'hidden inputs must still render before (outside) the {open && panel guard').toBeLessThan(
      openGuardAt,
    );
    // The search box must never post — a named one would land in getAll() as a phantom criteria value.
    expect(chipCode).not.toMatch(/type="search"[^>]*\bname=/);
  });

  it('every button in the control is still type="button" — opening a picker must not submit the form', () => {
    const buttons = chipCode.match(/<button[\s\S]*?>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const tag of buttons) expect(tag, tag.slice(0, 80)).toMatch(/type="button"/);
  });

  it('the four new keys ship in all six locales, in the ONE namespace this file uses', () => {
    for (const loc of LOCALES) {
      const ns = JSON.parse(read(`messages/${loc}.json`)).admin?.entitlementTemplates ?? {};
      for (const key of [...NEW_KEYS, ...KEPT_KEYS]) {
        expect(typeof ns[key], `${loc}.admin.entitlementTemplates.${key}`).toBe('string');
        expect((ns[key] as string).trim().length, `${loc}.…${key} non-empty`).toBeGreaterThan(0);
      }
      // The count sentence is the one with a placeholder; it is fed through t() with { count }.
      expect(ns.chipCountLabel, `${loc} chipCountLabel keeps {count}`).toMatch(/\{count\}/);
      // The three plain ones must NOT carry braces — a bare t() on a key with a placeholder throws
      // FORMATTING_ERROR at render and paints the raw key path behind a 200.
      for (const key of ['chipSelectAll', 'chipDeselectAll', 'chipSearchPlaceholder', 'chipAllSelected']) {
        expect(ns[key], `${loc}.…${key} must be placeholder-free`).not.toMatch(/[{}]/);
      }
    }
  });
});
