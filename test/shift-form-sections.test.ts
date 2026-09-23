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
/**
 * aec53564 (r331) — A FOURTH FILE, AND THE GUARD IS WIDENED RATHER THAN RELAXED.
 *
 * The Schedule Group picker (`name="attendanceRuleId"`) moved out of shift-form.tsx and into its own client
 * island so the working-day row can follow it live. It is STILL one of the fields shiftFields() reads off
 * the POST, so it must still be proved to render — and the way to keep proving that is to add the file the
 * input moved to, never to except the field. Dropping `attendanceRuleId` into an exception list instead
 * would have re-opened precisely the hole this test exists for: the write is a full-row overwrite, so an
 * input that stops rendering nulls a column on the next save.
 */
const GROUP_ISLAND = read('components/shift-schedule-group.tsx');
/** Everything the form POSTS from, in one string — the sections are spread across four components. */
const RENDERED = FORM + TIME_FIELDS + OT_FIELDS + GROUP_ISLAND;

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

  /**
   * The point-8 rename moved "earliest / latest accepted clocking" wording ONTO early_in / late_out. The
   * Semi-Flexi variants of startTime / endTime still said "Earliest time in" / "Latest time out" — the
   * phrases that had just been given away — and the redesign put all four boxes in ONE four-column row.
   * Two boxes on one line both claiming to be the earliest is how an operator types the early-in value
   * into start_time, which is a SCHEDULING column: it moves the shift span, netScheduledMinutes and the
   * workday OT window. The hint underneath compounded it by naming "Time in" and "Time out", which are
   * not on screen at all when the shift is Semi Flexi.
   */
  it('the Semi Flexi wording does not collide with the renamed pair, and the hint names real boxes', () => {
    const en = JSON.parse(read('messages/en.json')) as { roster: Record<string, string>; admin: { attendancePolicy: Record<string, string> } };
    const r = en.roster;
    const ap = en.admin.attendancePolicy;

    expect(TIME_FIELDS, 'the borrowed wording must not come back on start_time / end_time').not.toMatch(
      /t\('(earliestTimeIn|latestTimeOut)'\)/,
    );
    expect(TIME_FIELDS, 'the Semi-Flexi pair is named for what it is: the window').toContain("t('semiFlexiWindowStart')");
    expect(TIME_FIELDS).toContain("t('semiFlexiWindowEnd')");

    // The hint NAMES boxes, so it has to follow the same type switch the boxes do.
    expect(TIME_FIELDS, 'the clock-window hint is type-aware').toContain("ta('shiftClockWindowHintSemi')");
    expect(ap.shiftClockWindowHint, 'the Normal hint names the Normal boxes').toContain(r.timeIn);
    expect(ap.shiftClockWindowHint).toContain(r.timeOut);
    expect(ap.shiftClockWindowHintSemi, 'the Semi hint names the Semi boxes').toContain(r.semiFlexiWindowStart);
    expect(ap.shiftClockWindowHintSemi).toContain(r.semiFlexiWindowEnd);
    // …and names no box that is absent on that shift type. The renamed pair IS on screen, so strip those
    // two labels first — "Shift Time Out" must not be read as the "Time out" box.
    const semiOnly = ap.shiftClockWindowHintSemi.split(ap.shiftEarlyIn).join('').split(ap.shiftLateOut).join('');
    expect(semiOnly, 'a Semi Flexi shift has no "Time in" box for the hint to name').not.toContain(r.timeIn);
    expect(semiOnly, 'and no "Time out" box either').not.toContain(r.timeOut);

    // The sequence hint (request point 13) is drawn by the SERVER component, which cannot follow a type
    // dropdown that lives in the client island — so it must name NO box whose label changes with the type.
    // It used to say "the shift start time cannot be after Time in", which is wrong on half the shifts.
    const seqOnly = ap.shiftTimeSequenceHint.split(ap.shiftEarlyIn).join('').split(ap.shiftLateOut).join('');
    for (const [label, value] of [
      ['Time in', r.timeIn],
      ['Time out', r.timeOut],
      ['the Semi-Flexi window pair', r.semiFlexiWindowStart],
      ['the Semi-Flexi window pair', r.semiFlexiWindowEnd],
    ] as const) {
      expect(seqOnly, `the sequence hint renders on BOTH shift types, so it must not name ${label}`).not.toContain(value);
    }
  });

  it('the Fixed tick is not left telling the operator to untick a control it has disabled', () => {
    // Semi Flexi already forced every break flexible; 6340aecb's shift-level allowance does the same, so
    // the tick is disabled in BOTH states — and the sentence beside it has to stop saying "Untick it".
    expect(TIME_FIELDS, 'the tick is decided for the operator whenever every break is flexible').toContain(
      'disabled={semiFlexi || flexOn}',
    );
    expect(TIME_FIELDS, 'and the hint says so instead of asking for an impossible click').toContain(
      "t('breakFixedLockedHint')",
    );
  });
});

