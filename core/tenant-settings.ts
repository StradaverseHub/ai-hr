/**
 * ADR-0084 — THE APP'S FIRST WRITER OF `tenant_setting`, and the switchboard for the unattended agents.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Three agents are deployed and every one of them is off: the readiness nudge (r237), the anomaly
 * hypothesis layer (r238) and input triage (r240). Each round's entry had to record the same caveat —
 * *nothing in the UI can turn it on; here is an INSERT to run on the box* — because no screen reads
 * `SETTING_CATALOG` and nothing in the product writes `tenant_setting`. Three consecutive rounds carrying
 * the same footnote is the signal that the footnote is the work.
 *
 * ⚠️ **AND IT IS THE PRECONDITION FOR ADR-0084 PHASE 3, NOT A DETOUR FROM IT.** Item 5 is agreement
 * measurement, item 6 is recurrence mining, item 7 is the first autonomy grant — and all three are
 * blocked on the same thing: `agent_proposal` is EMPTY on production, because no tenant has switched any
 * agent on. Rates cannot be surfaced before there is anything to surface (§2.3's own warning), so the way
 * to Phase 3 runs through making the loop startable by somebody other than a developer with psql.
 *
 * ═══ WHAT THIS FILE IS CAREFUL ABOUT ═══
 *
 *  1. **IT MIRRORS THE RLS POLICY RATHER THAN LEANING ON IT.** `tenant_setting_write` (0313) admits a
 *     GROUP ADMIN writing a TENANT-scoped catalogued key. A write that fails that policy matches ZERO
 *     ROWS — silently, with no error — so a caller would see "saved" and nothing would have changed.
 *     Every condition the policy checks is therefore checked HERE first and refused with a typed error.
 *     The policy stays the authority; this is so a refusal is legible.
 *  2. **`source: 'customer'` IS REQUIRED, NOT COSMETIC.** 0313's own comment: overwriting a
 *     platform-written value on a tenant-scoped key requires the writer to set it, because provenance
 *     follows the write rather than being inherited. A customer switch that wrote `platform` would be
 *     claiming the platform made the change.
 *  3. **`customerVisible: false` IS NOT WRITABLE HERE.** The catalog flag means "hidden from the customer
 *     settings screen entirely"; `feedback.ai_planning_enabled` is operator tooling and a customer
 *     switchboard must not offer it. Platform-scoped keys are refused for the same reason and by the
 *     policy besides.
 *  4. **SWITCHING AN AGENT ON DOES NOT MEAN IT CAN RUN.** Every one of the three has a second gate — a
 *     billable module, or a configured AI provider, or both — and an admin who flips a switch that still
 *     cannot do anything must be told so on the spot. `aiAgentSwitches` returns the gates beside the
 *     value for exactly that, and never reports a switch as effective when its gate is shut.
 */
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import * as schema from '../db/schema';
import { isGroupAdmin } from '../lib/authz';
import { SETTING_CATALOG } from '../packs/catalog';
import { isModuleEnabled, settingEnabled } from './entitlements';
import { resolveActiveAiConfig } from './ai-config';

/** Refused before the database sees it, so a caller gets a reason rather than a silent no-op. */
export class TenantSettingError extends Error {
  constructor(public readonly reason: 'not_group_admin' | 'unknown_key' | 'not_tenant_scoped' | 'not_customer_visible' | 'wrong_type') {
    super(`tenant-setting:${reason}`);
    this.name = 'TenantSettingError';
  }
}

const catalogEntry = (key: string) => SETTING_CATALOG.find((s) => s.key === key) ?? null;

/**
 * Write one tenant-scoped setting.
 *
 * Every guard below has a matching conjunct in `tenant_setting_write`; this exists so the refusal is a
 * typed error at the call site instead of an UPDATE that matches nothing.
 */
