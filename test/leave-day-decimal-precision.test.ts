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
 * AND TWO THINGS DELIBERATELY NOT DONE, pinned here so a later reader does not "finish the job":
 *   - THE ENGINE IS UNTOUCHED. No rounding was added to core/leave-compute.ts. Rounding a figure that is
 *     already exact is how a total stops matching the parts printed above it.
 *   - ROUNDING BANDS STAY AT THREE DECIMALS. They are fractions of a day in [0,1] that
 *     `checkRoundingBands` compares and snaps at 3dp; 2dp would render a 0.125 boundary as "0.13" and the
 *     on-blur tidier would then save that, changing a rule.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DAY_DASH,
  DAY_DECIMALS,
  ROUNDING_BAND_DECIMALS,
  formatDayInput,
  formatDays,
  normalizeDayFieldOnBlur,
  normalizeDayText,
} from '@/lib/day-format';

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

describe('4a1abc4a · rounding bands keep THREE decimals, and that is not an oversight', () => {
  it('a band boundary survives formatting; 2dp would corrupt it', () => {
    // This is the assertion that explains the exception. A band is a FRACTION of a day, and the engine
    // compares and snaps at 3dp — so 0.125 is a real, typeable boundary.
    expect(ROUNDING_BAND_DECIMALS).toBe(3);
    expect(formatDays(0.125, { decimals: ROUNDING_BAND_DECIMALS })).toBe('0.125');
    // …and here is what standardising it to 2dp would have done. Rendered as "0.13" it is already wrong on
    // screen; once the on-blur tidier writes that back it is a changed rule, on a screen whose entire
    // promise to the reporter is that no figure changes.
    expect(formatDays(0.125)).toBe('0.13');
    expect(normalizeDayText('0.125', ROUNDING_BAND_DECIMALS)).toBe('0.125');
  });

  it('the band editor tidies at band precision, and the worked EXAMPLE beside it at day precision', () => {
    const panel = codeOnly(read('/components/leave-type-panel.tsx'));
    expect(panel).toMatch(/formatDays\(v, \{ decimals: ROUNDING_BAND_DECIMALS \}\)/);
    expect(panel).toMatch(/normalizeDayText\(e\.currentTarget\.value, ROUNDING_BAND_DECIMALS\)/);
    // The example is "one month of a 14-day entitlement" — a number of DAYS, so it takes the 2dp default.
    expect(panel).toMatch(/formatDays\(ROUNDING_EXAMPLE_RAW\)/);
  });

  it('ROUNDING METHOD IS STILL AN ENUM — no decimals were invented for it', () => {
    // The plan said this out loud rather than silently skipping it: "round up" / "round to nearest half
    // day" is a choice, not a number. The dropdown must stay a <select> over LeaveRoundingMethod, and the
    // day formatter must never be pointed at it.
    const panel = codeOnly(read('/components/leave-type-panel.tsx'));
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
  // The eleven surfaces that render or accept a day figure. The list is the point: the reported fault was
  // that two of them disagreed, and the only durable fix is that none of them formats for itself.
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
    '/components/leave-type-panel.tsx',
    '/app/leave/employee-balances/page.tsx',
    '/app/leave/employee-balances/export/route.ts',
    '/app/admin/leave/entitlements/templates/page.tsx',
    '/components/leave/adjustment-form.tsx',
  ];

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

  it('take a pre-formatted figure instead of formatting it themselves', () => {
    // Both used to embed the number in an ICU plural, whose `#` formats with default number rules — so the
    // dashboard said "12.5 days remaining" while the balance grid said "12.50". Dropping the plural loses
    // nothing: a figure that always carries two decimals has visible fraction digits, so CLDR selects
    // "other" for it in all six of these languages anyway.
    for (const loc of LOCALES) {
      const c = catalog(loc);
      const remaining: string = c.dashboard.daysRemaining;
      const duration: string = c.leave.durationLine;
      expect(remaining, `${loc} dashboard.daysRemaining`).toContain('{d}');
      expect(remaining, `${loc} dashboard.daysRemaining must not re-format the number`).not.toContain('plural');
      expect(duration, `${loc} leave.durationLine`).toContain('{count}');
      expect(duration, `${loc} leave.durationLine must not re-format the number`).not.toContain('plural');
    }
  });

  it('and their call sites hand them the shared formatter\'s output', () => {
    expect(read('/components/leave-balance-card.tsx')).toMatch(/daysRemaining', \{ d: formatDays\(/);
    expect(read('/components/leave/leave-history-cards.tsx')).toMatch(/durationLine', \{ count: formatDays\(/);
  });
});
