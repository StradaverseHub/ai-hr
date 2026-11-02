/** Demo flags do not establish target custody. Standalone fixtures must attest their own database. */
import { DEMO_TENANT_ID, SYSTEM_TENANT_ID } from '../../db/seed-guard';
import type { Sql } from 'postgres';

const databases = {
  onehr: 'ai_hr_fixture_onehr',
  'pooled-leave': 'ai_hr_fixture_pooled_leave',
} as const;
export type DemoFixtureKind = keyof typeof databases;
export type DemoFixtureTarget = { database: string; user: string; host: string; port: string };

export function assertDisposableDemoUrl(value: string | undefined, kind: DemoFixtureKind): DemoFixtureTarget {
  try {
    const url = new URL(value ?? '');
    const port = Number(url.port);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      url.pathname !== '/' + databases[kind] || !url.username || url.hash ||
      [...url.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'disable')
    ) throw Error();
    const user = decodeURIComponent(url.username);
    if (user === 'ai_hr_app') throw Error();
    return { database: databases[kind], user, host: url.hostname, port: url.port };
  } catch {
    // Do not include the input URL: it may contain an owner password.
    throw Error('An explicit named loopback disposable fixture target is required; no URL overrides or remote targets.');
  }
}

type ObservedFixtureIdentity = { database: string; user: string; owner?: string; tenants: readonly string[] };
export function assertDisposableDemoIdentity(target: DemoFixtureTarget, actual: ObservedFixtureIdentity): void {
  if (
    actual.database !== target.database || actual.user !== target.user ||
    (actual.owner !== undefined && actual.owner !== actual.user) ||
    !actual.tenants.includes(DEMO_TENANT_ID) ||
    actual.tenants.some(id => id !== DEMO_TENANT_ID && id !== SYSTEM_TENANT_ID)
  ) throw Error('Disposable fixture database/owner/tenant attestation refused.');
}

export async function attestDisposableDemoDatabase(client: Sql, target: DemoFixtureTarget): Promise<void> {
  const [identity] = await client<{ database: string; user: string; owner: string }[]>`
    select current_database() as database, current_user as "user", pg_get_userbyid(datdba) as owner
    from pg_database where datname = current_database()`;
  const tenants = await client<{ id: string }[]>`select id from tenant order by id`;
  assertDisposableDemoIdentity(target, { ...identity, tenants: tenants.map(row => row.id) });
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, canonical(value)]));
  }
  return value;
}

export function assertOwnedFixtureRows(expected: readonly unknown[], actual: readonly unknown[]): void {
  const rows = (values: readonly unknown[]) => values.map(row => JSON.stringify(canonical(row))).sort();
  if (JSON.stringify(rows(expected)) !== JSON.stringify(rows(actual))) {
    throw Error('Fixture-owned rows changed or are incomplete; refusing cleanup/reuse.');
  }
}
