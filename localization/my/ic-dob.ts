/**
 * Item 354a500d — derive Date of Birth (ISO yyyy-mm-dd) from the first six digits (YYMMDD) of a
 * Malaysian MyKad IC number.
 *
 * PURE and dependency-free (no db, no 'use client', no next-intl) so it is safe to import from BOTH the
 * server-action layer and the client autofill wrapper. It is re-exported from
 * `localization/my/statutory.ts` (next to `normalizeIC`/`isValidIC`) for the server callers — the impl
 * lives here in a leaf module so the 'use client' wrapper can import it WITHOUT pulling `db`/`postgres`
 * (which statutory.ts imports) into the client bundle.
 *
 * Century rule (approved — "most-recent-non-future"): the IC only carries a two-digit year, so map it to
 * 2000+YY unless that date lies in the future, in which case fall back to 1900+YY. This is correct for all
 * working-age staff; HR can still override the derived DOB by hand for exceptional cases.
 */

/** Digits only (mirrors `normalizeIC` — kept local so this module has zero server deps). */
const digitsOnly = (ic: string): string => ic.replace(/\D/g, '');

/**
 * Item e3ce0d4d — a person is "Malaysian" for the nationality-conditional identification switch when their
 * nationality catalog value reads Malaysian/Malaysia (case-insensitive; the catalog is free-text/dropdown so
 * match loosely). This is a CLIENT-SAFE copy of statutory.ts's helper: it lives in this leaf module (zero db /
 * next-intl / 'use client' deps) so the client identity wrapper can import & call it WITHOUT pulling `db` into
 * the client bundle. statutory.ts re-exports THIS one so there is a single source of truth for both trust classes.
 */
export const isMalaysianNationality = (nationality?: string | null): boolean => {
  const n = (nationality ?? '').trim().toLowerCase();
  return n === 'malaysian' || n === 'malaysia' || n === 'my' || n === 'mys';
};

/**
 * Format Y/M/D as yyyy-mm-dd, or null when it is not a REAL calendar date. The Date.UTC round-trip guards
 * month 13, day 00, 31 April, 29 Feb in a non-leap year, etc. — JS would otherwise silently roll them over.
 */
function isoIfRealDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Derive the ISO Date of Birth from a Malaysian IC, or null when the IC isn't 12 digits or the first six
 * digits (YYMMDD) are not a real calendar date. `now` is injectable for deterministic tests.
 */
export function dobFromIC(ic: string, now: Date = new Date()): string | null {
  const norm = digitsOnly(ic);
  if (!/^\d{12}$/.test(norm)) return null;
  const yy = Number(norm.slice(0, 2));
  const mm = Number(norm.slice(2, 4));
  const dd = Number(norm.slice(4, 6));
  // Try the 2000s reading first (most recent). If it is a real date but lies in the future, fall back to the
  // 1900s reading. If the MMDD is not a real date in either century, there is no DOB to derive → null.
  const iso2000 = isoIfRealDate(2000 + yy, mm, dd);
  if (iso2000 !== null && Date.parse(`${iso2000}T00:00:00Z`) <= now.getTime()) return iso2000;
  return isoIfRealDate(1900 + yy, mm, dd);
}
