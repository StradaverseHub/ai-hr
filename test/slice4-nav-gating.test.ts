/**
 * ADR-0077 slice 4 — nav gating from entitlements.
 *
 * THE POINT OF THIS SLICE IS THAT IT IS COSMETIC, and the test that matters is the last one: a hidden
 * row's page still refuses on its own. D3 puts enforcement at the service boundary, so if slice 4 ever
 * became load-bearing — if hiding the link were the only thing stopping access — a customer would reach
 * a module they had not bought by typing its address. The nav is a courtesy; assertModuleEnabled is the
 * control.
 *
 * The second property worth pinning is that nav fails OPEN. getSession degrades to a session with no
 * snapshot on a migration-lag deploy, a revoked grant or a connection blip. Every service gate then
 * refuses — correct, because a service that guesses moves money. If the rail did the same, that blip
 * would empty the sidebar for every user of a paying tenant while their pages still worked, and the
 * product would look uninstalled. Fail-open degrades to exactly the pre-slice-4 rail instead.
 */
import { describe, expect, it } from 'vitest';
import { MODULE_CODES_WITH_NAV, visibleModuleCodes } from '../lib/nav-entitlements';
import { CORE_MODULE_CODES, MODULE_CATALOG } from '../packs/catalog';
import { assertModuleEnabled, ModuleNotEnabledError } from '../core/entitlements';

const TENANT = '11111111-1111-1111-1111-111111111111';

/**
 * A session shaped like the REAL one — EntitlementSnapshot carries `enabledModules: string[]`, already
 * resolved for status and expiry, not a per-module status map. The first draft of this fixture invented
 * a map, and visibleModuleCodes answered null for every case because isModuleEnabled threw on it. That
 * is worth recording: the fail-open catch inside visibleModuleCodes turned a malformed context into
 * "show everything", which is right in production and indistinguishable from a passing design in a
 * test. The assertions below therefore check for a NON-null result first, so a fixture that stops
 * matching the real shape fails loudly instead of quietly exercising the degraded path.
 *
 * tenantId must match the context's — snapshotOf refuses a snapshot belonging to another tenant.
 */
const sessionWith = (modules: Record<string, boolean>) => ({
  tenantId: TENANT,
  entitlements: {
    tenantId: TENANT,
    enabledModules: Object.entries(modules)
      .filter(([, on]) => on)
      .map(([code]) => code),
    scopedModules: {},
    settings: {},
    tenantStatus: 'active',
  },
});

describe('slice 4 — which modules the rail may advertise', () => {
  it('every code it gates is a real, SELLABLE catalog module', () => {
    // A typo here would silently hide nothing (an unknown code is simply never matched), so the list is
    // checked against the catalog rather than trusted.
    for (const code of MODULE_CODES_WITH_NAV) {
      const row = MODULE_CATALOG.find((m) => m.code === code);
      expect(row, `${code} is a catalog module`).toBeDefined();
    }
    // leave is core and appears in the list because it CONTRIBUTES nav; it must never be hidden.
    const sellable = MODULE_CODES_WITH_NAV.filter((c) => !CORE_MODULE_CODES.includes(c as never));
    expect(sellable.sort()).toEqual(['attendance', 'claims', 'payroll', 'performance']);
  });

  it('hides a module the tenant does not have', () => {
    const codes = visibleModuleCodes(
      sessionWith({ attendance: false, claims: true, leave: true, payroll: true, performance: true }),
    );
    // Non-null FIRST: null would mean the fixture no longer matches the real snapshot and the whole
    // test is silently exercising the degraded fail-open path instead of the gating it claims to check.
    expect(codes, 'fixture resolves a real snapshot').not.toBeNull();
    expect(codes).not.toContain('attendance');
    expect(codes).toContain('claims');
  });

  it('NEVER hides a core module, whatever the snapshot says', () => {
    // leave is core: a tenant cannot not-have it. Even an explicit disabled row must not remove it,
    // because a rail without My Absence is a broken product, not a downgraded one.
    const codes = visibleModuleCodes(
      sessionWith({ attendance: false, claims: false, leave: false, payroll: false, performance: false }),
    );
    expect(codes, 'fixture resolves a real snapshot').not.toBeNull();
    expect(codes).toContain('leave');
    expect(codes).toEqual(['leave']);
  });

  it('FAILS OPEN: a session with no snapshot expresses no opinion, and null is not []', () => {
    // The distinction is the whole safeguard. [] would mean "hide every module-owned row"; null means
    // "show everything". A degraded session must produce the second.
    expect(visibleModuleCodes({ tenantId: 'x' })).toBeNull();
    expect(visibleModuleCodes({ tenantId: 'x', entitlements: null })).toBeNull();
    expect(visibleModuleCodes(undefined)).toBeNull();
    // …and the empty set remains expressible, so the two are genuinely different values.
    const noneOn = visibleModuleCodes(
      sessionWith({ attendance: false, claims: false, leave: false, payroll: false, performance: false }),
    );
    expect(Array.isArray(noneOn), 'a resolved snapshot yields an array, never null').toBe(true);
  });

  it('THE GUARD: hiding the row is NOT the control — the service still refuses', () => {
    // If this ever passes without throwing, slice 4 has become load-bearing and a customer can reach an
    // unpurchased module by typing its address. The nav layer is allowed to be wrong; this is not.
    const ctx = sessionWith({ attendance: false, claims: true, leave: true, payroll: true, performance: true });
    const codes = visibleModuleCodes(ctx);
    expect(codes, 'fixture resolves a real snapshot').not.toBeNull();
    expect(codes).not.toContain('attendance');
    expect(() => assertModuleEnabled(ctx as never, 'attendance')).toThrow(ModuleNotEnabledError);
    // And the converse: an enabled module does not throw, so the guard is discriminating rather than
    // simply always throwing.
    expect(() => assertModuleEnabled(ctx as never, 'claims')).not.toThrow();
  });
});
