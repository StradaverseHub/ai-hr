/**
 * ADR-0077 slice 5 — what happens when a module is INSTALLED, as opposed to merely granted.
 *
 * WHY THIS IS NOT `ModulePack.onActivate`, which is what the slice plan asked for. `ModulePack` is
 * imported by `components/sidebar.tsx`, which is a `'use client'` component — the pack object is
 * deliberately client-safe, and `packs/registry.ts` says so explicitly about `serviceFacade`: the
 * facade is kept OFF the pack "because it would drag db/client into the client bundle". An activation
 * hook takes a transaction, so putting one on the pack has exactly that effect. The plan predates
 * ADR-0080's pack registry and could not have known. The hook therefore lives in a SERVER-ONLY registry
 * keyed by the same module code, and the pack stays a description of a module rather than a program.
 *
 * WHAT AN ACTIVATOR MAY ASSUME. It runs inside the runner's single transaction, as the OWNER role,
 * after `tenant_module` has been upserted. It is handed the tenant and — for a per-company module — one
 * company at a time, so an activator never loops over companies itself.
 *
 * IDEMPOTENCE IS THE CONTRACT, not an aspiration (D4). Reactivating a module must NEVER re-seed:
 * a customer who disabled a module for a month and turned it back on has edited its defaults in the
 * meantime, and re-seeding would silently revert their configuration. Every activator therefore writes
 * through a natural key with ON CONFLICT DO NOTHING and reports what it SKIPPED, so the runner's event
 * records "seeded 3, skipped 5" rather than a bare success.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { settingDefinition, tenantSetting, toilPolicy } from '../db/schema';

/** What an activator did, in the terms the runner's audit event reports. */
export type ActivationOutcome = {
  /** Rows this activator actually created. */
  seeded: number;
  /** Rows it found already present and deliberately left alone — the reactivation case. */
  skipped: number;
  /** Human-readable detail for the event payload, e.g. 'toil_policy: 2 seeded, 1 skipped'. */
  detail: string[];
};

export type ActivationContext = {
  tx: Tx;
  tenantId: string;
  /** The company being installed into, or null for a tenant-wide module. */
  companyId: string | null;
};

export type ModuleActivator = (ctx: ActivationContext) => Promise<ActivationOutcome>;

export const emptyOutcome = (): ActivationOutcome => ({ seeded: 0, skipped: 0, detail: [] });

export function mergeOutcomes(outcomes: ActivationOutcome[]): ActivationOutcome {
  return {
    seeded: outcomes.reduce((t, o) => t + o.seeded, 0),
    skipped: outcomes.reduce((t, o) => t + o.skipped, 0),
    detail: outcomes.flatMap((o) => o.detail),
  };
}

/**
 * The activation every module gets, whether or not it registers one of its own: write the real
 * `tenant_setting` rows for its `setting_definition.default_on_install` values.
 *
 * That column's own comment states the intent — "written as a real row when the owning module is
 * installed, so a purchase arrives usable" — and nothing was writing it. A module whose settings exist
 * only as catalog defaults arrives inert: the customer sees the module and none of its behaviour.
 *
 * ON CONFLICT DO NOTHING on (tenant_id, key) is what makes reactivation safe. A customer who changed a
 * setting keeps their value; only genuinely absent rows are created.
 */
export const seedModuleSettingDefaults: ModuleActivator = async ({ tx, tenantId }) => {
  const defs = await tx
    .select({ key: settingDefinition.key, value: settingDefinition.defaultOnInstall })
    .from(settingDefinition)
    .where(sql`${settingDefinition.defaultOnInstall} is not null`);
  if (defs.length === 0) return emptyOutcome();

  let seeded = 0;
  for (const d of defs) {
    const res = await tx
      .insert(tenantSetting)
      .values({ tenantId, key: d.key, value: d.value as never })
      .onConflictDoNothing()
      .returning({ key: tenantSetting.key });
    if (res.length > 0) seeded += 1;
  }
  const skipped = defs.length - seeded;
  return {
    seeded,
    skipped,
    detail: [`tenant_setting defaults: ${seeded} seeded, ${skipped} already present`],
  };
};

