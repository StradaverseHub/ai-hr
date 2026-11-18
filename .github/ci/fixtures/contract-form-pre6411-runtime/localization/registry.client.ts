/**
 * CLIENT-SAFE country-pack registry (ADR-0080 rung 5b, D4) — the seam `'use client'` components
 * resolve jurisdiction vocabulary through.
 *
 * The full registry (`localization/registry.ts`) resolves the complete `CountryPack`, but its pack
 * objects carry db-backed surfaces (statutory-config CRUD → db/client), so client components must
 * never import it. This registry serves only each pack's `CountryPackClient` slice (pure data +
 * pure functions — see localization/country-pack.ts), imported from the packs' leaf client entry
 * files. It is seam WIRING in the same class as localization/registry.ts and is always-allowed by
 * the drift guard (test/country-pack-drift.test.ts ALWAYS_ALLOWED) — the ONE client-side place
 * that names packs by design.
 *
 * Static list, not `registerPack()`: registration in packs/registry happens in the SERVER wiring
 * file (localization/registry.ts imports the full myPack), which client bundles never execute — a
 * client-side lookup there would find nothing. Keep this list in lockstep with the
 * `registerPack({ kind: 'country', … })` calls in localization/registry.ts (one line per country).
 *
 * Lookup semantics mirror packs/registry.ts `countryPackFor` (uppercase the key). Union reads
 * (`clientCountryPacks()`) follow the rung-5a `countryPacks()` precedent for vocabulary with no
 * acting company in scope; per-company narrowing is the second-country rung's decision (ADR-0080
 * §6).
 */
import type { CountryPackClient } from './country-pack';
import { myClientPack } from './my/client';

const CLIENT_PACKS: readonly CountryPackClient[] = [myClientPack];

/** Resolve a country's client-safe vocabulary, or undefined when no pack is registered for it. */
export function clientPackFor(country: string | null | undefined): CountryPackClient | undefined {
  if (!country) return undefined;
  const key = country.toUpperCase();
  return CLIENT_PACKS.find((p) => p.country === key);
}

/** Every registered pack's client-safe vocabulary, in registration order (union-read pattern, rung 5a). */
export function clientCountryPacks(): readonly CountryPackClient[] {
  return CLIENT_PACKS;
}
