/**
 * 3fb1a611 (r299 fix pass) — IS THIS TENANT'S LEAVE CREDIT REGISTER LIVE?
 *
 * Leave Credit is the paid `toil` add-on. What r299 changed for Replacement Leave — Leave Adjustments and
 * Leave import refuse the type, the Apply form's Expiring soon figure — is only TRUE once the register is
 * the place Replacement Leave balances come from, i.e. once the tenant has the module. Production ships this
 * build with the module OFF, 0 credits, and a Replacement Leave type (`RL`, role `replacement`) whose balances
 * come from entitlement tables. Refusing the type there took away every way HR had to correct those
 * balances while the screen it pointed to said only "not switched on". So each of those places asks this
 * first, and without the module behaves exactly as main@60a40452 did.
 *
 * THE SERVICE FORM, deliberately (core/entitlements.ts draws the line; test/module-catalog-drift.test.ts
 * enforces it): an infrastructure failure throws rather than quietly answering "not live", because the
 * answer decides what a write is allowed to do. Pages ask `isModuleEnabledOrFalse(s, 'toil')` instead.
 *
 * THE ONE CONVERSION: an `entitlementsExempt` context. `isModuleEnabled` THROWS
 * `EntitlementsExemptForBillableError` for such a context asked about a billable module, and it must: an
 * exemption answering YES would hand every tenant a module it never bought. This answers NO — "not live" —
 * which grants nothing: it keeps main's behaviour (the refusals do not apply). Measured at this fix pass, no
 * exempt caller reaches the three services that ask (`applyLeaveAdjustmentBatch`, `validateLeaveImport` /
 * `commitLeaveImport`, `leaveTypeApplySummary` — their only callers are server actions carrying a real
 * session); the conversion exists so a future sweep that does gets main's behaviour rather than a stack
 * trace, the same "the gate is not the layer that decides for a bootstrap context" reasoning as
 * core/module-gate.ts `assertModuleGate`. Every OTHER entitlement fault — a forged marker, a malformed or
 * foreign snapshot, an unresolved context, a failed resolution — still throws.
 *
 * ASK IT LAZILY, only once a Replacement Leave type is actually involved, so a caller working on any other
 * type never reaches an entitlement question it did not have on main.
 */
import type { SessionContext } from '../db/client';
import { EntitlementsExemptForBillableError, isModuleEnabled } from './entitlements';

export function leaveCreditRegisterLive(ctx: SessionContext): boolean {
  try {
    return isModuleEnabled(ctx, 'toil');
  } catch (e) {
    if (e instanceof EntitlementsExemptForBillableError) return false;
    throw e;
  }
}
