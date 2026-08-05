/**
 * MY SOCSO / EIS leaf — the number default, extracted so a CLIENT component can reach it.
 *
 * ## Why this file exists
 *
 * `defaultSocsoEisNumber` is a pure function, but it lived in `localization/my/statutory.ts`, which
 * imports `db/client` for its CRUD. 35b7af0a group 7 shares the SOCSO/EIS field group between the
 * Personnel card (server) and the Create Employee wizard (client), and the wizard must apply the SAME
 * default — so the function has to be reachable from `localization/my/client.ts`, whose header states
 * plainly that one stray server dependency there drags the database driver into every client bundle
 * that reads jurisdiction vocabulary.
 *
 * So it moves to a LEAF, exactly as `ic-dob.ts` was extracted before it and for the same reason.
 * `statutory.ts` re-exports it, so every existing server caller is untouched.
 *
 * ZERO SERVER DEPS. The two IC helpers are restated here rather than imported from statutory.ts —
 * three characters of duplication against dragging the driver client-side. `ic-dob.ts` already made
 * the same call and says so in its own header.
 */
import { isMalaysianNationality } from './ic-dob';

/** Digits only (mirrors `normalizeIC` in statutory.ts — kept local so this module has zero server deps). */
const normalizeIcLocal = (ic: string): string => ic.replace(/\D/g, '');
/** A MyKad is exactly twelve digits (mirrors `isValidIC`). */
const isValidIcLocal = (ic: string): boolean => /^\d{12}$/.test(normalizeIcLocal(ic));

/**
 * The SOCSO & EIS Number to persist. For a Malaysian employee with a blank number, default it to the
 * (normalised) IC number — SOCSO/EIS register locals under their MyKad. Non-Malaysians and any
 * explicitly entered value are returned untouched.
 */
export const defaultSocsoEisNumber = (args: {
  socsoNumber?: string | null;
  icNumber?: string | null;
  nationality?: string | null;
}): string | undefined => {
  const entered = (args.socsoNumber ?? '').trim();
  if (entered) return entered;
  if (isMalaysianNationality(args.nationality) && args.icNumber) {
    const ic = normalizeIcLocal(args.icNumber);
    if (isValidIcLocal(ic)) return ic;
  }
  return undefined;
};
