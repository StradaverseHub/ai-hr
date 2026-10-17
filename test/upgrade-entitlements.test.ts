import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertUpgradeEntitlements, type UpgradeEntitlementSnapshot } from '../scripts/upgrade-entitlements.mjs';
import { SYSTEM_TENANT_ID } from '../db/seed-guard';

const customer = '11111111-1111-1111-1111-111111111111';
const other = '22222222-2222-2222-2222-222222222222';
function baseline(): UpgradeEntitlementSnapshot {
  return {
    format: 1, entitlementTables: true,
    tenants: [
      { id: SYSTEM_TENANT_ID, name: 'System (auth audit)', workos_org_id: 'org_system_auth_audit', status: 'active' },
      { id: customer, name: 'Fictional customer', workos_org_id: 'org_customer', status: 'active' },
    ],
    modules: [
      { id: 'grant-payroll', tenant_id: customer, module_code: 'payroll', company_id: null, status: 'active', activated_at: '2026-09-01T00:00:00+00:00', expires_at: null, activated_by_platform_user_id: null, created_at: '2026-09-01T00:00:00+00:00' },
      { id: 'grant-attendance', tenant_id: customer, module_code: 'attendance', company_id: other, status: 'disabled', activated_at: '2026-09-02T00:00:00+00:00', expires_at: '2026-10-01T00:00:00+00:00', activated_by_platform_user_id: other, created_at: '2026-09-02T00:00:00+00:00' },
    ],
    settings: [{ tenant_id: customer, key: 'payroll.reset_enabled', value: false, source: 'platform', updated_by: other, updated_at: '2026-10-01T00:00:00+00:00' }],
    systemScope: { company: 0, person: 0, employment: 0, app_user: 0 },
  };
}

describe('populated upgrade entitlement preservation', () => {
  it('accepts the exact unlicensed System audit anchor without granting it anything', () => {
    const before = baseline(), after = structuredClone(before);
    expect(() => assertUpgradeEntitlements(before, after)).not.toThrow();
    expect(after).toEqual(before);
  });

  it('preserves all seven legacy grants on the actual demo-shaped baseline', () => {
    const before = baseline();
    before.modules = ['payroll', 'attendance', 'claims', 'performance', 'notifications', 'multi_cycle_payroll', 'typed_pay_components']
      .map(module_code => ({ ...before.modules[0], id: `grant-${module_code}`, module_code }));
    expect(() => assertUpgradeEntitlements(before, structuredClone(before))).not.toThrow();
    const after = structuredClone(before);
    after.modules.splice(4, 1); // A non-zero row count used to miss a lost paid module.
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/module grant/);
  });

  it('accepts an existing core-only customer with zero licensing rows, even with a System-like name', () => {
    const before = baseline();
    before.tenants.push({ id: other, name: 'System (auth audit)', workos_org_id: 'org_other_customer', status: 'active' });
    expect(() => assertUpgradeEntitlements(before, structuredClone(before))).not.toThrow();
    before.modules = []; before.settings = [];
    expect(() => assertUpgradeEntitlements(before, structuredClone(before))).not.toThrow();
  });

  it('rejects unexpected customers, including a non-nil System-like zero-grant negative control', () => {
    const before = baseline(), after = structuredClone(before);
    after.tenants.push({ id: other, name: 'System (auth audit)', workos_org_id: 'org_new_system_like_customer', status: 'active' });
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/customer identity/);
    after.modules.push({ ...after.modules[0], id: 'new-grant', tenant_id: other });
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/customer identity/);
  });

  it.each(['name', 'workos_org_id', 'status'] as const)('rejects changing customer %s', field => {
    const before = baseline(), after = structuredClone(before);
    after.tenants[1][field] = 'changed';
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/customer identity/);
  });

  it('rejects a lost or replaced customer even if total tenant count stays unchanged', () => {
    const before = baseline(), after = structuredClone(before);
    after.tenants[1].id = other;
    after.modules.forEach(row => { row.tenant_id = other; });
    after.settings.forEach(row => { row.tenant_id = other; });
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/customer identity/);
  });

  it.each(['module_code', 'company_id', 'status', 'expires_at', 'activated_at', 'activated_by_platform_user_id', 'created_at'])('rejects changing grant %s while preserving other grants', field => {
    const before = baseline(), after = structuredClone(before);
    after.modules[1][field] = 'changed';
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/module grant/);
  });

  it('rejects row loss, replacement or new licensing outside a reviewed backfill', () => {
    const before = baseline();
    for (const mode of ['remove', 'replace', 'add']) {
      const after = structuredClone(before);
      if (mode === 'remove') after.modules.pop();
      if (mode === 'replace') after.modules[0].id = 'replacement-grant';
      if (mode === 'add') after.modules.push({ ...after.modules[0], id: 'extra-grant' });
      expect(() => assertUpgradeEntitlements(before, after), mode).toThrow(/module grant/);
    }
  });

  it.each(['value', 'source', 'updated_by', 'updated_at'])('preserves customer setting %s', field => {
    const before = baseline(), after = structuredClone(before);
    after.settings[0][field] = 'changed';
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/tenant setting/);
  });

  it('rejects missing settings and invented settings', () => {
    const before = baseline();
    for (const mode of ['remove', 'add']) {
      const after = structuredClone(before);
      if (mode === 'remove') after.settings = [];
      else after.settings.push({ ...after.settings[0], key: 'invented.setting' });
      expect(() => assertUpgradeEntitlements(before, after), mode).toThrow(/tenant setting/);
    }
  });

  it('requires the exact reserved identity, not just its nil ID or display name', () => {
    for (const field of ['name', 'workos_org_id', 'status'] as const) {
      const before = baseline(), after = structuredClone(before);
      after.tenants[0][field] = 'changed';
      expect(() => assertUpgradeEntitlements(before, after), field).toThrow(/reserved System/);
      before.tenants[0][field] = 'changed';
      expect(() => assertUpgradeEntitlements(before, after), `both ${field}`).toThrow(/reserved System/);
    }
    const before = baseline(), after = structuredClone(before);
    after.tenants.shift();
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/reserved System/);
  });

  it('refuses to license/configure System or put any customer identity beneath it', () => {
    const before = baseline();
    for (const table of ['company', 'person', 'employment', 'app_user'] as const) {
      const after = structuredClone(before); after.systemScope[table] = 1;
      expect(() => assertUpgradeEntitlements(before, after), table).toThrow(/reserved System/);
    }
    for (const table of ['modules', 'settings'] as const) {
      const after = structuredClone(before); after[table][0].tenant_id = SYSTEM_TENANT_ID;
      expect(() => assertUpgradeEntitlements(before, after), table).toThrow(/reserved System/);
    }
  });

  it('fails closed on malformed, missing, duplicate or orphan snapshot data', () => {
    const before = baseline();
    for (const value of [null, {}, { ...before, modules: null }, { ...before, systemScope: {} }, { ...before, entitlementTables: false }]) {
      expect(() => assertUpgradeEntitlements(value, before)).toThrow();
    }
    for (const change of [
      (after: UpgradeEntitlementSnapshot) => { after.modules.push({ ...after.modules[0] }); },
      (after: UpgradeEntitlementSnapshot) => { after.modules[0].tenant_id = other; },
      (after: UpgradeEntitlementSnapshot) => { after.tenants.push({ ...after.tenants[1] }); },
      (after: UpgradeEntitlementSnapshot) => { after.settings.push({ ...after.settings[0] }); },
    ]) {
      const after = structuredClone(before); change(after);
      expect(() => assertUpgradeEntitlements(before, after)).toThrow();
    }
  });

  it('compares semantic rows independently of SQL ordering and JSON key order', () => {
    const before = baseline(), after = structuredClone(before);
    after.tenants.reverse(); after.modules.reverse();
    after.modules = after.modules.map(row => Object.fromEntries(Object.entries(row).reverse()));
    expect(() => assertUpgradeEntitlements(before, after)).not.toThrow();
  });
});