/**
 * EVERY LABEL ON THE REDESIGNED SCREEN RESOLVES — IN THE NAMESPACE IT IS ACTUALLY ASKED FROM.
 *
 * A 200 is not a render check: a MISSING_MESSAGE passes tsc, passes the suite and still returns a page.
 * test/i18n-coverage.test.ts's check C only walks files that use ONE namespace, and all three files here
 * use two (roster + admin.attendancePolicy), so none is covered by it — which is precisely the gap a
 * redesign that moves fields between two components falls into.
 *
 * ⚠️ THE FIRST VERSION OF THIS GUARD WAS ALMOST VACUOUS, AND A VERIFIER PROVED IT. It kept a key only when
 * it resolved in NEITHER namespace, so the one mistake a two-namespace file actually makes — reaching for
 * the WRONG TRANSLATOR — could not fail it: changing `ta('shiftEarlyIn')` to `t('shiftEarlyIn')` in
 * components/shift-time-fields.tsx (where `t` is bound to `roster`, which has no such key) renders a
 * literal MISSING_MESSAGE on screen and left all nine cases GREEN. Worse, the two files disagree about
 * what `t` MEANS: in shift-time-fields.tsx `t` is roster and `ta` is admin.attendancePolicy, while in
 * shift-form.tsx `t` is admin.attendancePolicy and `tr` is roster. A guard that pools the namespaces
 * cannot see that at all.
 *
 * So the binding is read off each file's own `useTranslations` / `getTranslations` call, and every key is
 * checked against the namespace of the translator it was asked through — nothing else.
 */
describe('6340aecb — every message key the shift screen asks for exists', () => {
  const en = JSON.parse(read('messages/en.json')) as Record<string, unknown>;
  const lookup = (dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

  /** `const t = useTranslations('roster')` / `const t = await getTranslations('admin.attendancePolicy')`
   *  ⇒ alias → namespace, per file. This is the whole point of the guard: the alias is not the namespace. */
  function translatorNamespaces(src: string): Map<string, string> {
    const out = new Map<string, string>();
    const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\('([A-Za-z0-9_.]+)'\)/g;
    for (const m of src.matchAll(re)) out.set(m[1], m[2]);
    return out;
  }

  /** Every (namespace, key) this file asks for: static `alias('key')` calls, plus the values of the
   *  `*_KEY` maps a call indexes — `ta(DAY_KEY[d])` asks all seven of DAY_KEY's values through `ta`. */
  function askedFor(src: string): { ns: string; key: string; where: string }[] {
    const aliases = translatorNamespaces(src);
    expect(aliases.size, 'the guard must be able to see which namespace each translator is bound to').toBeGreaterThan(0);
    // Longest first: `(t|tr)` would try `t` against `tr('…')` before `tr`, and a lucky backtrack is not a
    // property worth relying on.
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
    ['app/admin/attendance/shift-form.tsx', FORM, 40],
    ['components/shift-time-fields.tsx', TIME_FIELDS, 40],
    ['components/shift-ot-window-fields.tsx', OT_FIELDS, 5],
    // aec53564 — the fourth file of the screen. It uses ONE namespace, so i18n-coverage's check C would
    // cover it, but the four keys it asks for are the sentence that explains a control the operator cannot
    // click: a MISSING_MESSAGE there is the whole feature reading as a bug.
    ['components/shift-schedule-group.tsx', GROUP_ISLAND, 5],
  ] as const) {
    it(`${label} — every key resolves in the namespace its own translator is bound to`, () => {
      const asked = askedFor(src);
      // A parse that quietly stopped finding call sites would pass an empty filter. Pin the floor so the
      // guard fails LOUDLY if the file's shape ever outruns the regexes above.
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
