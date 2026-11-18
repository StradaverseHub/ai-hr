/**
 * ADR-0080 D-14 — the two tiers a company can exist in, and the ONE place that decides which.
 *
 * The rule the whole tier rests on: **a pack is not optional where it exists, and not required where it
 * does not.** You do not get to decline EPF by ticking a box, and you do not get to be refused
 * onboarding because nobody has written a Thai pack yet.
 *
 *   country HAS a registered pack  → 'statutory'. Declaring non-statutory is REFUSED — statutory
 *                                    obligations are law, not a preference, and a company in a
 *                                    jurisdiction we model must be modelled by it.
 *   country has NO registered pack → 'non_statutory', and ONLY if declared explicitly. An undeclared
 *                                    packless company is still refused, exactly as before.
 *
 * WHY THE DECLARATION IS REQUIRED RATHER THAN INFERRED. Inferring the tier from "no pack registered"
 * would make a TYPO into a tier: `isoCode` is a shape check, so 'TH' and 'ZZ' both pass, and a
 * mis-keyed country would silently produce a company with no statutory computation and no payroll —
 * looking, from the outside, exactly like a deliberate choice. Requiring the caller to say so out loud
 * means the only way to get a non-statutory company is to mean it.
 *
 * WHAT THIS REPLACES. `createCompany` called `requirePackFor(country)` and refused outright. That guard
 * closed a real window — LEAVE fails SILENT for a packless company, so its employees accrue nothing and
 * nobody is told (r103 turned that silence into a reported `packBlocked` blocker, landing it, in its own
 * words, "deliberately BEFORE slice 6's non-statutory tier makes it reachable"). But refusal is the
 * wrong permanent answer: a customer with a Thai plant either cannot onboard it, or MISFILES Thai staff
 * under the Malaysian company to get past the refusal — silently applying MY rules to foreign employees.
 * The workaround is worse than the problem. Odoo's precedent is the model: l10n modules gate
 * localization, not the existence of a company.
 *
 * NOT AN ENTITLEMENT CHECK. Whether the tenant has BOUGHT `country-th` is a separate question, asked by
 * `isModuleEnabled` at the surfaces that care. This answers only "is this company's jurisdiction one we
 * compute statutory rules for", which is a fact about the pack registry and the company row — available
 * without a resolved snapshot, and therefore usable from out-of-band scripts and sweeps.
 */
import { packFor } from '../localization/registry';

export const STATUTORY = 'statutory';
export const NON_STATUTORY = 'non_statutory';

export type CompanyTier = typeof STATUTORY | typeof NON_STATUTORY;

/** Every value the column's CHECK constraint admits. Stated here so code and schema agree in one place. */
export const COMPANY_TIERS: readonly CompanyTier[] = [STATUTORY, NON_STATUTORY];

export function isCompanyTier(v: unknown): v is CompanyTier {
  return v === STATUTORY || v === NON_STATUTORY;
}

/** Thrown when the requested (country, declaration) pair is not a tier this system will create. */
export class CompanyTierError extends Error {}

/**
 * The tier a company in `country` must have, given whether the caller DECLARED it non-statutory.
 *
 * Throws rather than returning a fallback: there is no safe default here. Guessing 'statutory' for a
 * packless country puts a company into a tier whose engines cannot run, and guessing 'non_statutory' for
 * a packed one silently exempts a company from obligations it has.
 */
export function resolveCompanyTier(country: string | null | undefined, declaredNonStatutory = false): CompanyTier {
  const pack = packFor(country);
  const named = country?.trim() || '(none)';

  if (pack) {
    if (declaredNonStatutory) {
      throw new CompanyTierError(
        `Country '${named}' has statutory rules in this system, so a company there cannot be declared ` +
          `non-statutory. Statutory obligations are not optional where they apply.`,
      );
    }
    return STATUTORY;
  }

  if (!declaredNonStatutory) {
    // The pre-D-14 message, deliberately kept close to the original: this is still the same refusal,
    // now with a stated way through it rather than a dead end.
    throw new CompanyTierError(
      `No country pack registered for country '${named}'. Create it as a NON-STATUTORY company if that ` +
        `is intended — attendance and leave run on manually configured calendars, and payroll and every ` +
        `statutory computation are refused for it.`,
    );
  }

  return NON_STATUTORY;
}

/**
 * Refuse an operation that only makes sense under statutory rules.
 *
 * `operation` is named in the message because "this company is non-statutory" on its own tells an
 * administrator nothing about what they just tried to do or why it stopped.
 */
export function assertStatutory(
  tier: string | null | undefined,
  operation: string,
  companyName?: string | null,
): void {
  if (tier === STATUTORY) return;
  const who = companyName ? `“${companyName}”` : 'this company';
  throw new CompanyTierError(
    `${operation} is not available for ${who}: it is a non-statutory company, so statutory computation ` +
      `is refused by design. Attendance and leave remain available on manually configured calendars.`,
  );
}
