/**
 * The pack registry (ADR-0080 D8) — one registry, two pack kinds.
 *
 * - A **country pack** carries a jurisdiction's compliance surface (the `CountryPack` contract,
 *   ADR-0080 D1) and is applied per company via `company.country`.
 * - A **module pack** gives a functional module (attendance, claims, leave, payroll, …) a code
 *   identity to match its ADR-0077 commercial identity: nav/UI descriptors, satellite-table
 *   declarations, and the extension points country packs plug into.
 *
 * Rung 1 registered exactly ONE pack (country-my, wired from `localization/registry.ts`); rung 2
 * (Attendance — the first module retrofit) fleshed out `ModulePack` to what the sidebar actually
 * consumes: a collapsible nav node whose rows mirror the sidebar's own data shape (labelKey into
 * the `nav` message namespace, href, lucide icon ref, per-row visibility flags). Descriptor types
 * stay deliberately FLAT per the ADR's anti-framework warning: plain data, no components, no
 * render hooks, no plugin lifecycle. Add fields only when a retrofit rung actually consumes them.
 *
 * All packs compile into the one deployment; registration happens at module load (a static
 * `registerPack` call in each pack's wiring file), never at runtime from tenant data. What varies
 * per tenant is *activation* (ADR-0077 entitlements — wired at each rung), not what is registered.
 */
import type { LucideIcon } from 'lucide-react';
import type { CountryPack } from '../localization/country-pack';

export type PackKind = 'module' | 'country';

/**
 * A child nav row a module pack contributes — mirrors `components/sidebar.tsx`'s `ChildItem` shape
 * so the sidebar can spread a pack's node verbatim. Flat on purpose (ADR-0080 D8 anti-framework):
 * `labelKey` indexes the global `nav` message namespace (resolved at render via useTranslations),
 * `icon` is a lucide component REF (data, not a render hook), and visibility is the sidebar's own
 * two flags — adminOnly wins over managerUp (admins or approvers), absent ⇒ every employee.
 */
export type NavChildDescriptor = {
  href: string;
  /** Destination query intent; highlighting continues to use the route path. */
  navigationHref?: string;
  labelKey: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  managerUp?: boolean;
  /**
   * Sidebar highlighting, for the two cases a segment-PREFIX match gets wrong (388e53c2).
   *
   * `exactHref` — light this row on its own path ONLY. The /leave row needs it: every /leave/* screen
   *   is a different destination owned by a different row, so the prefix match lit "My Leave" while
   *   an administrator was reading somebody else's record. That was the reporter's actual complaint.
   * `ownedSubpaths` — extra paths that light THIS row. /leave/tracker owns the two leave-inquiry
   *   screens, which deliberately KEPT their /leave/* addresses so saved links and export links stay
   *   valid; without this the row they are reached from would go dark on arrival.
   *
   * NEITHER IS A PERMISSION. They decide highlighting only — adminOnly / managerUp are the gates, and
   * adding one of those to a row to fix highlighting would remove the screen from people who should
   * still see it.
   *
   * Data, not behaviour: the sidebar owns the predicate, the pack only declares the relationship.
   */
  exactHref?: boolean;
  ownedSubpaths?: string[];
};

/** A module's collapsible sidebar node: parent label/icon + its child rows, in render order. */
export type NavNodeDescriptor = {
  /** Inline expandable self-service group; parent name navigates to this destination. */
  defaultHref?: string;
  labelKey: string;
  icon: LucideIcon;
  children: NavChildDescriptor[];
};

