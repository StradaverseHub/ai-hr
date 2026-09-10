/**
 * Feedback 4a1abc4a — "Standardize Entitlement Decimal Precision to 2 Decimal Places".
 *
 * WHAT WAS REPRODUCED BEFORE ANY CODE WAS WRITTEN, because the request's premise turned out to be half
 * satisfied already. Every entitlement and leave day figure is stored at 2dp and always was:
 * `leave_ledger.days`, `leave_type.carry_forward_max`, `max_days_per_leave_year`, `max_consecutive_days`
 * and `max_negative_balance` are `numeric(6,2)`; `carry_forward_percent` is `numeric(5,2)`. So there is no
 * migration here and NOT ONE FIGURE MOVES. What was inconsistent was the PRINTING, and this file guards
 * the fix in the two ways it can go wrong.
 *
 * ═══ WHAT THIS FILE IS ACTUALLY DEFENDING ═══
 *
 * 1. THE FORMATTER'S BEHAVIOUR, especially at null. Several leave and attendance screens deliberately
 *    distinguish "no engine computed this" from "the figure is zero" and say so with an em dash. A
 *    formatter that helpfully printed 0.00 for an absent figure would assert a zero balance where there is
 *    no balance — a wrong number on a screen about someone's leave. Half these cases exist for that.
 *
 * 2. THAT THERE IS STILL ONLY ONE FORMATTER. The complaint was that two screens showing the same figure
 *    disagreed, and the cause was eight private copies of `toFixed(2)`. Replacing them with a ninth shared
 *    one is only a fix for as long as a tenth does not appear, so the source guards below fail if any of
 *    the eleven day-rendering surfaces grows its own again.
 *
 * ONE THING DELIBERATELY NOT DONE, pinned here so a later reader does not "finish the job":
 *   - THE ENGINE IS UNTOUCHED. No rounding was added to core/leave-compute.ts. Rounding a figure that is
 *     already exact is how a total stops matching the parts printed above it.
 *
 * ═══ THE SECOND PASS: THE ROUNDING TABLE'S THIRD DECIMAL IS GONE ═══
 *
 * This file used to assert the opposite of §3 below — that rounding bands STAY at three decimals, because
 * they are fractions of a day that `checkRoundingBands` compares and snaps at 3dp, and 2dp would render a
 * 0.125 boundary as "0.13" which the on-blur tidier would then save. That reasoning was sound and the
 * assertion was right to exist; what it did not check was whether anyone had ever typed a genuine
 * thousandth. Nobody had. The reporter's screenshot of the rounding table is what re-opened this, and the
 * three tables on production hold nothing but multiples of 0.01 except 0.401 and 0.701 — a notch above
 * 0.400 and 0.700, typed because each row stops just before its Round To and the next row had to start
 * somewhere. The notches left two HOLES: a fraction of exactly 0.400 or 0.700 matched no row at all.
 *
 * So the exception was retired and From was made DERIVED instead — and the assertions below now pin that,
 * including the fraction of exactly 0.40 that used to fall through and now lands in the second band.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

import {
  DAY_DASH,
  DAY_DECIMALS,
  dayPluralCategory,
  formatDayInput,
  formatDays,
  normalizeDayFieldOnBlur,
  normalizeDayText,
} from '@/lib/day-format';
import { applyRoundingBands } from '@/core/leave-compute';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

/** Strip block/line comments so a doc comment QUOTING the old `toFixed(2)` cannot fail a source guard. */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('4a1abc4a · the shared day formatter', () => {
  it('WIDENS a day figure to 2dp — the reporter\'s three spellings become one', () => {
    // The whole request in one assertion: 12, 12.0 and 12.00 are the same number and now read the same.
    expect(formatDays(12)).toBe('12.00');
    expect(formatDays(12.0)).toBe('12.00');
    expect(formatDays(12.5)).toBe('12.50');
    expect(formatDays(0.5)).toBe('0.50');
    expect(DAY_DECIMALS).toBe(2);
  });

  it('accepts the STRINGS a numeric column actually returns', () => {
    // The pg driver hands back numeric(6,2) as text. Making every caller remember to Number() it first is
    // how one of them eventually forgets and the screen prints NaN.
    expect(formatDays('12.50')).toBe('12.50');
    expect(formatDays('12.5')).toBe('12.50');
    expect(formatDays('12')).toBe('12.00');
    expect(formatDays('-2.5')).toBe('-2.50');
  });

  it('renders an ABSENT figure as the em dash — never 0.00', () => {
    // THE ONE PLACE FORMATTING IS LOAD-BEARING. "No engine computed this" is not "zero", and the screens
    // that draw that distinction (the r162 Lateness / Early Out columns, ESS-hidden balance cells) rely on
    // it. Every shape of absence lands on the same placeholder.
    for (const absent of [null, undefined, '', '   ', 'abc', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatDays(absent), `${String(absent)} must not render as a number`).toBe(DAY_DASH);
    }
    expect(DAY_DASH).toBe('—');
  });

  it('renders a REAL zero as 0.00 — the distinction cuts both ways', () => {
    // If null became 0.00 the screen would invent a balance. If 0 became an em dash it would hide one.
    expect(formatDays(0)).toBe('0.00');
    expect(formatDays('0')).toBe('0.00');
    expect(formatDays('0.00')).toBe('0.00');
  });

  it('lets a caller choose a different placeholder without changing the digits', () => {
    // The CSV/XLSX export wants an EMPTY cell: an em dash in a spreadsheet is text a reader cannot sum.
    expect(formatDays(null, { placeholder: '' })).toBe('');
    expect(formatDays(3, { placeholder: '' })).toBe('3.00');
  });

  it('does not round anything the engine computed — a total still matches its parts', () => {
    // Every value reaching the formatter is already 2dp, so formatting is a widening, never a narrowing.
    // Printed parts must therefore add up to the printed total; this is the property that breaks the day
    // someone "helpfully" rounds at a render site.
    const parts = [1.25, 2.5, 0.25];
    const total = parts.reduce((a, b) => a + b, 0);
    expect(formatDays(total)).toBe('4.00');
    expect(parts.map((p) => Number(formatDays(p))).reduce((a, b) => a + b, 0)).toBe(Number(formatDays(total)));
  });
});