function historicalTransition() {
  const before = baseline(); before.entitlementTables = false;
  before.modules = []; before.settings = []; before.tenants.forEach(row => { row.status = null; });
  before.tenants.shift(); // A baseline before 0151 acquires only the reserved audit anchor.
  const after = baseline(); after.modules = []; after.settings = [];
  for (const module_code of ['payroll', 'attendance', 'claims', 'performance', 'notifications', 'multi_cycle_payroll', 'typed_pay_components']) {
    after.modules.push({ id: `new-${module_code}`, tenant_id: customer, module_code, company_id: null, status: 'active', expires_at: null, activated_by_platform_user_id: null, activated_at: '2026-10-01', created_at: '2026-10-01' });
  }
  for (const key of ['payroll.reset_enabled', 'payroll.unlock_enabled', 'payroll.individual_txn_pay_enabled']) {
    after.settings.push({ tenant_id: customer, key, value: true, source: 'platform', updated_by: null, updated_at: '2026-10-01' });
  }
  return { before, after };
}

describe('historical pre-0313 entitlement backfill', () => {
  it('admits only the seven legacy modules and three true platform settings for pre-existing customers', () => {
    const { before, after } = historicalTransition();
    expect(() => assertUpgradeEntitlements(before, after)).not.toThrow();
    // These effects are historical SQL, not today's catalog or an arbitrary minimum row count.
    const migration = readFileSync(new URL('../db/migrations/0313_module_entitlements.sql', import.meta.url), 'utf8');
    const moduleBackfill = migration.slice(migration.indexOf('INSERT INTO tenant_module (tenant_id, module_code, status)'));
    for (const row of after.modules) expect(moduleBackfill).toContain(`('${row.module_code}')`);
    for (const row of after.settings) expect(moduleBackfill).toContain(`('${row.key}', 'true'::jsonb)`);
  });

  it('requires that backfill even for a previously rowless customer, without applying it to newer core-only baselines', () => {
    const { before, after } = historicalTransition();
    after.modules = []; after.settings = [];
    expect(() => assertUpgradeEntitlements(before, after)).toThrow(/0313 module backfill/);
    before.entitlementTables = true; before.tenants = structuredClone(after.tenants);
    expect(() => assertUpgradeEntitlements(before, after)).not.toThrow();
  });

  it('rejects a missing legacy grant, wrong scope/status/expiry, extra grant or a disabled backfill setting', () => {
    for (const mode of ['missing', 'scope', 'status', 'expiry', 'extra', 'setting', 'source']) {
      const { before, after } = historicalTransition();
      if (mode === 'missing') after.modules.pop();
      if (mode === 'scope') after.modules[0].company_id = other;
      if (mode === 'status') after.modules[0].status = 'trial';
      if (mode === 'expiry') after.modules[0].expires_at = '2026-10-01';
      if (mode === 'extra') after.modules.push({ ...after.modules[0], id: 'extra', module_code: 'invented' });
      if (mode === 'setting') after.settings[0].value = false;
      if (mode === 'source') after.settings[0].source = 'customer';
      expect(() => assertUpgradeEntitlements(before, after), mode).toThrow(/0313/);
    }
  });
});
