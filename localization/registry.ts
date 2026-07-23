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
import { countryPackFor, registerPack } from '../packs/registry';
import type { CountryPack } from './country-pack';

export type { CountryPack } from './country-pack';

registerPack({ id: 'country-my', kind: 'country', country: 'MY', pack: myPack });

export function packFor(country: string | null | undefined): CountryPack | undefined {
  return countryPackFor(country);
}
