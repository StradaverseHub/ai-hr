/** c03670cc — the typed overtime band rate (OT Rate / PH Rate). Client-safe.
 *
 * A rate is a multiplier from 0 to 99.99 with at most two decimal places, stored as numeric(6,2). A
 * third decimal is REFUSED, never rounded: silently turning 1.755 into 1.76 would store a number nobody
 * typed. Formatting works on the decimal's own digits, never through float arithmetic, so a saved 1.5
 * always reopens as "1.5" (never 1.5000000000000002) and a saved 1.75 as "1.75".
 *
 * Band rates are REPORTING ONLY: they choose the attendance overtime column. Payroll monetizes
 * attendance.ot_minutes by day type through the statutory pack and never reads a band rate. */

export const OT_RATE_MAX = '99.99';
const RATE_TEXT = /^\d{1,2}(?:\.\d{1,2})?$/;

/** The canonical text of a typed or posted rate, or null when it is not a valid rate. Accepts a string
 * as typed (surrounding spaces ignored) or a JS number whose shortest decimal form is valid. */
export function otRateText(value: unknown): string | null {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
  return RATE_TEXT.test(text) ? text : null;
}

export function isValidOtRate(value: unknown): boolean {
  return otRateText(value) !== null;
}

/** The numeric(6,2) storage text: "1.5" → "1.50", "2" → "2.00". String padding only. */
export function otRateStorageText(value: unknown): string {
  const text = otRateText(value);
  if (text === null) throw new Error(`OT rate must be a number from 0 to ${OT_RATE_MAX} with up to two decimal places.`);
  const [whole, fraction = ''] = text.split('.');
  return `${String(Number(whole))}.${fraction.padEnd(2, '0')}`;
}

/** Display text for a stored rate ("1.50" → "1.5", "1.75" → "1.75", "2.00"/2 → "2.0", "0.00" → "0.0").
 * Trailing zeros are trimmed from the decimal's own digits, keeping at least one decimal place. */
export function formatOtRate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return text;
  const whole = String(Number(match[1]));
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return `${whole}.${fraction || '0'}`;
}
