/**
 * ADR-0080 D6 / ADR-0077 slice 6 — WHOSE state vocabulary a value is validated against.
 *
 * Two validators used `countryPacks().flatMap((p) => p.states)` — the union across every REGISTERED
 * pack — and both said so in a comment ending "per-company narrowing is a later slice". This is that
 * slice. The union is the correct answer to "does any jurisdiction we support have this state?" and the
 * wrong answer to "may THIS company record it", which is the question both were actually asking.
 *
 * THE DEFECT IS ALREADY IN PRODUCTION, and it is what makes this more than future-proofing. A location
 * named Sepang carries `country = 'SG'` while its company is MY, and its state is 'Selangor'. The union
 * accepted that, because Selangor is a state of SOME registered pack. Sepang is in Selangor, Malaysia —
 * so the row is a data-entry slip, not a Singapore site, and it is exactly the shape of thing a
 * per-jurisdiction check exists to catch. It slipped through because nothing asked WHICH country.
 *
 * NARROWED BY THE COMPANY'S COUNTRY, NOT THE LOCATION'S — and that choice is load-bearing rather than
 * incidental. `location.country` is documented in core/location.ts as "display only (the engine keeps
 * using company.country)", so the company's country is what actually resolves holidays. Narrowing by the
 * LOCATION's country would have started rejecting the Sepang row on its next edit: 'Selangor' is not an
 * SG state, and there is no SG pack to ask. Narrowing by the COMPANY's country keeps that row valid and
 * editable while still refusing a genuinely foreign state — the correct behaviour and the non-breaking
 * one, which here happen to be the same. (Fixing the row's 'SG' is a data question for its owner, not
 * something a validator should do silently.)
 *
 * TOTAL BY CONSTRUCTION, not by luck. `createCompany` calls `requirePackFor(country)` (core/admin.ts) and
 * so does the country-changing branch of company edit, so no company can exist whose country has no
 * registered pack. `statesForCountries` therefore always has a vocabulary to work from for a real
 * company. It still handles the empty case explicitly rather than assuming, because that assumption is
 * exactly what the two-tier non-statutory company (the remaining slice-6 step) is going to break.
 *
 * WHY NOT SCOPE BY ENTITLEMENT. r102 grants `country-*` rows on `tenant_module`, and it is tempting to
 * read the vocabulary off the entitlement snapshot instead. That would be wrong here in a way worth
 * recording: a context with no snapshot (`entitlementsExempt`, an out-of-band script) would resolve to
 * NO countries and reject every state, turning a resolver gap into a write outage. The company's country
 * is a column — always present, never dependent on a snapshot having been resolved.
 */
import { countryPacks, packFor } from '../localization/registry';

/**
 * The states valid for a given set of country codes. Deduplicated, because two packs may legitimately
 * share a state name and a caller only ever asks "is this one of them".
 *
 * A country with no registered pack contributes NOTHING rather than falling back to the union — falling
 * back is what the union already did, and it is the behaviour being retired.
 */
export function statesForCountries(countries: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const c of countries) {
    const pack = packFor(c);
    if (!pack) continue;
    for (const s of pack.states) out.add(s);
  }
  return out;
}

/**
 * The union across every registered pack — the OLD behaviour, kept as a named function rather than an
 * inline `flatMap` so the few places that genuinely want "any supported jurisdiction" are visible and
 * countable. A dropdown rendered with no company in hand is the honest use; a validator is not.
 */
export function allRegisteredStates(): Set<string> {
  return new Set(countryPacks().flatMap((p) => p.states));
}

/**
 * Validate one state against a set of countries, or return null for "no state".
 *
 * The message names the country it was judged against, because "Unknown state: Selangor" is baffling
 * when Selangor plainly exists — the useful information is which jurisdiction rejected it.
 */
export function validateStateFor(
  state: string | null | undefined,
  countries: readonly (string | null | undefined)[],
  label = 'state',
): string | null {
  const s = (state ?? '').trim();
  if (!s) return null;
  const valid = statesForCountries(countries);
  if (!valid.has(s)) {
    const named = countries.filter(Boolean).join(', ') || 'the configured country';
    throw new Error(`Unknown ${label} “${s}” for ${named}.`);
  }
  return s;
}
