/**
 * ONE way to print a number of leave days (feedback 4a1abc4a).
 *
 * WHY THIS EXISTS. The request was "standardise entitlement decimal precision to 2 places", and the first
 * thing we checked was the storage — because if the figures were being ROUNDED somewhere they would have
 * to be migrated. They are not: `leave_ledger.days`, `leave_type.carry_forward_max`,
 * `max_days_per_leave_year`, `max_consecutive_days` and `max_negative_balance` are all
 * `numeric(6,2)` (`carry_forward_percent` is `numeric(5,2)`), and the engine computes in those exact
 * values. Nothing about the DATA is inconsistent.
 *
 * What was inconsistent is the PRINTING. The same 12 days appeared as "12" on the entitlement table
 * summary, "12.5" in a duration sentence and "12.50" in the balance grid, and eight different screens had
 * each written their own `n.toFixed(2)` to get there. That is the actual fault, and a ninth `toFixed(2)`
 * would have been the ninth chance for two screens to drift apart again — so the fix is this module and
 * the rule that day figures are rendered through it.
 *
 * ═══ THE TWO THINGS THIS MODULE MUST NEVER DO ═══
 *
 * 1. IT MUST NOT ROUND ANYTHING THE ENGINE COMPUTED. Every value that reaches it is already 2dp, so
 *    `toFixed` here is a WIDENING ("12" → "12.00"), never a narrowing. Rounding an exact figure at the
 *    render site is how a total stops matching the parts printed above it. There is deliberately no
 *    "round to nearest half day" here — that is `core/leave-compute.ts`'s job and it stays there.
 *
 * 2. IT MUST NOT TURN NULL INTO "0.00". Several leave and attendance screens distinguish "no engine
 *    computed this figure" from "the figure is zero", and they say so with an em dash — see the r162
 *    Lateness / Early Out columns and `core/attendance-derive.ts`. A blanket formatter that printed 0.00
 *    for an absent figure would silently assert a zero balance where there is no balance at all. Null,
 *    undefined, blank and unparseable ALL render as the placeholder, and `formatDayInput` keeps a blank
 *    input blank so "not set" never persists as "capped at zero".
 *
 * ═══ THERE IS NOW EXACTLY ONE PRECISION, AND THE ONE EXCEPTION IS RETIRED ═══
 *
 * This module used to export a second constant, `ROUNDING_BAND_DECIMALS = 3`, for a single caller: the
 * custom rounding BAND table (`RoundingBand`, 8fec719e), whose figures are FRACTIONS of a day in [0,1] and
 * are compared and snapped at three decimals by `checkRoundingBands` / `applyRoundingBands`. That carve-out
 * was correct when it was written — a 0.125 boundary was genuinely typeable, printing it as "0.13" would
 * have been a lie on screen, and the on-blur tidier would then have SAVED the lie as the rule.
 *
 * IT WENT because the third decimal was never used as a third decimal. Measured on production: three leave
 * types carry a table, all identical, and the only figures in them that are not multiples of 0.01 are 0.401
 * and 0.701 — "one notch above 0.400", typed because each row stopped just before its Round To and the next
 * row had to start SOMEWHERE. Those notches left two HOLES: a fraction of exactly 0.400 or 0.700 matched no
 * row at all and was left unrounded. The answer was to derive each row's From from the row above, not to
 * keep a decimal place nobody wanted.
 *
 * r303 (05db6aa7) moved the rest of the table onto this one precision: a range now includes BOTH its From
 * and its To, From is typed again (the derivation made the reporter's own table untypeable), and the engine
 * compares whole hundredths — so no band figure is read at three decimals anywhere any more. A third decimal
 * typed into the table is refused by name, never tidied into a figure nobody typed.
 *
 * `decimals` survives as a PARAMETER — `dayPluralCategory` selects the plural at the precision a figure is
 * DISPLAYED in, so the number has to be nameable — but nothing now passes anything but the default.
 *
 * Sibling of `lib/money.ts`, which does the same job for currency and whose em-dash-for-unknown
 * convention this follows on purpose: the two kinds of figure should fail to be printed the same way.
 */

/** The em dash every day-figure surface already uses for "no figure". Matches `lib/money.ts`. */
export const DAY_DASH = '—';

/**
 * EVERY day figure in the leave module, including the rounding BAND table's fractions of a day — there is
 * no second precision any more; see the module header for the one that was retired and why.
 */
export const DAY_DECIMALS = 2;

