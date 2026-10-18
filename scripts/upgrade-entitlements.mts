/** Read-only, before/after entitlement checks for the populated upgrade rehearsal. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { SYSTEM_TENANT_ID } from '../db/seed-guard';

type Row = Record<string, unknown>;
type Tenant = { id: string; name: string; workos_org_id: string; status: string | null };
export type UpgradeEntitlementSnapshot = {
  format: 1;
  entitlementTables: boolean;
  tenants: Tenant[];
  modules: Row[];
  settings: Row[];
  systemScope: { company: number; person: number; employment: number; app_user: number };
};

// These are the explicitly reviewed effects of migration 0313, not defaults for new customers.
const LEGACY_MODULES = ['payroll', 'attendance', 'claims', 'performance', 'notifications', 'multi_cycle_payroll', 'typed_pay_components'];
const LEGACY_SETTINGS = ['payroll.reset_enabled', 'payroll.unlock_enabled', 'payroll.individual_txn_pay_enabled'];
function fail(message: string): never { throw new Error(`Upgrade entitlement check: ${message}`); }
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

function indexed(rows: Row[], key: (row: Row) => unknown, label: string): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const row of rows) {
    if (!object(row)) fail(`malformed ${label} row`);
    const id = key(row);
    if (typeof id !== 'string' || !id || result.has(id)) fail(`missing or duplicate ${label} identity`);
    result.set(id, row);
  }
  return result;
}

function validate(value: unknown): asserts value is UpgradeEntitlementSnapshot {
  if (!object(value) || value.format !== 1 || typeof value.entitlementTables !== 'boolean'
    || !Array.isArray(value.tenants) || !Array.isArray(value.modules) || !Array.isArray(value.settings)
    || !object(value.systemScope)) fail('missing or malformed snapshot');
  const snapshot = value as unknown as UpgradeEntitlementSnapshot;
  const tenants = indexed(snapshot.tenants, row => row.id, 'tenant');
  if (![...tenants.values()].some(row => row.id !== SYSTEM_TENANT_ID)) fail('baseline has no customer tenant');
  for (const tenant of snapshot.tenants) {
    if (typeof tenant.name !== 'string' || typeof tenant.workos_org_id !== 'string'
      || !(tenant.status === null && !snapshot.entitlementTables || typeof tenant.status === 'string')) fail('malformed tenant identity');
  }
  for (const table of ['company', 'person', 'employment', 'app_user'] as const) {
    if (!Number.isSafeInteger(snapshot.systemScope[table]) || snapshot.systemScope[table] !== 0) fail(`reserved System tenant has ${table} scope`);
  }
  const system = tenants.get(SYSTEM_TENANT_ID);
  if (snapshot.entitlementTables && !system) fail('reserved System tenant missing');
  if (system && (system.name !== 'System (auth audit)' || system.workos_org_id !== 'org_system_auth_audit'
    || !(system.status === null || system.status === 'active'))) fail('reserved System identity changed');
  indexed(snapshot.modules, row => row.id, 'module grant');
  indexed(snapshot.settings, row => typeof row.tenant_id === 'string' && typeof row.key === 'string' ? JSON.stringify([row.tenant_id, row.key]) : null, 'tenant setting');
  if (!snapshot.entitlementTables && (snapshot.modules.length || snapshot.settings.length)) fail('rows without entitlement tables');
  for (const row of [...snapshot.modules, ...snapshot.settings]) {
    if (typeof row.tenant_id !== 'string' || !tenants.has(row.tenant_id)) fail('orphan entitlement row');
    if (row.tenant_id === SYSTEM_TENANT_ID) fail('reserved System tenant was licensed or configured');
  }
  for (const row of snapshot.modules) {
    for (const key of ['module_code', 'company_id', 'status', 'activated_at', 'expires_at', 'activated_by_platform_user_id', 'created_at']) {
      if (!Object.hasOwn(row, key)) fail(`incomplete module grant: ${key}`);
    }
  }
  for (const row of snapshot.settings) {
    for (const key of ['value', 'source', 'updated_by', 'updated_at']) {
      if (!Object.hasOwn(row, key)) fail(`incomplete tenant setting: ${key}`);
    }
  }
}

function preserveRows(before: Row[], after: Row[], key: (row: Row) => unknown, label: string) {
  const expected = indexed(before, key, label), actual = indexed(after, key, label);
  if (expected.size !== actual.size) fail(`${label} rows added or lost outside the reviewed backfill`);
  for (const [id, row] of expected) {
    if (!isDeepStrictEqual(row, actual.get(id))) fail(`${label} row changed or lost: ${id}`);
  }
}

export function assertUpgradeEntitlements(before: unknown, after: unknown): void {
  validate(before); validate(after);
  if (!after.entitlementTables) fail('entitlement tables missing after upgrade');
  if (!after.tenants.some(row => row.id === SYSTEM_TENANT_ID)) fail('reserved System tenant missing after upgrade');
  // 0151 may introduce the audit sentinel on an old baseline; no migration may silently provision or
  // delete a customer. A customer called "System" receives no exemption from this identity check.
  const previousCustomers = before.tenants.filter(row => row.id !== SYSTEM_TENANT_ID)
    .map(row => !before.entitlementTables && row.status === null ? { ...row, status: 'active' } : row);
  preserveRows(previousCustomers, after.tenants.filter(row => row.id !== SYSTEM_TENANT_ID), row => row.id, 'customer identity');
  if (before.entitlementTables) {
    // Zero rows is a valid core-only customer (0313). Preserve what existed, including disabled,
    // scoped and expired grants; counting just one row cannot establish that paid access survived.
    preserveRows(before.modules, after.modules, row => row.id, 'module grant');
    preserveRows(before.settings, after.settings, row => JSON.stringify([row.tenant_id, row.key]), 'tenant setting');
    return;
  }
  // Only the transition from a pre-entitlement schema admits this historical backfill. Generated
  // UUIDs/timestamps are not business effects; every module, scope, status, expiry and setting is.
  const customers = after.tenants.filter(row => row.id !== SYSTEM_TENANT_ID);
  const expectedModules = customers.flatMap(tenant => LEGACY_MODULES.map(module_code => ({ tenant_id: tenant.id, module_code, company_id: null, status: 'active', expires_at: null, activated_by_platform_user_id: null })));
  const expectedSettings = customers.flatMap(tenant => LEGACY_SETTINGS.map(key => ({ tenant_id: tenant.id, key, value: true, source: 'platform', updated_by: null })));
  const project = (rows: Row[], keys: string[]) => rows.map(row => Object.fromEntries(keys.map(key => [key, row[key]])));
  const order = (rows: Row[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!isDeepStrictEqual(order(project(after.modules, Object.keys(expectedModules[0]))), order(expectedModules))) fail('0313 module backfill differs from its reviewed effects');
  if (!isDeepStrictEqual(order(project(after.settings, Object.keys(expectedSettings[0]))), order(expectedSettings))) fail('0313 settings backfill differs from its reviewed effects');
}

/** Optional tables are resolved inside the same read-only snapshot, before referencing them. */
export function entitlementSnapshotSql(entitlementTables: boolean): string {
  const rows = (table: string) => `(SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM public.${table} r)`;
  return `SELECT jsonb_build_object(
    'format', 1, 'entitlementTables', ${entitlementTables},
    'tenants', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
      'workos_org_id', t.workos_org_id, 'status', to_jsonb(t)->>'status')), '[]'::jsonb) FROM public.tenant t),
    'modules', ${entitlementTables ? rows('tenant_module') : "'[]'::jsonb"},
    'settings', ${entitlementTables ? rows('tenant_setting') : "'[]'::jsonb"},
    'systemScope', jsonb_build_object(${['company', 'person', 'employment', 'app_user'].map(table => `'${table}', (SELECT count(*) FROM public.${table} WHERE tenant_id = '${SYSTEM_TENANT_ID}'::uuid)`).join(', ')})) AS snapshot`;
}