/**
 * Per-module activators, keyed by `module.code`. A module with no entry still gets the settings pass
 * above — absence here means "nothing beyond its settings", not "not installable".
 *
 * Deliberately a plain object rather than a registration side-effect: the set of activators is
 * knowable by reading this file, and a runner that silently did nothing because an import was missing
 * is the failure mode a registry-by-side-effect invites.
 */
/**
 * TOIL — seed a DISABLED-but-present policy row per company.
 *
 * The point is that a purchased module arrives visible rather than inert. Without a row the TOIL config
 * screen has nothing to render and the customer who just bought it sees an empty shell; with a row at
 * `enabled: false` they see the module, its defaults, and one switch to turn it on. Nothing accrues
 * until they do — `toil_policy.enabled` already defaults to false, so this seeds the safe state rather
 * than choosing a new one.
 *
 * `toil_policy_company_uq` is the natural key that makes reactivation safe: a company that already has a
 * policy keeps it untouched, including every default the customer has since changed.
 *
 * NOT DONE HERE, and named rather than skipped quietly: the plan also wants an admin setup notification.
 * `notification` has NO natural key, so it cannot be written ON CONFLICT DO NOTHING, and a
 * SELECT-then-INSERT dedup is the unlocked race this repo has been bitten by before (see createBatch in
 * the Traps). Sending one needs a dedup key on the table — a real design decision, not a line of code —
 * and getting it wrong means a customer collects a duplicate notification every time an operator
 * re-runs an activation.
 */
const seedToilPolicy: ModuleActivator = async ({ tx, tenantId, companyId }) => {
  if (!companyId) return emptyOutcome();
  const inserted = await tx
    .insert(toilPolicy)
    .values({ tenantId, companyId })
    .onConflictDoNothing()
    .returning({ id: toilPolicy.id });
  const seeded = inserted.length;
  return {
    seeded,
    skipped: seeded === 0 ? 1 : 0,
    detail: [
      seeded === 1
        ? 'toil_policy: seeded disabled — the module is visible, nothing accrues until switched on'
        : 'toil_policy: already present, left untouched',
    ],
  };
};

export const MODULE_ACTIVATORS: Readonly<Record<string, ModuleActivator>> = {
  toil: seedToilPolicy,
};

/**
 * TWO KINDS OF ACTIVATION, and conflating them is a real bug rather than a tidiness point.
 *
 *   TENANT-LEVEL runs ONCE per activation. `tenant_setting` is keyed by (tenant, key) — running it per
 *   company would do the same insert N times and report N-1 phantom "skips".
 *
 *   PER-COMPANY runs once for each company, and AGAIN for every company created later. That second
 *   half is what `companyInstallersFor` exists for: without it, company #2 is born missing every
 *   module's defaults and looks broken in a way nobody connects to having bought a module last month.
 */

/** Everything the RUNNER executes for an activation: the tenant-level pass, then the per-company ones. */
export function activatorsFor(moduleCode: string): { tenant: ModuleActivator[]; perCompany: ModuleActivator[] } {
  const own = MODULE_ACTIVATORS[moduleCode];
  return { tenant: [seedModuleSettingDefaults], perCompany: own ? [own] : [] };
}

/** What a NEWLY CREATED company needs from an already-active module. Never the tenant-level pass. */
export function companyInstallersFor(moduleCode: string): ModuleActivator[] {
  const own = MODULE_ACTIVATORS[moduleCode];
  return own ? [own] : [];
}

/** Filter for settings belonging to one module — used by callers that scope the defaults pass. */
export function moduleSettingKeys(tx: Tx, moduleCode: string) {
  return tx
    .select({ key: settingDefinition.key })
    .from(settingDefinition)
    .where(and(eq(settingDefinition.moduleCode, moduleCode), isNull(settingDefinition.defaultOnInstall)));
}