/** Options for {@link formatDays}. */
export type FormatDaysOptions = {
  /** Decimal places. Defaults to {@link DAY_DECIMALS}; nothing passes anything else. */
  decimals?: number;
  /** What to render when there is no figure. Defaults to {@link DAY_DASH}; exports pass `''`. */
  placeholder?: string;
};

/**
 * The one parse. Anything that is not a finite number — null, undefined, '', whitespace, 'abc', NaN,
 * Infinity — is ABSENT, and absent is not zero. Strings are accepted because `numeric` columns arrive
 * from the driver as strings ("12.50"), and forcing every caller to `Number()` first is how one of them
 * eventually forgets and prints "NaN".
 */
function finiteDays(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Render a day figure for DISPLAY: "12" → "12.00", "12.5" → "12.50", 0 → "0.00", null → "—".
 *
 * The value is widened, never rounded — see the module header. Callers that need a different "no figure"
 * marker (a CSV cell wants an empty string, not an em dash) pass `placeholder`.
 */
export function formatDays(value: unknown, opts: FormatDaysOptions = {}): string {
  const { decimals = DAY_DECIMALS, placeholder = DAY_DASH } = opts;
  const n = finiteDays(value);
  return n == null ? placeholder : n.toFixed(decimals);
}

/**
 * Render a day figure as the VALUE OF AN INPUT: same digits as {@link formatDays}, but "no figure" is the
 * empty string rather than an em dash.
 *
 * A form field is not a label. An optional day box left blank means "not set on this row" —
 * `toStoredBands` omits it and `bandCarryMax` then falls back to the policy cap — whereas a box holding
 * "0.00" means "carry nothing". Rendering an absent figure as an em dash would post the em dash; as
 * "0.00" it would post a rule nobody wrote.
 */
export function formatDayInput(value: unknown, decimals: number = DAY_DECIMALS): string {
  return formatDays(value, { decimals, placeholder: '' });
}

/**
 * Tidy what someone typed, for use on BLUR: "12.5" → "12.50", so the field ends up showing exactly what
 * was saved.
 *
 * Returns the raw text UNCHANGED in the two cases where tidying would destroy information:
 *   - blank stays blank (see {@link formatDayInput} — blank is "not set", not zero);
 *   - a half-typed or unparseable entry ("1.", "-", "abc") is left for the browser's own validation and
 *     the server to refuse by name. Silently blanking it would lose the keystrokes AND hide the mistake.
 */
export function normalizeDayText(raw: string, decimals: number = DAY_DECIMALS): string {
  if (raw.trim() === '') return raw;
  const tidy = formatDayInput(raw, decimals);
  return tidy === '' ? raw : tidy;
}

/**
 * `onBlur` for an UNCONTROLLED day input (one rendered with `defaultValue`). Controlled inputs — the two
 * band editors, which hold their cells as strings so they can be typed into — call
 * {@link normalizeDayText} and set their own state instead.
 *
 * Typed structurally rather than against `React.FocusEvent` so this module stays a plain function library
 * with no React import; a React `onBlur` handler satisfies it.
 */
export function normalizeDayFieldOnBlur(
  e: { currentTarget: { value: string } },
  decimals: number = DAY_DECIMALS,
): void {
  const el = e.currentTarget;
  const tidy = normalizeDayText(el.value, decimals);
  if (tidy !== el.value) el.value = tidy;
}

/**
 * The CLDR plural category for a day figure AS IT WILL BE PRINTED.
 *
 * WHY THIS IS NOT LEFT TO ICU. A message written `{d, plural, one {# day} other {# days}}` selects on the
 * argument formatted with DEFAULT number rules — zero fraction digits — so the number 1 selects `one` and
 * the sentence reads "1.00 day remaining". Every day figure here carries two decimals, and CLDR's rules
 * are defined over the digits actually shown (`v` = visible fraction digits): with v=2, English selects
 * `other` ("1.00 days"), and Tamil — whose rule is `i = 0 or n = 1` — still selects `one`, because Tamil
 * genuinely uses a different word for one day. ICU has no way to be told the display precision, so the
 * category is computed here and the message does a plain `select` on it.
 *
 * Getting this wrong is invisible in English review and wrong in a language none of us reads, which is
 * exactly why it is a function with a test rather than a comment.
 */
export function dayPluralCategory(
  value: unknown,
  locale: string,
  decimals: number = DAY_DECIMALS,
): Intl.LDMLPluralRule {
  const n = finiteDays(value);
  return new Intl.PluralRules(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).select(n ?? 0);
}
