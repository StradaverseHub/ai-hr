/**
 * ADR-0077 slice 8 — WHEN IS THE AUDIT HASH CHAIN ARMED, and who decides.
 *
 * `AUDIT_HASH_CHAIN_ENABLED` is the last env gate slice 3 deferred rather than migrated. This module is
 * the decision that replaces it. It is PURE so the rule can be asserted directly, because the rule has
 * one property that makes it unlike every other setting in the product:
 *
 * ── DISARMING IS NOT REVERSIBLE, AND IT IS NOT VISIBLE ─────────────────────────────────────────────
 * `core/audit-chain.ts` inspects only rows with `chain_seq IS NOT NULL`, and the trigger takes the
 * chain head from `max(chain_seq)` over those same rows. An event appended while the gate is off is
 * therefore NOT a broken link — it is absent from the chain. Re-arming later links straight onto the
 * last chained event, so every `prev_hash` matches and `verifyTenantChain()` answers `valid: true`
 * over a log with an unprotected hole in the middle. The DPO surface renders a green "intact".
 *
 * There is no automatic remedy: the ADR-0030 §3 historical backfill that could heal such a window is
 * not built. So a green verdict over a hole is the worst outcome available here, and the design
 * follows from that:
 *
 *   ARMING is a configuration change. Anyone may turn it on.
 *   DISARMING A TENANT THAT HAS ALREADY CHAINED EVENTS IS REFUSED. The setting is honoured for a
 *   tenant with no chained history (nothing can be holed), and REFUSED once history exists.
 *
 * That deliberately lets configuration lose. It is the same call r105 made about auto-reinstatement and
 * r108 made about unrecognised statuses: when the failure is silent and unrecoverable, the system
 * declines to take the irreversible step and says so, rather than doing as it is told and reporting
 * success. Turning the chain off for a tenant with history is a real operation — it just has to be a
 * deliberate one with the hole understood, not a settings toggle.
 */

/** What the tenant's `audit.hash_chain_enabled` setting says, and what its history already is. */
export type ChainArmingInput = {
  /** The resolved per-tenant setting. null ⇒ unresolvable (no snapshot, an unknown tenant, a failed read). */
  settingEnabled: boolean | null;
  /** Does this tenant already have events carrying chain columns? */
  hasChainedHistory: boolean;
  /**
   * The legacy process-wide env gate, read as `=== 'true'`. Retained ONLY as the fallback for an
   * unresolvable setting, so a deployment mid-migration cannot silently lose its chain. Slice 8 stops
   * it being the decision; it does not yet stop it existing.
   */
  envArmed: boolean;
};

export type ChainArmingDecision = {
  armed: boolean;
  /** Set when the setting said OFF and was overridden to protect existing history. */
  refusedDisarm: boolean;
  reason: string;
};

export function chainArmingDecision(p: ChainArmingInput): ChainArmingDecision {
  // UNRESOLVABLE SETTING ⇒ fall back to the env gate, never to "off". A sweep context carries no
  // entitlement snapshot (r108), and a tenant whose chain is armed must not lose it because the
  // resolver could not answer. Failing closed here means failing ARMED.
  if (p.settingEnabled == null) {
    if (p.hasChainedHistory) {
      return {
        armed: true,
        refusedDisarm: !p.envArmed,
        reason: 'chain setting unresolvable and this tenant has chained history — staying armed',
      };
    }
    return {
      armed: p.envArmed,
      refusedDisarm: false,
      reason: p.envArmed
        ? 'chain setting unresolvable — falling back to the legacy env gate, which is on'
        : 'chain setting unresolvable and no chained history — leaving the chain off',
    };
  }

  if (p.settingEnabled) {
    return { armed: true, refusedDisarm: false, reason: 'audit.hash_chain_enabled is on for this tenant' };
  }

  // THE ONE REFUSAL. The setting says off, but this tenant already has chained events, so honouring it
  // would open a window that no verifier can see and no backfill can heal.
  if (p.hasChainedHistory) {
    return {
      armed: true,
      refusedDisarm: true,
      reason:
        'audit.hash_chain_enabled is off, but this tenant already has chained events. Disarming would ' +
        'append events outside the chain — invisible to verifyTenantChain(), which would keep reporting ' +
        'the log as intact — and there is no backfill that can heal the gap. Staying armed.',
    };
  }

  return { armed: false, refusedDisarm: false, reason: 'audit.hash_chain_enabled is off and there is no chained history' };
}
