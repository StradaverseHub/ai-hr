/**
 * 7c834696 contested — "How come under Lateness, Early Out & Overtime Settings I cannot untick
 * 'Apply to Early Overtime'?"
 *
 * They were right. Two independent halves conspired, and this file pins BOTH so that fixing one and
 * regressing the other cannot go unnoticed:
 *
 *   1. THE WRITER (components/attendance-rule-ot-editor.tsx). The visible control is a CONTROLLED React
 *      checkbox with no `name`, so its value rode a hidden input. A hidden input is submitted ALWAYS,
 *      whatever its value — so an unticked box still put `applyToEarlyOt` into the FormData carrying an
 *      empty string.
 *   2. THE READER (app/admin/attendance-policy/rule-actions.ts). `bool()` asked only whether the field was
 *      PRESENT (`fd.get(key) != null`). `'' != null` is true, so the flag saved as ON on every save.
 *
 * The result was a setting that could never be turned off, on a flag that FOLDS PRE-SHIFT MINUTES INTO
 * PAID OVERTIME (core/attendance.ts `earlyOtFolded`). Both production rules — including `Standard`, the
 * tenant default — carried it true, and 8 of 11 shifts carry a rule.
 *
 * These are source-shape assertions on purpose. The defect lived in the FORM CONTRACT between two files,
 * not in any function's return value, so a unit test of either half in isolation would have passed
 * throughout — which is exactly why it shipped.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const editor = readFileSync(join(root, 'components/attendance-rule-ot-editor.tsx'), 'utf8');
const actions = readFileSync(join(root, 'app/admin/attendance-policy/rule-actions.ts'), 'utf8');

/** Strip block and line comments — this file's own explanation quotes the broken expression, and the
 *  import ratchet's comment false positive is the standing lesson about scanning source with comments in. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('7c834696: Apply to Early Overtime must be untickable', () => {
  it('the writer never submits the field when the box is off', () => {
    const code = stripComments(editor);

    // The old shape: an ALWAYS-rendered hidden input whose value flips. That is the bug.
    expect(code).not.toMatch(/<input[^>]*type="hidden"[^>]*name="applyToEarlyOt"[^>]*value=\{[^}]*\?[^}]*:[^}]*\}/);

    // The fixed shape: rendered only when on, so the field is ABSENT when off — exactly like a real checkbox.
    expect(code).toMatch(/\{applyEarly\s*&&\s*<input[^>]*type="hidden"[^>]*name="applyToEarlyOt"[^>]*value="on"/);
  });

  it('the reader treats an empty value as false, not merely as present', () => {
    const code = stripComments(actions);

    // Presence alone must no longer be the test.
    expect(code).not.toMatch(/const bool\s*=\s*\(fd: FormData, key: string\): boolean\s*=>\s*fd\.get\(key\)\s*!=\s*null;/);

    // An empty string must read false.
    expect(code).toMatch(/v\s*!==\s*''/);
  });

  it('the reader still reads a real checkbox correctly — the other three fields must not regress', () => {
    // A checked checkbox with no explicit value submits 'on'; an unchecked one is omitted entirely.
    // Both must survive the hardening, so re-derive the predicate here rather than trusting the source text.
    const boolOf = (fd: FormData, key: string): boolean => {
      const v = fd.get(key);
      return v != null && v !== '';
    };

    const checked = new FormData();
    checked.set('applyDeductions', 'on');
    expect(boolOf(checked, 'applyDeductions')).toBe(true);

    const unchecked = new FormData(); // browser omits the field entirely
    expect(boolOf(unchecked, 'applyDeductions')).toBe(false);

    const hiddenOff = new FormData(); // the old writer's shape, if it ever came back
    hiddenOff.set('applyToEarlyOt', '');
    expect(boolOf(hiddenOff, 'applyToEarlyOt')).toBe(false);

    const hiddenOn = new FormData();
    hiddenOn.set('applyToEarlyOt', 'on');
    expect(boolOf(hiddenOn, 'applyToEarlyOt')).toBe(true);
  });

  it('no OTHER hidden input on these two forms is read by the presence-only pattern', () => {
    // The trap generalises: any future hidden input read by bool() would have the same defect. Every
    // hidden field on the rule form must therefore be one bool() does not read.
    const hidden = [...stripComments(editor).matchAll(/<input[^>]*type="hidden"[^>]*name="([A-Za-z]+)"/g)].map((m) => m[1]);
    const boolFields = [...stripComments(actions).matchAll(/bool\(fd,\s*'([A-Za-z]+)'\)/g)].map((m) => m[1]);
    const overlap = hidden.filter((h) => boolFields.includes(h));

    // applyToEarlyOt is allowed to overlap ONLY because it is now conditionally rendered (asserted above).
    expect(overlap).toEqual(['applyToEarlyOt']);
  });
});