/**
 * A collapsible node the pack places in a NAMED sidebar group — the node analogue of
 * NavLinkDescriptor, and the reason `nav?: NavNodeDescriptor` was retired (895c80f9).
 *
 * The old slot held exactly ONE node and carried no group, so the sidebar decided where it landed.
 * That made two approved items unbuildable: Attendance needs an admin node for its settings AND a
 * staff-facing one outside Admin (0bb0e303), and Payroll needs its flat admin row to become a
 * fly-out node with sub-items (1459e116). Neither is expressible with one untagged node, and a
 * pack contributing flat rows could not express them either — `navLinks` rows cannot nest.
 *
 * Same division of labour as NavLinkDescriptor: the pack declares WHICH group; position WITHIN the
 * group stays the sidebar's concern.
 */
export type NavNodeGroupDescriptor = NavNodeDescriptor & { group: 'main' | 'manage' | 'admin' };

/**
 * A STANDALONE (non-collapsible) sidebar row a module pack contributes, added at rung 3 for
 * Claims — a module whose nav is flat links, not a node: one everyone-visible row in the top
 * day-to-day group ('main') and one row in the Administration group ('admin'); rung 4
 * (Performance) added 'manage' for its single Manage-group row. The `group` tag names which
 * existing sidebar group renders the row; the row's POSITION within that group stays the
 * sidebar's concern (like group layout generally — packs contribute rows, not layout).
 */
export type NavLinkDescriptor = NavChildDescriptor & { group: 'main' | 'manage' | 'admin' };

/** A pack-owned satellite table declaration (ADR-0080 D5/D11 — documentation, not DDL). */
export type SatelliteTableDecl = { table: string; note?: string };

/**
 * An extension point a module pack declares for country packs to fill (e.g. payroll declares
 * `statutoryCalculators`, leave declares `statutoryEntitlementHooks`). Declaration only in rung 1;
 * the country-seam rung (ladder rung 5) defines the filling mechanism.
 */
export type ExtensionPointDecl = { id: string; note?: string };

/**
 * A functional module with code identity (ADR-0080 D8). Rung 2 (Attendance,
 * `packs/attendance/index.ts`) is the first implementor and the arbiter of what belongs here.
 * Everything beyond `id`/`kind` stays optional until a retrofit rung consumes it.
 */
export interface ModulePack {
  /**
   * Module code — matches the future ADR-0077 catalog row (e.g. 'attendance'). Entitlement hook
   * point (D11 criterion 5): when ADR-0077's `tenant_module` + `isModuleEnabled()` land, the gate
   * resolves this pack by this id (fail-closed like D3). Not wired yet — those primitives do not
   * exist; do NOT build entitlement machinery here.
   */
  id: string;
  kind: 'module';
  /**
   * The module's collapsible sidebar nodes, rendered via the registry (ADR-0080 D8; closes ADR-0077
   * gap #6). An ARRAY since 895c80f9 — a pack may place a node in Admin and another outside it.
   * Replaces the former single untagged `nav`; see NavNodeGroupDescriptor for why.
   */
  navNodes?: NavNodeGroupDescriptor[];
  /** Standalone sidebar rows for modules whose nav is flat links, not a node (rung 3, claims). */
  navLinks?: NavLinkDescriptor[];
  /** Tables this pack owns (ADR-0080 D11 criterion 2). */
  satelliteTables?: SatelliteTableDecl[];
  /** Extension points country packs fill (ADR-0080 D8). */
  extensionPoints?: ExtensionPointDecl[];
  /**
   * Repo-relative module path of the pack's service facade — the ONLY module outside-the-pack
   * callers import for the pack's services (ADR-0080 D11 criterion 3, enforced by the pack's
   * ratchet). A documentation pointer, deliberately not a loader: no runtime plugin machinery, and
   * keeping the facade OFF this object keeps pack registration client-safe (the sidebar imports
   * the wiring; the facade would drag db/client into the client bundle).
   */
  serviceFacade?: string;
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

/** Kind-narrowed lookup for module packs (nav mounting, future ADR-0077 entitlement resolution). */
export function modulePackById(id: string): ModulePack | undefined {
  const pack = REGISTRY.get(id);
  return pack?.kind === 'module' ? pack : undefined;
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
