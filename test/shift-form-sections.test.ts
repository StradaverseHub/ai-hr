/**
 * 6340aecb — the Shift Settings screen was reorganised into four sections, and this is the guard that says
 * the reorganisation did not quietly drop a field.
 *
 * WHY A SOURCE-SHAPE TEST AND NOT A UNIT TEST OF EITHER HALF. The defect this protects against lives in
 * the CONTRACT BETWEEN two files: shiftFields() in app/admin/attendance/shift-actions.ts is a FULL-ROW
 * OVERWRITE and most of its keys are deliberately absent-means-null (core/roster.ts). So an input that
 * stops rendering does not fail — it succeeds, and NULLS a column on the next save. MB28 would lose its
 * early_in, its late_out, its overtime schedule and the shift-premium pair core/payroll.ts
 * prefillShiftDifferential reads, and every test of either file on its own would still pass. The old form
 * kept those inputs alive inside a <details> for exactly this reason; the redesign keeps them alive by
 * putting them in a visible section, and this test is what keeps the next redesign honest.
 *
 * DB-free and deliberately static: it reads the four source files as text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');

const ACTIONS = read('app/admin/attendance/shift-actions.ts');
const FORM = read('app/admin/attendance/shift-form.tsx');
const TIME_FIELDS = read('components/shift-time-fields.tsx');
const OT_FIELDS = read('components/shift-ot-window-fields.tsx');
/** Everything the form POSTS from, in one string — the sections are spread across three components. */
const RENDERED = FORM + TIME_FIELDS + OT_FIELDS;

/**
 * The form fields shiftFields() (and the two actions around it) read off the POST. Collected from the call
 * shapes rather than from a hand-written list, so a field added to the action without an input is caught
 * as well as an input deleted from the form.
 *
 * The patterns require an actual CALL — `formData.get('x')`, `optTime(formData, 'x')` — because a
 * source-scanning guard does not strip comments, and a prose mention of a field name must not be able to
 * fail this test or to satisfy it.
 */
function postedFieldNames(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/formData\.(?:get|getAll)\('([A-Za-z0-9_]+)'\)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bopt(?:Str|Time|Num)\(formData,\s*'([A-Za-z0-9_]+)'\)/g)) names.add(m[1]);
  return [...names].sort();
}

/**
 * `weeklyPattern` is READ but deliberately NOT RENDERED. b8aa3466 replaced the seven checkboxes with seven
 * four-way dropdowns and kept the old checkbox name as a FALLBACK so any caller or test posting the old
 * shape keeps working. It is the one documented exception, and it is listed here rather than skipped by a
 * pattern so that adding a second exception has to be a deliberate act.
 */
const NOT_RENDERED_BY_DESIGN = new Set(['weeklyPattern']);

describe('6340aecb — the four-section Shift form still posts every field the action reads', () => {
  it('every posted field name has an input rendering it', () => {
    const missing = postedFieldNames(ACTIONS)
      .filter((n) => !NOT_RENDERED_BY_DESIGN.has(n))
      .filter((n) => !RENDERED.includes(`name="${n}"`));
    expect(
      missing,
      `shiftFields() reads these off the POST but no input renders them. Because the write is a FULL-ROW ` +
        `OVERWRITE with absent-means-null semantics, each one would be NULLED on the next save: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the seven weekday dropdowns are rendered from the same dayKind_ prefix the action decodes', () => {
    expect(ACTIONS).toContain('`dayKind_${d}`');
    expect(TIME_FIELDS).toContain('name={`dayKind_${d}`}');
  });

  it('the two NEW fields are rendered and read: the colour and the flexible break', () => {
    for (const field of ['color', 'flexibleBreakEnabled', 'flexibleBreakMinutes']) {
      expect(RENDERED, `${field} must render`).toContain(`name="${field}"`);
    }
    // The switch is a REAL checkbox, never a hidden input: a hidden input is submitted whatever its value,
    // so presence would read an unticked box as TRUE — which is how a pay-affecting setting nobody could
    // turn off once shipped. Assert the read is by presence AND that nothing hides it.
    expect(ACTIONS).toContain("formData.get('flexibleBreakEnabled') != null");
    expect(TIME_FIELDS).not.toContain('type="hidden" name="flexibleBreakEnabled"');
  });

  it('the overtime schedule stays MOUNTED behind its disclosure (a <details>, never a conditional)', () => {
    // A conditional render would unmount the grid and the next save would delete every window.
    expect(FORM).toContain('<details');
    expect(FORM).not.toMatch(/\{\s*showOtSchedule\s*&&/);
    expect(OT_FIELDS).toContain('name="otWindows"');
  });
});

describe('6340aecb — the screen the reporter asked for', () => {
  it('is FULL WIDTH (request point 3)', () => {
    expect(FORM).toContain('pageWideCls');
    expect(FORM).not.toContain('max-w-3xl');
  });

  it('renders the four named sections (request points 4 + 5)', () => {
    // Shift Identification and General Controls are the server component's own; Working Times and Breaks
    // are the island's, because the two of them share state.
    expect(FORM).toContain("t('shiftIdentificationLegend')");
    expect(FORM).toContain("t('generalSectionLegend')");
    expect(TIME_FIELDS).toContain("t('workingTimesLegend')");
    expect(TIME_FIELDS).toContain("t('breaksLabel')");
  });

  it('surfaces the half-day pair in Working Times rather than in a drawer (request point 9)', () => {
    expect(TIME_FIELDS).toContain('name="halfDayFirstOut"');
    expect(TIME_FIELDS).toContain('name="halfDaySecondIn"');
  });
});

/**
 * EVERY LABEL ON THE REDESIGNED SCREEN RESOLVES.
 *
 * A 200 is not a render check: a MISSING_MESSAGE passes tsc, passes the suite and still returns a page.
 * test/i18n-coverage.test.ts's check C only walks files that use ONE namespace, and both files here use
 * two (roster + admin.attendancePolicy), so neither is covered by it — which is precisely the gap a
 * redesign that moves fields between two components falls into.
 */
describe('6340aecb — every message key the shift screen asks for exists', () => {
  const en = JSON.parse(read('messages/en.json')) as Record<string, unknown>;
  const NS = ['admin.attendancePolicy', 'roster'] as const;
  const lookup = (dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

  /** Static t()/tr()/ta() calls, plus the values of the *_KEY maps those calls index. */
  function keysUsed(src: string): string[] {
    const out = new Set<string>();
    for (const m of src.matchAll(/\b(?:t|tr|ta)\('([A-Za-z0-9_.]+)'/g)) out.add(m[1]);
    for (const block of src.matchAll(/const [A-Z_]+_KEY[^=]*=\s*\{([^}]*)\}/g)) {
      for (const v of block[1].matchAll(/'([A-Za-z0-9_]+)'/g)) out.add(v[1]);
    }
    return [...out].sort();
  }

  for (const [label, src] of [
    ['app/admin/attendance/shift-form.tsx', FORM],
    ['components/shift-time-fields.tsx', TIME_FIELDS],
  ] as const) {
    it(`${label} — no key falls outside both namespaces`, () => {
      const unresolved = keysUsed(src).filter((k) => NS.every((ns) => typeof lookup(`${ns}.${k}`) !== 'string'));
      expect(unresolved, `these would render as MISSING_MESSAGE: ${unresolved.join(', ')}`).toEqual([]);
    });
  }
});
