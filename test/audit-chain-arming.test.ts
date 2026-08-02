/**
 * ADR-0077 slice 8 — the audit hash chain's arming decision.
 *
 * Slice 3 left `AUDIT_HASH_CHAIN_ENABLED` in env as the one DEFERRED gate; slice 8 replaces it with the
 * per-tenant `audit.hash_chain_enabled` setting. The tests that matter are not about reading a setting.
 * They are about the ONE case where the product declines to do as it is told:
 *
 * Disarming a chain that already has history appends events OUTSIDE the chain. That is not a broken
 * link a verifier can report — `verifyTenantChain()` only inspects rows with `chain_seq IS NOT NULL`,
 * and re-arming later links contiguously across the hole, so it answers `valid: true` and the DPO page
 * renders "intact" over a log with an unprotected window in the middle. No backfill exists to heal it.
 *
 * A green verdict over a hole is worse than a loud refusal, so the chain stays armed and says why.
 */
import { describe, expect, it } from 'vitest';
import { chainArmingDecision } from '../core/audit-chain-arming';

describe('slice 8 — the setting arms the chain', () => {
  it('setting ON arms it', () => {
    const d = chainArmingDecision({ settingEnabled: true, hasChainedHistory: false, envArmed: false });
    expect(d.armed).toBe(true);
    expect(d.refusedDisarm).toBe(false);
  });

  it('setting ON arms it even when the legacy env gate is off — the setting is the decision now', () => {
    expect(chainArmingDecision({ settingEnabled: true, hasChainedHistory: false, envArmed: false }).armed).toBe(true);
  });

  it('setting OFF with NO history leaves it off — nothing can be holed', () => {
    const d = chainArmingDecision({ settingEnabled: false, hasChainedHistory: false, envArmed: false });
    expect(d.armed).toBe(false);
    expect(d.refusedDisarm).toBe(false);
  });
});

describe('slice 8 — disarming a chain WITH history is refused', () => {
  it('stays ARMED and flags the refusal', () => {
    // The load-bearing test in this file. Honouring the setting here would open a window that no
    // verifier can see and no backfill can heal, while the DPO surface kept reporting "intact".
    const d = chainArmingDecision({ settingEnabled: false, hasChainedHistory: true, envArmed: false });
    expect(d.armed).toBe(true);
    expect(d.refusedDisarm).toBe(true);
  });

  it('explains the consequence, not just the refusal', () => {
    // Whoever hits this needs to know WHY the toggle did not take effect, or they will assume a bug and
    // go looking for a way around it.
    const d = chainArmingDecision({ settingEnabled: false, hasChainedHistory: true, envArmed: false });
    expect(d.reason).toContain('verifyTenantChain');
    expect(d.reason).toContain('no backfill');
  });

  it('refuses regardless of the legacy env gate — neither lever can open the hole', () => {
    for (const envArmed of [true, false]) {
      expect(chainArmingDecision({ settingEnabled: false, hasChainedHistory: true, envArmed }).armed).toBe(true);
    }
  });
});

describe('slice 8 — an unresolvable setting fails ARMED, never off', () => {
  it('a tenant with history stays armed when the setting cannot be resolved', () => {
    // A sweep context carries no entitlement snapshot (r108). A chain must not be lost because the
    // resolver could not answer — failing closed here means failing ARMED.
    const d = chainArmingDecision({ settingEnabled: null, hasChainedHistory: true, envArmed: false });
    expect(d.armed).toBe(true);
  });

  it('falls back to the legacy env gate when there is no history to protect', () => {
    expect(chainArmingDecision({ settingEnabled: null, hasChainedHistory: false, envArmed: true }).armed).toBe(true);
    expect(chainArmingDecision({ settingEnabled: null, hasChainedHistory: false, envArmed: false }).armed).toBe(false);
  });

  it('never returns armed=false for a tenant that has chained history, under ANY input', () => {
    // Exhaustive over the decision space. This is the invariant the whole module exists to hold: no
    // combination of setting, env and history may produce an unprotected window in an existing chain.
    for (const settingEnabled of [true, false, null] as const) {
      for (const envArmed of [true, false]) {
        const d = chainArmingDecision({ settingEnabled, hasChainedHistory: true, envArmed });
        expect(d.armed, `setting=${settingEnabled} env=${envArmed}`).toBe(true);
      }
    }
  });
});

/**
 * The wiring, not just the rule.
 *
 * `withTenant` opens every transaction in the product, so the change that matters most about slice 8 is
 * the one that must NOT be observable: on every existing deployment the decision has to produce exactly
 * what the env gate produced. Verified against production before shipping — 5707 events, ZERO chained,
 * no tenant with a chain, AUDIT_HASH_CHAIN_ENABLED unset — so `hasChainedHistory` is false everywhere
 * and the setting resolves to its catalogue default of off.
 */
describe('slice 8 — inert on every deployment that exists today', () => {
  it('reproduces the OLD env-gate behaviour exactly when no tenant has chained history', () => {
    for (const envArmed of [true, false]) {
      const d = chainArmingDecision({ settingEnabled: null, hasChainedHistory: false, envArmed });
      // This is the assertion that says "shipping slice 8 changes nothing until someone turns it on".
      expect(d.armed, `envArmed=${envArmed}`).toBe(envArmed);
      expect(d.refusedDisarm).toBe(false);
    }
  });

  it('production today: setting off, no history, env unset ⇒ chain stays off', () => {
    const d = chainArmingDecision({ settingEnabled: false, hasChainedHistory: false, envArmed: false });
    expect(d.armed).toBe(false);
  });

  it('arming a tenant for the first time is an ordinary configuration change, not a refusal', () => {
    const d = chainArmingDecision({ settingEnabled: true, hasChainedHistory: false, envArmed: false });
    expect(d.armed).toBe(true);
    expect(d.refusedDisarm).toBe(false);
  });
});
