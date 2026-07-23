/**
 * The pack registry (ADR-0080 D8) — one registry, two pack kinds.
 *
 * - A **country pack** carries a jurisdiction's compliance surface (the `CountryPack` contract,
 *   ADR-0080 D1) and is applied per company via `company.country`.
 * - A **module pack** gives a functional module (attendance, claims, leave, payroll, …) a code
 *   identity to match its ADR-0077 commercial identity: nav/UI descriptors, satellite-table
 *   declarations, and the extension points country packs plug into.
 *
 * Rung 1 scaffolding: the registry registers exactly ONE pack (country-my, wired from
 * `localization/registry.ts`) and ZERO module packs — the first module retrofit (Attendance,
 * ladder rung 2) fleshes out `ModulePack`. Descriptor types are deliberately FLAT (label + href,
 * plain declarations) per the ADR's anti-framework warning: no components, no render hooks, no
 * plugin lifecycle. Add fields only when a retrofit rung actually consumes them.
 *
 * All packs compile into the one deployment; registration happens at module load (a static
 * `registerPack` call in each pack's wiring file), never at runtime from tenant data. What varies
 * per tenant is *activation* (ADR-0077 entitlements — wired at each rung), not what is registered.
 */
import type { CountryPack } from '../localization/country-pack';

export type PackKind = 'module' | 'country';

/** A sidebar/nav entry a module pack contributes. Flat on purpose (ADR-0080 D8 anti-framework). */
export type NavEntryDescriptor = { label: string; href: string };

/** A pack-owned satellite table declaration (ADR-0080 D5/D11 — documentation, not DDL). */
export type SatelliteTableDecl = { table: string; note?: string };

/**
 * An extension point a module pack declares for country packs to fill (e.g. payroll declares
 * `statutoryCalculators`, leave declares `statutoryEntitlementHooks`). Declaration only in rung 1;
 * the country-seam rung (ladder rung 5) defines the filling mechanism.
 */
export type ExtensionPointDecl = { id: string; note?: string };

/**
 * A functional module with code identity (ADR-0080 D8). Skeleton — rung 2 (Attendance) is the
 * first implementor and the arbiter of what actually belongs here. Everything beyond `id`/`kind`
 * stays optional until a retrofit rung consumes it.
 */
export interface ModulePack {
  /** Module code — matches the ADR-0077 catalog row (e.g. 'attendance'). */
  id: string;
  kind: 'module';
  /** Nav entries the sidebar renders for entitled tenants (ADR-0080 D8; closes ADR-0077 gap #6). */
  nav?: NavEntryDescriptor[];
  /** Tables this pack owns (ADR-0080 D11 criterion 2). */
  satelliteTables?: SatelliteTableDecl[];
  /** Extension points country packs fill (ADR-0080 D8). */
  extensionPoints?: ExtensionPointDecl[];
}

/** A registered country pack: the `country-<cc>` module identity (ADR-0080 D2) around the D1 contract. */
export interface CountryPackRegistration {
  /** Module code in the ADR-0077 catalog sense — `country-<cc>` (e.g. 'country-my'). */
  id: string;
  kind: 'country';
  /** ISO alpha-2 (uppercase) — the `company.country` this pack applies to. */
  country: string;
  pack: CountryPack;
}

export type RegisteredPack = ModulePack | CountryPackRegistration;

const REGISTRY = new Map<string, RegisteredPack>();
const COUNTRY_INDEX = new Map<string, CountryPackRegistration>();

/** Register a pack (idempotent by id — module-load wiring may re-evaluate under dev HMR). */
export function registerPack(pack: RegisteredPack): void {
  REGISTRY.set(pack.id, pack);
  if (pack.kind === 'country') COUNTRY_INDEX.set(pack.country.toUpperCase(), pack);
}

export function packById(id: string): RegisteredPack | undefined {
  return REGISTRY.get(id);
}

export function listPacks(kind?: PackKind): RegisteredPack[] {
  const all = [...REGISTRY.values()];
  return kind ? all.filter((p) => p.kind === kind) : all;
}

/**
 * Resolve the country pack for a `company.country` code. The country registry
 * (`localization/registry.ts`) fronts this as `packFor()` — kernel call sites keep importing that.
 */
export function countryPackFor(country: string | null | undefined): CountryPack | undefined {
  return country ? COUNTRY_INDEX.get(country.toUpperCase())?.pack : undefined;
}