describe('4a1abc4a · typing into a day field', () => {
  it('tidies what was typed so the field shows what was saved', () => {
    expect(normalizeDayText('12.5')).toBe('12.50');
    expect(normalizeDayText('12')).toBe('12.00');
    expect(normalizeDayText('012.500')).toBe('12.50');
  });

  it('LEAVES A BLANK BOX BLANK', () => {
    // A blank optional day cell means "not set on this row" — `toStoredBands` omits it and `bandCarryMax`
    // falls back to the policy cap. Tidying it to "0.00" would silently persist "carry nothing" on every
    // row an operator merely tabbed through.
    expect(normalizeDayText('')).toBe('');
    expect(normalizeDayText('  ')).toBe('  ');
    expect(formatDayInput(null)).toBe('');
    expect(formatDayInput(undefined)).toBe('');
  });

  it('leaves an unparseable entry alone rather than destroying the keystrokes', () => {
    // Blanking "abc" would lose what was typed AND hide the mistake; the browser and the server refuse it
    // by name instead.
    expect(normalizeDayText('abc')).toBe('abc');
    expect(normalizeDayText('-')).toBe('-');
  });

  it('the blur handler writes the tidied text back onto the input', () => {
    const el = { currentTarget: { value: '12.5' } };
    normalizeDayFieldOnBlur(el);
    expect(el.currentTarget.value).toBe('12.50');

    const blank = { currentTarget: { value: '' } };
    normalizeDayFieldOnBlur(blank);
    expect(blank.currentTarget.value).toBe('');
  });
});

