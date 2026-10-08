/**
 * 6340aecb → r429 (f6819e19) — the Shift Settings screen's fields, and the guard that says the redesign
 * did not quietly drop one.
 *
 * WHY A SOURCE-SHAPE TEST AND NOT A UNIT TEST OF EITHER HALF. The defect this protects against lives in
 * the CONTRACT BETWEEN two files: shiftFields() in app/admin/attendance/shift-actions.ts is a FULL-ROW
 * OVERWRITE for the fields still ON the form, and most of the rest are deliberately UNDEFINED-MEANS-
 * PRESERVE (core/roster.ts). So an input that stops rendering either NULLS a column on the next save (the
 * still-rendered set) or silently depends on the action never reading it (the retired set) — and every
 * test of either file on its own would still pass either way. This is what keeps the two in step.
 *
 * r429 (f6819e19) — REWRITTEN for the three-section redesign (D1-D4 of the approved plan). GONE from this
 * screen, and therefore from this guard: the seven `dayKind_<n>` selects (D1 — the week is the Schedule
 * Group's now), the `attendanceRuleId` picker and its own file `components/shift-schedule-group.tsx`
 * (D2 — deleted, nothing imports it any more), and the whole-shift `flexibleBreakEnabled` switch as a
 * directly-settable field (D4 — it survives ONLY as an explicit "Stop using it" tick, `stopFlexibleBreak`,
 * that can turn it off and never on).
 *
 * DB-free and deliberately static: it reads the three source files as text.
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

/**
 * ⚠️ COMMENTS STRIPPED, AND A MUTATION IS WHY.
 *
 * The check below is `RENDERED.includes('name="x"')`, so ANY prose copy of the attribute satisfies it —
 * and a file that documents the input it renders naturally contains one. Block comments (including JSX
 * comment wrappers) and whole-line `//` comments only — a trailing `//` on a line of code is left alone
 * rather than risk eating a string, and none of these files hides an input behind one.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Everything the form POSTS from, in one string — Shift Information + the closed details live in FORM,
 *  Working Time + Breaks live in TIME_FIELDS, the Overtime grid in OT_FIELDS. */
const RENDERED = stripComments(FORM + TIME_FIELDS + OT_FIELDS);

/**
 * The form fields shiftFields() reads off the POST. Collected from the call shapes rather than from a
 * hand-written list, so a field added to the action without an input is caught as well as an input
 * deleted from the form.
 */
function postedFieldNames(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/formData\.(?:get|getAll)\('([A-Za-z0-9_]+)'\)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bopt(?:Str|Time|Num)\(formData,\s*'([A-Za-z0-9_]+)'\)/g)) names.add(m[1]);
  return [...names].sort();
}

/**
 * r429 (f6819e19) · D4 — `stopFlexibleBreak` is read by shiftFields() but is not itself a form field with
 * `name="stopFlexibleBreak"` on the Flexible-break checkbox — it IS one, inside the locked panel
 * (components/shift-time-fields.tsx). It renders only conditionally (the panel shows only for a shift the
 * migration could not convert), so a plain substring sweep over default-props output would not see it; it
 * is pinned by name below instead.
 */
const NOT_ALWAYS_RENDERED = new Set(['stopFlexibleBreak']);

