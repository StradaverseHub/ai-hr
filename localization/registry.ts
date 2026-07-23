/**
 * Localization registry (ADR-0008 / ADR-0080). The active country pack is selected by
 * `company.country`. The generic core never references a specific jurisdiction — it asks the
 * registry (enforced by the drift-guard ratchet, test/country-pack-drift.test.ts).
 *
 * Since ADR-0080 rung 1 this file is the country-axis front of the general pack registry
 * (`packs/registry.ts`): it registers `country-my` there at module load and `packFor()` delegates
 * to the shared lookup. The contract lives in `localization/country-pack.ts` (D1 — the interface
 * owns the shape; `myPack` implements it, not the other way around).
 */
import { myPack } from './my';
import { countryPackFor, listPacks, registerPack } from '../packs/registry';
import type { CountryPack } from './country-pack';

export type { CountryPack } from './country-pack';

registerPack({ id: 'country-my', kind: 'country', country: 'MY', pack: myPack });

export function packFor(country: string | null | undefined): CountryPack | undefined {
  return countryPackFor(country);
}

/**
 * Resolve a company's pack or FAIL LOUDLY (ADR-0080 D3 at the seam level, rung 5a). Where the kernel
 * previously had a hard `localization/my` import (implicitly always-MY), an unresolvable pack must
 * throw with a clear message — never silently default to a jurisdiction. With `company.country`
 * defaulting 'MY' and MY the only pack, this path is unreachable today; it exists so a mis-countried
 * company blocks at the seam instead of computing under the wrong rules.
 */
export function requirePackFor(country: string | null | undefined): CountryPack {
  const pack = countryPackFor(country);
  if (!pack) {
    throw new Error(
      `No country pack registered for country '${country ?? '(none)'}' — refusing to proceed under a ` +
        `missing jurisdiction (ADR-0080 D3: fail closed).`,
    );
  }
  return pack;
}

/**
 * Every registered country pack, in registration order (rung 5a). For TENANT-level vocabulary that
 * has no acting company to resolve a single pack from — the profile-option `state` seed, holiday-group
 * state validation, the pay-component catalog seed, PCB classification vocabulary, TP1 relief caps.
 * Call sites take the union across packs; with MY the only pack this is byte-identical to the old
 * direct imports. Per-company narrowing of these surfaces is a later slice (needs D2 per-company pack
 * activation), decided at the second-country rung — ADR-0080 §6.
 */
export function countryPacks(): CountryPack[] {
  return listPacks('country').flatMap((p) => (p.kind === 'country' ? [p.pack] : []));
}
