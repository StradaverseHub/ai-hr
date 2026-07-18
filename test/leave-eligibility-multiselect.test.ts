/**
 * 2cc30077 — Eligibility Rules: Gender + Marital Status pickers become a compact multi-select dropdown.
 *
 * UI-ONLY change. The two checkbox groups in the Eligibility Rules editor (components/leave-type-panel.tsx)
 * are replaced by the existing ChipMultiSelect (components/ui/chip-multi-select.tsx), enhanced with an opt-in
 * Select-all / Clear-all control and a collapsed "All selected" / "{n} selected" summary. The critical
 * invariant is the FORM CONTRACT: ChipMultiSelect still emits ONE hidden <input name={name}> per selected
 * value, so updateLeaveTypeAction's fd.getAll('gender') / fd.getAll('maritalStatus') keep working unchanged —
 * no storage / save / rule-evaluation change (leave_type.eligibility jsonb, cleanEligibility, assertEligible
 * all untouched).
 *
 * DB-free / jsdom-free guard (the suite has no DOM runner). It fails loudly if a future edit (a) reverts the
 * pickers back to raw checkboxes, (b) drops the name / defaultSelected wiring, (c) breaks the one-hidden-
 * input-per-value contract or the getAll() reader, (d) breaks the RSC boundary by making the control a
 * server module, or (e) drops one of the new i18n keys from any of the 6 locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const PANEL = 'components/leave-type-panel.tsx';
const CHIP = 'components/ui/chip-multi-select.tsx';
const ACTIONS = 'app/admin/actions.ts';
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const NEW_KEYS = [
  'eligibilityChipAddPlaceholder',
  'eligibilitySelectAll',
  'eligibilityClearAll',
  'eligibilityAllSelected',
  'eligibilityNSelected',
] as const;

describe('2cc30077 · eligibility gender/marital become a multi-select dropdown', () => {
  const panel = read(PANEL);
  const chip = read(CHIP);
  const actions = read(ACTIONS);

  it('the panel renders ChipMultiSelect for gender AND marital, not raw checkboxes', () => {
    expect(panel).toMatch(/import \{ ChipMultiSelect \} from '\.\/ui\/chip-multi-select'/);
    // Both fields are ChipMultiSelect instances keyed by the same posted names as before.
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

  it('both pickers wire the Select-all / Clear-all + collapsed-summary props', () => {
    for (const prop of ['selectAllLabel', 'clearAllLabel', 'allSelectedLabel', 'countLabelFor']) {
      // one occurrence per field = two total
      const count = panel.split(prop).length - 1;
      expect(count, `${prop} should be passed to both pickers`).toBeGreaterThanOrEqual(2);
    }
  });

  it('ChipMultiSelect is a client leaf that preserves the one-hidden-input-per-value FORM CONTRACT', () => {
    expect(chip.trimStart().startsWith("'use client'")).toBe(true);
    // One hidden input per selected value, named after the field — the exact shape getAll() consumes.
    expect(chip).toMatch(/type="hidden" name=\{name\} value=\{v\}/);
    // Bulk controls are real state transitions: select-all fills every option, clear-all empties.
    expect(chip).toMatch(/setSelected\(options\.map\(\(o\) => o\.value\)\)/);
    expect(chip).toMatch(/setSelected\(\[\]\)/);
    // Collapsed summary: "all selected" once every option is picked; "{n} selected" past the threshold.
    expect(chip).toMatch(/selected\.length === options\.length/);
    expect(chip).toMatch(/allSelectedLabel/);
    expect(chip).toMatch(/countLabelFor/);
  });

  it('the bulk-control props are now applied CONSISTENTLY at the /performance pickers too (4dc4c3a5)', () => {
    // Standardize Dropdown Behaviour (4dc4c3a5): the R44 bulk (Select-all/Clear-all) + collapsed-summary props
    // are wired at EVERY ChipMultiSelect call site, so the control behaves the same everywhere. new-cycle-form
    // has three eligibility pickers (Company / Status / Employment Type) — each gets all four props.
    const perf = read('app/performance/new-cycle-form.tsx');
    expect(perf).toMatch(/<ChipMultiSelect/);
    for (const prop of ['selectAllLabel', 'clearAllLabel', 'allSelectedLabel', 'countLabelFor']) {
      const count = perf.split(prop).length - 1;
      expect(count, `${prop} should be passed to all three new-cycle pickers`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the save action still reads getAll() arrays — no storage/rule-eval change', () => {
    expect(actions).toMatch(/gender: fd\.getAll\('gender'\)\.map\(String\)/);
    expect(actions).toMatch(/maritalStatus: fd\.getAll\('maritalStatus'\)\.map\(String\)/);
  });

  it('every new i18n key exists in all 6 locales', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const leave = msgs.admin?.leave ?? {};
      for (const key of NEW_KEYS) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
      // The "{n} selected" template keeps its ICU-ish placeholder in every locale.
      expect(leave.eligibilityNSelected).toMatch(/\{count\}/);
    }
  });
});