async function snapshot(database: string): Promise<UpgradeEntitlementSnapshot> {
  const { default: postgres } = await import('postgres');
  const sql = postgres({ host: '127.0.0.1', port: 5433, username: 'postgres', database, max: 1, connect_timeout: 10 });
  try {
    return await sql.begin('isolation level repeatable read read only', async tx => {
      await tx`set local statement_timeout = '30s'`;
      const [tables] = await tx<{ modules: boolean; settings: boolean }[]>`SELECT
        to_regclass('public.tenant_module') IS NOT NULL AS modules,
        to_regclass('public.tenant_setting') IS NOT NULL AS settings`;
      if (tables.modules !== tables.settings) fail('incomplete entitlement schema');
      const [row] = await tx.unsafe<{ snapshot: UpgradeEntitlementSnapshot }[]>(entitlementSnapshotSql(tables.modules));
      validate(row?.snapshot);
      return row.snapshot;
    });
  } finally { await sql.end(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, first, second, ...extra] = process.argv.slice(2);
    if (extra.length || !first) fail('expected snapshot <database> or compare <before.json> <after.json>');
    if (command === 'snapshot' && !second) process.stdout.write(JSON.stringify(await snapshot(first)) + '\n');
    else if (command === 'compare' && second) {
      assertUpgradeEntitlements(JSON.parse(readFileSync(first, 'utf8')), JSON.parse(readFileSync(second, 'utf8')));
      process.stdout.write('customer identities, grants and settings preserved; reserved System tenant remains unlicensed\n');
    } else fail('expected snapshot <database> or compare <before.json> <after.json>');
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