describe('4a1abc4a · rounding bands are TWO decimals now, and From is derived', () => {
  it('there is exactly ONE precision — the band exception is retired from the module', () => {
    // The constant this file used to assert on is gone. Asserted on the SOURCE rather than by importing it,
    // because an import of a removed export is a compile error and would say nothing about why.
    const mod = read('/lib/day-format.ts');
    expect(codeOnly(mod), 'ROUNDING_BAND_DECIMALS must not come back as a second precision').not.toContain(
      'ROUNDING_BAND_DECIMALS',
    );
    expect(DAY_DECIMALS).toBe(2);
    // The header has to keep the RETIRED reasoning, or the next reader re-derives the 3dp carve-out from
    // first principles and puts it back. It was correct; it stopped being load-bearing.
    expect(mod).toContain('ROUNDING_BAND_DECIMALS');
  });

  it('the band editor tidies at DAY precision, and its From column is DERIVED, not typed', () => {
    const panel = codeOnly(
      ['/app/admin/leave-config/types/page.tsx', '/app/admin/leave-config/types/leave-type-tabs.tsx', '/app/admin/leave-config/types/leave-type-sub-forms.tsx']
        .map((f) => read(f))
        .join('\n'),
    );
    // Bands print through the shared formatter at its default — no second precision passed anywhere.
    expect(panel).toMatch(/const bandText = \(v: number\) => formatDays\(v\);/);
    expect(panel).toMatch(/normalizeDayText\(e\.currentTarget\.value\)/);
    expect(panel, 'no band figure may ask for a precision of its own').not.toMatch(/decimals:/);
    // THE STRUCTURAL HALF, and the one that closes the holes: row 0 starts at 0.00 and row n starts at the
    // row above's Round To. A typed From is what produced 0.401 / 0.701 in the first place.
    expect(panel).toMatch(/const fromText = \(rows: BandRow\[\], i: number\): string =>\s*\(i === 0 \? bandText\(0\) : rows\[i - 1\]\.to\);/);
    expect(panel, 'the From cell must be read-only').toMatch(/readOnly[\s\S]{0,200}roundingBandFrom/);
    expect(panel, 'a From cell nobody can type into cannot be patched').not.toMatch(/patch\(i, 'from'/);
    // The steppers follow the precision: a 0.001 step invites the third decimal back through the arrows.
    expect(panel).not.toContain('step="0.001"');
    // The example is "one month of a 14-day entitlement" — a number of DAYS, so it takes the 2dp default.
    expect(panel).toMatch(/formatDays\(ROUNDING_EXAMPLE_RAW\)/);
  });

  it('THE BEHAVIOUR DELTA: a fraction of exactly 0.40 used to fall through a hole and now rounds', () => {
    // The reporter's stored table, before and after. The engine is UNCHANGED — `applyRoundingBands` still
    // snaps the fraction to 3dp and `bandRound` still widens a stored 0.40 to 0.400 — so this test is
    // entirely about the two boundaries the migration moves.
    const before = [
      { from: 0, to: 0.4, result: 0 },
      { from: 0.401, to: 0.7, result: 0.5 },
      { from: 0.701, to: 1, result: 1 },
    ];
    const after = [
      { from: 0, to: 0.4, result: 0 },
      { from: 0.4, to: 0.7, result: 0.5 },
      { from: 0.7, to: 1, result: 1 },
    ];
    // THE HOLES. 10.4 is past the end of row 1 and below the start of row 2, so nothing matched and the
    // value was left exactly as calculated. This is the line the reporter was warned about in the plan.
    expect(applyRoundingBands(10.4, before)).toBe(10.4);
    expect(applyRoundingBands(10.7, before)).toBe(10.7);
    // …and closed. 0.40 now lands in the SECOND band (half a day), 0.70 in the third (a whole day).
    expect(applyRoundingBands(10.4, after)).toBe(10.5);
    expect(applyRoundingBands(10.7, after)).toBe(11);
    // Nothing else moves: every other fraction lands where it always landed.
    for (const [v, want] of [[10.39, 10], [10.401, 10.5], [10.69, 10.5], [10.701, 11], [10.999, 11]] as const) {
      expect(applyRoundingBands(v, after), `fraction ${v}`).toBe(applyRoundingBands(v, before));
      expect(applyRoundingBands(v, after), `fraction ${v}`).toBe(want);
    }
  });

  it('the user-visible refusal moved to two decimals, in ALL SIX locales', () => {
    // MISSING_MESSAGE and a stale figure both pass a 200. The catalogs are read, not assumed.
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const) {
      const sub = JSON.parse(read(`/messages/${loc}.json`)).admin.leave.subStep;
      expect(sub.roundingBandRowInvalid, loc).toContain('0.00');
      expect(sub.roundingBandRowInvalid, loc).toContain('1.00');
      expect(sub.roundingBandRowInvalid, loc).not.toContain('0.000');
      expect(sub.roundingBandRowInvalid, loc).not.toContain('1.000');
      // The help text carries worked figures of its own and must not contradict the table beside it.
      expect(sub.roundingBandsHelp, loc).not.toContain('0.000');
      expect(sub.roundingBandsHelp, loc).not.toContain('1.000');
    }
  });

  it('ROUNDING METHOD IS STILL AN ENUM — no decimals were invented for it', () => {
    // The plan said this out loud rather than silently skipping it: "round up" / "round to nearest half
    // day" is a choice, not a number. The dropdown must stay a <select> over LeaveRoundingMethod, and the
    // day formatter must never be pointed at it.
    const panel = codeOnly(
      ['/app/admin/leave-config/types/page.tsx', '/app/admin/leave-config/types/leave-type-tabs.tsx', '/app/admin/leave-config/types/leave-type-sub-forms.tsx']
        .map((f) => read(f))
        .join('\n'),
    );
    // Still a <select> over the two LeaveRoundingMethod members, not a number box.
    expect(panel).toMatch(/name="roundingMethod"/);
    expect(panel).toMatch(/<option value="none">/);
    expect(panel).toMatch(/<option value="custom">/);
    // …and the enum VALUE is never handed to the day formatter. The regexes anchor on the opening paren so
    // they do not trip on `formatDays(applyRounding(raw, rounding, …))`, which is legitimate: that call
    // formats the DAYS the rule produced, not the rule.
    expect(panel, 'the rounding method is a choice, not a figure').not.toMatch(
      /format(Days|DayInput)\(\s*rounding\s*[,)]/,
    );
    expect(panel).not.toMatch(/format(Days|DayInput)\(\s*roundingMethod/);
    expect(panel).not.toMatch(/roundingMethod[^\n]*toFixed/);
  });
});

describe('4a1abc4a · ONE formatter, and it stays one', () => {
  // Every surface that renders or accepts a day figure in the leave module. The list is the point: the
  // reported fault was that two of them disagreed, and the only durable fix is that none formats for itself.
  //
  // Four of these were found by RENDERING, not by reading code — the Employee Leave Record printed a bare
  // "3" one nav tab away from Employee Balances' "3.00", which is the reporter's complaint verbatim and is
  // invisible to a grep for `toFixed`.
  const SURFACES = [
    '/components/leave/leave-balance-table.tsx',
    '/components/leave/leave-cards.tsx',
    '/components/leave/LeaveDetailsPanel.tsx',
    '/components/leave/secondary-leave-groups.tsx',
    '/components/leave/ReplacementLeavePanel.tsx',
    '/components/leave/leave-request-cells.tsx',
    '/components/leave/leave-history-cards.tsx',
    '/components/leave/entitlement-bands-editor.tsx',
    '/components/leave-balance-card.tsx',
    // a6fe37fc Round 5 — `/components/leave-type-panel.tsx` stood here and was deleted with its page.
    // The day figures it rendered (the rounding-band editor, the carry/expiry fields) are in the sub-forms
    // file; `leave-type-tabs.tsx` composes them and renders no day count of its own, so listing it would
    // demand an import it has no use for — the kind of false requirement that gets a guard relaxed later.
    '/app/admin/leave-config/types/leave-type-sub-forms.tsx',
    '/app/leave/employee-balances/page.tsx',
    '/app/leave/employee-balances/export/route.ts',
    // ee6b7c69 — the Entitlement Tables' day cells moved OUT of templates/page.tsx into the shared block
    // that page and each leave type's Entitlement step both mount. Repointed rather than dropped: this is
    // where the day figures are TYPED, so it is the one surface where the summary line and the editor cell
    // beside it must agree digit for digit, and it now renders on two screens instead of one.
    '/app/admin/leave/entitlements/templates/entitlement-tables-block.tsx',
    '/components/leave/adjustment-form.tsx',
    '/app/leave/employee-records/page.tsx',
    '/app/leave/employee-records/export/route.ts',
    '/app/approvals/leave-date-breakdown.tsx',
    '/components/leave-duration-fields.tsx',
    '/components/leave/replacement-leave-request-dialog.tsx',
  ];

  it('no leave surface still prints a RAW day count', () => {
    // The fault a `toFixed` grep cannot see: a screen that never formatted at all. `{Number(r.days)}` and a
    // bare `{row.days}` are how the Employee Leave Record came to show "3" beside Employee Balances' "3.00".
    for (const rel of SURFACES) {
      const src = codeOnly(read(rel));
      expect(src, `${rel} prints a raw day count`).not.toMatch(/\{Number\([a-z]\.days\)\}/);
      // The lookbehind spares `value={r.days}` — an input's own state is raw text by design (it has to be
      // typeable); it is the on-blur tidier's job, not the formatter's.
      expect(src, `${rel} prints a raw day count`).not.toMatch(/(?<!=)\{[a-z]+\.days\}/);
    }
  });

  it('every day-rendering surface imports the shared helper', () => {
    for (const rel of SURFACES) {
      expect(read(rel), `${rel} must render days through lib/day-format`).toContain("from '@/lib/day-format'");
    }
  });

  it('and none of them keeps a private toFixed beside it', () => {
    // This is the assertion that would have caught the original drift. Comments are stripped first so a
    // header that QUOTES the removed `toFixed(2)` (several do, on purpose) does not fail it.
    for (const rel of SURFACES) {
      expect(codeOnly(read(rel)), `${rel} must not format day figures itself`).not.toContain('toFixed(');
    }
  });

  it('THE ENGINE IS UNTOUCHED — no formatter, and no new rounding, in core', () => {
    // The request said "displayed, stored, and processed". Storage was already right and processing must
    // not change: this is a display job, and core must not learn about display.
    for (const rel of ['/core/leave-compute.ts', '/core/leave.ts']) {
      expect(read(rel), `${rel} must not import a display formatter`).not.toContain('lib/day-format');
    }
  });
});

describe('4a1abc4a · the two day SENTENCES print the same figure as the tables', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  const catalog = (loc: string) => JSON.parse(read(`/messages/${loc}.json`));

  /** Render the real message through the real ICU engine, with the SAME two arguments the components
   *  pass. Grepping the catalog cannot tell you what a reader sees — the version of this block that did
   *  only that asserted a claim which was false in Tamil, and passed. */
  const say = (loc: string, ns: string, key: string, days: number) =>
    createTranslator({ locale: loc, messages: catalog(loc), namespace: ns })(key, {
      v: formatDays(days),
      cat: dayPluralCategory(days, loc),
    });

  it('print exactly two decimals, in every locale', () => {
    // The reported fault: the dashboard said "12.5 days remaining" while the balance grid said "12.50".
    for (const loc of LOCALES) {
      expect(say(loc, 'dashboard', 'daysRemaining', 12.5), loc).toContain('12.50');
      expect(say(loc, 'dashboard', 'daysRemaining', 12), loc).toContain('12.00');
      expect(say(loc, 'leave', 'durationLine', 1), loc).toContain('1.00');
    }
  });

  it('ENGLISH says "1.00 days", and TAMIL says "நாள்" — and no single rule gives you both', () => {
    // THE TWO WRONG ANSWERS THIS PINS, both of which were written and both of which looked fine in review:
    //
    //   1. Drop the plural and print a bare placeholder, justified as "two visible fraction digits always
    //      select CLDR's other form". True in five of our six locales. Tamil's rule is `i = 0 or n = 1`,
    //      so 1.00 selects `one`, and Tamil uses a different word for one day. Silently changed the noun.
    //   2. Put a plain ICU `{d, plural, ...}` back. ICU selects on the argument formatted with ZERO
    //      fraction digits, so English got `one` and read "1.00 day remaining".
    //
    // The category has to be computed at the precision the figure is DISPLAYED in, which is what
    // dayPluralCategory does and what neither of the above could express.
    expect(dayPluralCategory(1, 'ta')).toBe('one');
    expect(dayPluralCategory(1, 'en')).toBe('other');
    expect(dayPluralCategory(2, 'ta')).toBe('other');

    expect(say('en', 'dashboard', 'daysRemaining', 1)).toBe('1.00 days remaining');
    expect(say('ta', 'dashboard', 'daysRemaining', 1)).toContain('நாள்');
    expect(say('ta', 'dashboard', 'daysRemaining', 2)).toContain('நாட்கள்');
    expect(say('ta', 'leave', 'durationLine', 1)).toContain('நாள்');
    expect(say('ta', 'leave', 'durationLine', 2)).toContain('நாட்கள்');
  });

  it('no message re-formats the number itself', () => {
    // The structural guard. `#` inside a plural branch formats with default number rules and is exactly
    // how the two screens drifted apart in the first place, so no message may contain one.
    for (const loc of LOCALES) {
      const c = catalog(loc);
      for (const [label, msg] of [
        [`${loc} dashboard.daysRemaining`, c.dashboard.daysRemaining as string],
        [`${loc} leave.durationLine`, c.leave.durationLine as string],
      ] as const) {
        expect(msg, `${label} must print the pre-formatted value`).toContain('{v}');
        expect(msg, `${label} must never re-format the number with #`).not.toContain('#');
      }
    }
  });

  it('and their call sites hand them the formatted text AND the category', () => {
    for (const f of ['/components/leave-balance-card.tsx', '/components/leave/leave-history-cards.tsx'] as const) {
      const src = read(f);
      expect(src, `${f} must print through the shared formatter`).toMatch(/v: formatDays\(/);
      expect(src, `${f} must select the plural at display precision`).toMatch(/cat: dayPluralCategory\(/);
    }
  });
});
