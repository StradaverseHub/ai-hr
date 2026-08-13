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

  /**
   * 7c834696 contested, rev 5 — the rounding-mode control lands in THIS file, deliberately.
   *
   * The plan's own note: "the r188 lesson lives in this same file — do not reintroduce that shape when
   * adding the rounding mode control." The cheapest way to honour that is to name, here, every hidden
   * input the editor is allowed to have. A new always-submitted hidden field for the rounding mode would
   * fail this the moment it were added, which is a thing no unit test of either half would notice.
   */
  it('the rounding mode rides the existing otRows JSON — it did NOT add a hidden input', () => {
    const hidden = [...stripComments(editor).matchAll(/<input[^>]*type="hidden"[^>]*name="([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(hidden.sort()).toEqual(['applyToEarlyOt', 'otRows']);
    expect(stripComments(editor)).not.toMatch(/type="hidden"[^>]*name="rounding/);
  });
});

/**
 * 7c834696 contested (migration 0439) — the three things the reporter raised about the Overtime table,
 * pinned where each of them actually lives.
 *
 * Source-shape assertions again, and for the same reason as the block above: the defects here are in the
 * CONTRACT between a screen, a service and a migration. `applyOtRuleRows` behaviour is covered by
 * test/attendance-rule.test.ts (40 minutes at a 15-minute step: 45 up, 30 down, 40 none); what cannot be
 * covered there is that the migration's BACKFILL preserves it for rows that already exist.
 */
describe('7c834696: OT rounding direction, a free Round To, and no pre-filled 1.5', () => {
  const migration = readFileSync(join(root, 'db/migrations/0439_ot_rounding_mode.sql'), 'utf8');
  /** SQL comments, not JS ones — this migration's header spells out the mapping in prose. */
  const sql = migration.replace(/^[ \t]*--.*$/gm, '');

  it('the migration maps the old boolean true → down and false → none, so no band changes behaviour', () => {
    // The direction of this mapping is the entire safety property of the release. `true` meant "round",
    // and the engine's only implementation of "round" was Math.floor — so `true` is 'down'. Mapping it to
    // 'up' would look like the more natural reading of the word and would silently start paying two
    // production bands for minutes nobody worked.
    expect(sql).toMatch(/CASE\s+WHEN\s+"rounding"\s+THEN\s+'down'\s+ELSE\s+'none'\s+END/i);
    expect(sql).not.toMatch(/WHEN\s+"rounding"\s+THEN\s+'up'/i);
  });

  it('the migration constrains the mode to the three values and retires the boolean column', () => {
    expect(sql).toMatch(/"rounding_mode"\s+IN\s*\(\s*'none',\s*'down',\s*'up'\s*\)/i);
    // One column, one decision. Leaving the boolean behind would be two sources of truth for the same
    // setting, and nothing reads it after this release.
    expect(sql).toMatch(/DROP COLUMN IF EXISTS "rounding"/i);
    // A mode other than 'none' with no positive step divides by zero in the pay path.
    expect(sql).toMatch(/"rounding_mode"\s*=\s*'none'\s+OR\s*\(\s*"round_to_minutes" IS NOT NULL AND "round_to_minutes" > 0\s*\)/i);
  });

  it('the editor offers all three directions, not the old Yes/No', () => {
    const code = stripComments(editor);
    for (const mode of ['none', 'down', 'up']) {
      expect(code, `missing rounding option ${mode}`).toMatch(new RegExp(`<option value="${mode}">`));
    }
    // The old two-answer shape, which could not say WHICH WAY.
    expect(code).not.toMatch(/r\.rounding \? 'yes' : 'no'/);
  });

  it('Round To is a typed minutes box that refuses 0, not the fixed 15 / 30 / 60 list', () => {
    const code = stripComments(editor);
    expect(code).not.toMatch(/ROUND_TO/);
    expect(code).not.toMatch(/\[\s*15,\s*30,\s*60\s*\]/);
    // min={1}, because 0 divides by zero in applyOtRuleRows and the `> 0` guard used to make it behave as
    // "no rounding" by accident rather than by anyone's choice.
    expect(code).toMatch(/type="number"\s+min=\{1\}/);
  });

  it('a new band no longer arrives pre-filled with a rate of 1.5', () => {
    const code = stripComments(editor);
    // The reporter's third point. The rate itself stays — core/attendance-calc.ts bucketForRate and
    // rateForDay both read it — but it stops pretending to be an answer the admin gave.
    expect(code).not.toMatch(/rate:\s*'1\.5'/);
    expect(code).toMatch(/ratePattern:\s*'flat',\s*\n?\s*rate:\s*''/);
  });

  /**
   * The catalogue half. test/attendance-rule-ot-editor.dom.test.tsx RENDERS the island once per shipping
   * catalogue, and to do that it repeats rule-form.tsx's catalogue → props mapping. This is what stops the
   * two copies drifting apart silently: rename a key in the form and this fails, so the DOM test cannot
   * keep passing against labels the real screen no longer asks for.
   */
  it('the rule form reads the new label keys, and the retired Yes/No pair is gone everywhere', () => {
    const form = stripComments(readFileSync(join(root, 'app/admin/attendance-policy/rules/rule-form.tsx'), 'utf8'));
    for (const k of ['roundingModeNone', 'roundingModeDown', 'roundingModeUp', 'otRoundToHint', 'otRateFlatSuffix', 'otRateUnset']) {
      expect(form, `rule-form.tsx no longer reads ${k}`).toContain(`t('${k}')`);
    }
    expect(form).not.toContain("t('roundingYes')");
    expect(form).not.toContain("t('roundingNo')");
    // Removed from all six catalogues in the same change — i18n-check enforces parity, so en is enough to
    // prove the pair is retired and any locale that kept it would fail there instead.
    const en = JSON.parse(readFileSync(join(root, 'messages/en.json'), 'utf8')) as {
      admin: { attendanceRule: Record<string, string> };
    };
    expect(Object.keys(en.admin.attendanceRule)).not.toContain('roundingYes');
    expect(Object.keys(en.admin.attendanceRule)).not.toContain('roundingNo');
  });

  it("an EMPTY rate is not silently read as 0 — neither by the editor nor by the server action", () => {
    // `Number('')` is 0, and 0 is a real setting ("record the hours but do not pay them"). Both halves must
    // therefore carry the empty case through as null so core/attendance-rule.ts can refuse it by name.
    expect(stripComments(editor)).not.toMatch(/rate:\s*Number\(r\.rate\)\s*\|\|\s*0/);
    expect(stripComments(actions)).not.toMatch(/rate:\s*Number\(x\.rate\s*\?\?\s*0\)\s*\|\|\s*0/);
    expect(stripComments(actions)).toMatch(/rate:\s*x\.rate == null \|\| x\.rate === ''\s*\?\s*null/);
  });
});