export async function setTenantSetting(
  ctx: SessionContext,
  p: { key: string; value: boolean | number | string },
): Promise<void> {
  // Mirrors app.is_group_admin(). A company-scoped admin is deliberately NOT enough: these switches are
  // tenant-wide, and a per-company admin flipping one would change behaviour for companies they do not
  // administer.
  if (!isGroupAdmin(ctx)) throw new TenantSettingError('not_group_admin');

  const entry = catalogEntry(p.key);
  if (!entry) throw new TenantSettingError('unknown_key');
  if (entry.scope !== 'tenant') throw new TenantSettingError('not_tenant_scoped');
  if (!entry.customerVisible) throw new TenantSettingError('not_customer_visible');
  if (typeof p.value !== entry.valueType) throw new TenantSettingError('wrong_type');

  await withTenant(ctx, async (tx) => {
    await tx
      .insert(schema.tenantSetting)
      .values({ tenantId: ctx.tenantId, key: p.key, value: p.value as never, source: 'customer' })
      .onConflictDoUpdate({
        target: [schema.tenantSetting.tenantId, schema.tenantSetting.key],
        // `source` is re-stated on the update arm on purpose: a row the platform wrote and the customer
        // then changed is a CUSTOMER row, and 0313 says provenance follows the write.
        set: { value: p.value as never, source: 'customer', updatedAt: sql`now()` },
      });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'tenant-setting',
      aggregateId: ctx.tenantId,
      eventType: 'tenant-setting.changed',
      actor: actorOf(ctx),
      // The KEY and the new value, never the whole catalogue. Switching an agent on is an operational act
      // somebody may have to account for later, which is the whole reason it is an event and not a write.
      payload: { key: p.key, value: p.value },
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The AI agent switchboard
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ THE THREE UNATTENDED AGENTS, AND ONLY THOSE. Everything else in `SETTING_CATALOG` is a payroll risk
 * switch, an audit control or operator tooling, and none of them belongs on a screen about the AI loop.
 * A generic "every catalogued setting" list is the settings screen (slice 7), which is a different thing
 * with a different audience.
 */
export const AI_AGENT_SETTINGS = [
  {
    id: 'nudge',
    key: 'notifications.readiness_nudge_enabled',
    /** The billable module its DELIVERY needs — the nudge is a notification before it is anything else. */
    module: 'notifications',
    /** Whether a model is involved at all when it runs. The nudge falls back to a written template. */
    needsProvider: false,
    /**
     * ⚠️ READ THROUGH A STRING LITERAL, NOT `settingEnabled(ctx, a.key)`.
     * `test/module-catalog-drift.test.ts` scans every `settingEnabled` call outside core/entitlements.ts
     * for a literal key and fails when one is passed a variable — because a variable key is invisible to
     * the catalogue check, which is what would let an uncatalogued key through (and an uncatalogued key
     * is a 500, not a disabled feature: `getSetting` throws a bare Error). The literal is duplicated
     * beside `key` on purpose and says so, or somebody will tidy it away. r237 recorded the same trap on
     * the nudge's own call site; this is the second time it has bitten, in the same round family.
     */
    read: (ctx: SessionContext) => settingEnabled(ctx, 'notifications.readiness_nudge_enabled'),
  },
  {
    id: 'hypotheses',
    key: 'payroll.anomaly_hypotheses_enabled',
    module: 'payroll',
    // With no provider it records nothing and reports `notConfigured` — which is correct behaviour and
    // still means the switch achieves nothing, so the screen has to say so.
    needsProvider: true,
    read: (ctx: SessionContext) => settingEnabled(ctx, 'payroll.anomaly_hypotheses_enabled'),
  },
  {
    id: 'triage',
    key: 'claims.input_triage_enabled',
    module: 'claims',
    needsProvider: true,
    read: (ctx: SessionContext) => settingEnabled(ctx, 'claims.input_triage_enabled'),
  },
] as const;

export type AiAgentSwitch = {
  id: string;
  key: string;
  /** What the tenant's row (or the catalogue default) currently says. */
  on: boolean;
  /** The module this agent needs, and whether the tenant holds it. */
  module: string;
  moduleHeld: boolean;
  /** True when this agent needs a model and the tenant has no provider configured. */
  providerMissing: boolean;
  /**
   * Switched on AND able to act. ⚠️ NOT the same as `on`, and the difference is the point of this screen:
   * an agent whose module is not held or whose provider is absent is switched on and inert, which is the
   * state three round entries had to explain in prose.
   */
  effective: boolean;
};

/** What the switchboard renders. Reads the tenant's own entitlement snapshot — never a constant. */
export async function aiAgentSwitches(ctx: SessionContext): Promise<AiAgentSwitch[]> {
  const hasProvider = await withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx))
    .then((c) => c != null)
    .catch(() => false);

  return AI_AGENT_SETTINGS.map((a) => {
    const moduleHeld = isModuleEnabled(ctx, a.module);
    // Through the entry's own literal-keyed reader — see the note on AI_AGENT_SETTINGS. It throws on an
    // uncatalogued key, which is what we want: a typo should fail loudly rather than render a switch
    // that reads permanently off.
    const on = a.read(ctx);
    const providerMissing = a.needsProvider && !hasProvider;
    return { id: a.id, key: a.key, on, module: a.module, moduleHeld, providerMissing, effective: on && moduleHeld && !providerMissing };
  });
}
