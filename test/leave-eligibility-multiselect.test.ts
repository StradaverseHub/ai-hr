/**
 * 2cc30077 → 0af0729d — Eligibility Rules: Gender + Marital Status pickers are a checkbox POPOVER.
 *
 * UI-ONLY change. ChipMultiSelect (components/ui/chip-multi-select.tsx) now opens a popover listing EVERY
 * option with a checkbox indicator (stored values pre-checked; a row click toggles one value) instead of the
 * old native add-<select> that listed only the remaining options plus "Select all" / "Clear all" sentinel
 * entries. On the leave eligibility pickers the bulk (Select-all / Clear-all) and collapsed-summary
 * ("All selected" / "{n} selected") affordances are no longer passed — the admin always sees exactly which
 * values are chosen. They remain OPT-IN props: /performance's new-cycle pickers keep all four (its company
 * list is unbounded, so one-click select-all and the count summary genuinely matter there).
 *
 * The critical invariant is the FORM CONTRACT: ChipMultiSelect still emits ONE hidden <input name={name}> per
 * selected value, so updateLeaveTypeAction's fd.getAll('gender') / fd.getAll('maritalStatus') keep working
 * unchanged — no storage / save / rule-evaluation change (leave_type.eligibility jsonb, cleanEligibility,
 * assertEligible all untouched).
 *
 * DB-free / jsdom-free guard (the suite has no DOM runner). It fails loudly if a future edit (a) reverts the
 * pickers to raw named checkboxes or the old add-select, (b) drops the name / defaultSelected wiring, (c)
 * breaks the one-hidden-input-per-value contract or the getAll() reader, (d) lets a popover button default to
 * type="submit" (opening the picker would silently submit the surrounding form and close edit mode), (e)
 * re-adds the bulk/summary props on the leave pickers or drops them from /performance, or (f) leaves an
 * orphaned/removed i18n key in any of the 6 locales. What a static test CANNOT prove — popover open/toggle/
 * Escape behaviour in a real DOM — is assigned to browser verification.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
/** Strip block comments so markup-shaped prose in doc comments can't satisfy (or trip) markup assertions. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const PANEL = 'components/leave-type-panel.tsx';
const CHIP = 'components/ui/chip-multi-select.tsx';
const ACTIONS = 'app/admin/actions.ts';
const PERF = 'app/performance/new-cycle-form.tsx';
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const BULK_PROPS = ['selectAllLabel', 'clearAllLabel', 'allSelectedLabel', 'countLabelFor'] as const;
// 0af0729d removed these from admin.leave in ALL locales (their only consumers were the leave pickers).
const REMOVED_KEYS = [
  'eligibilitySelectAll',
  'eligibilityClearAll',
  'eligibilityAllSelected',
  'eligibilityNSelected',
] as const;
// Still consumed by the leave pickers — must stay in every locale.
const KEPT_LEAVE_KEYS = ['eligibilityChipAddPlaceholder', 'chipRemoveAria'] as const;
// The /performance chip family stays intact (that screen keeps its bulk/summary affordances).
const KEPT_PERF_KEYS = [
  'chipAddPlaceholder',
  'chipRemoveLabel',
  'chipSelectAll',
  'chipClearAll',
  'chipAllSelected',
  'chipNSelected',
] as const;

describe('0af0729d · eligibility gender/marital become a checkbox popover', () => {
  const panel = read(PANEL);
  const chip = read(CHIP);
  const actions = read(ACTIONS);
  const perf = read(PERF);

  it('ChipMultiSelect is a client leaf that preserves the one-hidden-input-per-value FORM CONTRACT', () => {
    expect(chip.trimStart().startsWith("'use client'")).toBe(true);
    // One hidden input per selected value, named after the field — the exact shape getAll() consumes.
    expect(chip).toMatch(/type="hidden" name=\{name\} value=\{v\}/);
  });

  it('the old add-select and its bulk sentinels are gone', () => {
    const code = stripComments(chip);
    expect(code).not.toMatch(/BULK_/);
    expect(code).not.toMatch(/<select/);
  });

  it('every button in the control is type="button" — opening the popover must never submit the form', () => {
    // The pickers sit inside live <form action={...}>s whose onSubmit closes the editor; a default-type
    // button would submit-and-close the moment the popover is opened.
    const buttons = stripComments(chip).match(/<button[\s\S]*?>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const tag of buttons) {
      expect(tag, `button tag must be type="button": ${tag.slice(0, 80)}`).toMatch(/type="button"/);
    }
  });

  it('option rows are checkbox-semantics buttons driven by the selection, not named inputs', () => {
    expect(chip).toMatch(/role="checkbox"/);
    expect(chip).toMatch(/aria-checked=\{selected\.includes\(o\.value\)\}/);
    // No real checkbox input may carry a name — it would pollute fd.getAll(name).
    expect(chip).not.toMatch(/type="checkbox"[^>]*\bname=/);
    expect(chip).not.toMatch(/\bname=[^>]*type="checkbox"/);
  });

  it('Escape closes the popover (keyboard dismissal)', () => {
    expect(chip).toMatch(/Escape/);
  });

  it('the bulk/summary affordances survive as OPT-IN props (performance depends on them)', () => {
    for (const prop of BULK_PROPS) {
      expect(chip, `${prop} still an optional prop`).toMatch(new RegExp(`${prop}\\?:`));
    }
  });

  it('the panel renders ChipMultiSelect for gender AND marital, not raw checkboxes', () => {
    expect(panel).toMatch(/import \{ ChipMultiSelect \} from '\.\/ui\/chip-multi-select'/);
    expect(panel).toMatch(/<ChipMultiSelect\s+name="gender"/);
    expect(panel).toMatch(/<ChipMultiSelect\s+name="maritalStatus"/);
    // The old per-option checkbox inputs for these two fields are gone.
    expect(panel).not.toMatch(/type="checkbox"\s+name="gender"/);
    expect(panel).not.toMatch(/type="checkbox"\s+name="maritalStatus"/);
  });

  it('the pickers seed their selection from the stored eligibility (existing configs preselect)', () => {
    expect(panel).toMatch(/defaultSelected=\{asEligList\(eligibility\?\.gender\)\}/);
    expect(panel).toMatch(/defaultSelected=\{asEligList\(eligibility\?\.maritalStatus\)\}/);
    // Options still come from the local master-data constants, with i18n labels.
    expect(panel).toMatch(/ELIGIBILITY_GENDER_OPTIONS\.map/);
    expect(panel).toMatch(/ELIGIBILITY_MARITAL_OPTIONS\.map/);
  });

  it('the leave pickers pass NONE of the bulk/summary props (no Select-all / Clear-all / All-selected)', () => {
    for (const prop of BULK_PROPS) {
      const count = panel.split(prop).length - 1;
      expect(count, `${prop} must not appear in the leave panel`).toBe(0);
    }
  });

  it('/performance keeps all four bulk/summary props on all three pickers (opt-in affordances, 4dc4c3a5)', () => {
    expect(perf).toMatch(/<ChipMultiSelect/);
    for (const prop of BULK_PROPS) {
      const count = perf.split(`${prop}=`).length - 1;
      expect(count, `${prop} should be passed to all three new-cycle pickers`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the save action still reads getAll() arrays — no storage/rule-eval change', () => {
    expect(actions).toMatch(/gender: fd\.getAll\('gender'\)\.map\(String\)/);
    expect(actions).toMatch(/maritalStatus: fd\.getAll\('maritalStatus'\)\.map\(String\)/);
  });

  it('the four retired admin.leave keys are absent from ALL 6 locales; kept keys stay present', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const leave = msgs.admin?.leave ?? {};
      for (const key of REMOVED_KEYS) {
        expect(leave[key], `${loc}.admin.leave.${key} should be removed`).toBeUndefined();
      }
      for (const key of KEPT_LEAVE_KEYS) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
      // Performance-namespace chip family stays intact, with its ICU-ish placeholder.
      const perfMsgs = msgs.performance?.eligibility ?? {};
      for (const key of KEPT_PERF_KEYS) {
        expect(typeof perfMsgs[key], `${loc}.performance.eligibility.${key}`).toBe('string');
        expect((perfMsgs[key] as string).length, `${loc}.performance.eligibility.${key} non-empty`).toBeGreaterThan(0);
      }
      expect(perfMsgs.chipNSelected, `${loc}.performance.eligibility.chipNSelected keeps {count}`).toMatch(/\{count\}/);
    }
  });
});