describe('r429 (f6819e19) — the redesigned Shift form still posts every field the action reads', () => {
  it('every posted field name has an input rendering it (or is named as a known exception)', () => {
    const missing = postedFieldNames(ACTIONS)
      .filter((n) => !NOT_ALWAYS_RENDERED.has(n))
      .filter((n) => !RENDERED.includes(`name="${n}"`));
    expect(
      missing,
      `shiftFields() reads these off the POST but no input renders them. Because the write is a FULL-ROW ` +
        `OVERWRITE for the fields still on this form, each one would be NULLED on the next save: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the retired week/group/general fields are NOT read off the POST at all (D1-D3)', () => {
    // undefined-means-preserve only works because the action never sets these keys — if it read any of
    // them off the post, an absent box would again be indistinguishable from "clear it". Checked against
    // the SAME extraction `postedFieldNames` uses (real formData.get/getAll/opt* call sites), not a raw
    // substring search, so a mention in prose cannot fail or satisfy this case either way.
    const posted = new Set(postedFieldNames(ACTIONS));
    for (const name of ['dayKind_1', 'weeklyPattern', 'halfPattern', 'offPattern', 'attendanceRuleId', 'shiftDayType', 'fullDayLeaveMinutes', 'fullDayOtMinutes']) {
      expect(posted.has(name), `${name} must not be read off the POST — its editor left the form`).toBe(false);
    }
  });

  it('`components/shift-schedule-group.tsx` is gone — the picker and the greying it drove are retired', () => {
    expect(() => read('components/shift-schedule-group.tsx')).toThrow();
  });

  it('the whole-shift Flexible switch cannot be turned ON from this screen', () => {
    // No checkbox posts `flexibleBreakEnabled` directly any more — only `stopFlexibleBreak`, which
    // core/roster.ts (updateShift) refuses to turn into `true` when the stored value is not already true.
    expect(RENDERED).not.toContain('name="flexibleBreakEnabled"');
    expect(TIME_FIELDS, 'the one surviving control can only switch it OFF').toContain('name="stopFlexibleBreak"');
  });

  it('the two 6340aecb fields are rendered and read: the colour and the per-row Flexible tick', () => {
    expect(RENDERED, 'colour must render').toContain('name="color"');
    // D4 — Flexible is now per-row, inside the breakPeriods JSON, not a named input of its own; its
    // PRESENCE as a control is what is pinned here.
    expect(TIME_FIELDS, 'the per-row Flexible tick must render').toContain("t('breakFlexibleLabel')");
  });

  it('the overtime schedule stays MOUNTED behind its disclosure (a <details>, never a conditional)', () => {
    // A conditional render would unmount the grid and the next save would delete every window.
    expect(FORM).toContain('<details');
    expect(FORM).not.toMatch(/\{\s*showOtSchedule\s*&&/);
    expect(OT_FIELDS).toContain('name="otWindows"');
  });
});

describe('r429 (f6819e19) — the screen the plan asked for', () => {
  it('is FULL WIDTH (6340aecb request point 3, carried forward)', () => {
    expect(FORM).toContain('pageWideCls');
    expect(FORM).not.toContain('max-w-3xl');
  });

  it('renders the three numbered sections plus the closed fourth', () => {
    expect(FORM).toContain("t('shiftInformationLegend')");
    expect(TIME_FIELDS).toContain("t('workingTimeLegend')");
    expect(TIME_FIELDS).toContain("t('breaksLabel')");
    expect(FORM).toContain("t('shiftOvertimePayLegend')");
  });

  it('surfaces the half-day pair in Working Time (request point 9, carried forward)', () => {
    expect(TIME_FIELDS).toContain('name="halfDayFirstOut"');
    expect(TIME_FIELDS).toContain('name="halfDaySecondIn"');
  });

  it('the Semi Flexi wording does not collide with the renamed pair, and the hint names real boxes', () => {
    const en = JSON.parse(read('messages/en.json')) as { roster: Record<string, string>; admin: { attendancePolicy: Record<string, string> } };
    const r = en.roster;
    const ap = en.admin.attendancePolicy;

    expect(TIME_FIELDS, 'the borrowed wording must not come back on start_time / end_time').not.toMatch(
      /t\('(earliestTimeIn|latestTimeOut)'\)/,
    );
    expect(TIME_FIELDS, 'the Semi-Flexi pair is named for what it is: the window').toContain("t('semiFlexiWindowStart')");
    expect(TIME_FIELDS).toContain("t('semiFlexiWindowEnd')");
    expect(ap.shiftEarlyIn, 'relabelled to what the box actually is (D3)').toMatch(/clock-in/i);
    expect(ap.shiftLateOut, 'relabelled to what the box actually is (D3)').toMatch(/clock-out/i);
  });

  it('D5 — a scalar-only shift is offered the labelled box only when it has no break rows', () => {
    expect(TIME_FIELDS).toContain('isScalarOnlySource');
    expect(TIME_FIELDS).toContain("t('breakScalarOnlyLabel')");
  });

  it('D4 — a shift the migration could not convert shows the "Stop using it" panel, never a live switch', () => {
    expect(TIME_FIELDS).toContain('flexLocked');
    expect(TIME_FIELDS).toContain("t('breakStopUsingTick')");
  });
});

/**
 * EVERY LABEL ON THE REDESIGNED SCREEN RESOLVES — IN THE NAMESPACE IT IS ACTUALLY ASKED FROM.
 *
 * A 200 is not a render check: a MISSING_MESSAGE passes tsc, passes the suite and still returns a page.
 * test/i18n-coverage.test.ts's check C only walks files that use ONE namespace, and these files use two
 * (roster + admin.attendancePolicy), so neither is covered by it.
 *
 * The binding is read off each file's own `useTranslations` / `getTranslations` call, and every key is
 * checked against the namespace of the translator it was asked through — nothing else (see the r331 note
 * this inherits: pooling the namespaces would miss a key reached through the WRONG translator).
 */
describe('r429 (f6819e19) — every message key the shift screen asks for exists', () => {
  const en = JSON.parse(read('messages/en.json')) as Record<string, unknown>;
  const lookup = (dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

  function translatorNamespaces(src: string): Map<string, string> {
    const out = new Map<string, string>();
    const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\('([A-Za-z0-9_.]+)'\)/g;
    for (const m of src.matchAll(re)) out.set(m[1], m[2]);
    return out;
  }

  function askedFor(src: string): { ns: string; key: string; where: string }[] {
    const aliases = translatorNamespaces(src);
    expect(aliases.size, 'the guard must be able to see which namespace each translator is bound to').toBeGreaterThan(0);
    const names = [...aliases.keys()].sort((a, b) => b.length - a.length).join('|');
    const out: { ns: string; key: string; where: string }[] = [];
    for (const m of src.matchAll(new RegExp(`\\b(${names})\\('([A-Za-z0-9_.]+)'`, 'g'))) {
      out.push({ ns: aliases.get(m[1])!, key: m[2], where: `${m[1]}('${m[2]}')` });
    }
    for (const m of src.matchAll(new RegExp(`\\b(${names})\\(([A-Z][A-Z0-9_]*_KEY)\\b`, 'g'))) {
      const block = src.match(new RegExp(`const ${m[2]}[^=]*=\\s*\\{([^}]*)\\}`));
      expect(block, `${m[2]} must be a plain object literal this guard can read`).not.toBeNull();
      for (const v of block![1].matchAll(/'([A-Za-z0-9_]+)'/g)) {
        out.push({ ns: aliases.get(m[1])!, key: v[1], where: `${m[1]}(${m[2]}.…)` });
      }
    }
    return out;
  }

  for (const [label, src, least] of [
    ['app/admin/attendance/shift-form.tsx', FORM, 30],
    ['components/shift-time-fields.tsx', TIME_FIELDS, 40],
    ['components/shift-ot-window-fields.tsx', OT_FIELDS, 5],
  ] as const) {
    it(`${label} — every key resolves in the namespace its own translator is bound to`, () => {
      const asked = askedFor(src);
      expect(asked.length, `${label}: the guard found almost no translator calls — has the file changed shape?`).toBeGreaterThanOrEqual(
        least,
      );
      const unresolved = asked.filter(({ ns, key }) => typeof lookup(`${ns}.${key}`) !== 'string');
      expect(
        [...new Set(unresolved.map((a) => `${a.where} → no ${a.ns}.${a.key}`))],
        'these render a literal MISSING_MESSAGE on the screen — the key is missing, or it was asked through the wrong translator',
      ).toEqual([]);
    });
  }
});
