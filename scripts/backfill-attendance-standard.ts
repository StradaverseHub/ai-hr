import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { installAttendanceStandardRule } from '../db/attendance-installation';
import { lockOwnerTenantCatalogsTx } from '../db/provision-ownership';
import { waitAccessConfigurationExclusiveTx } from '../core/access-exclusive-wait';

/** Preview a tenant's legacy setup, or fill the missing default in the same owner transaction. */
export async function backfillAttendanceStandard(tx: Tx, tenantId: string, apply: boolean) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error('A valid tenant ID is required.');
  }
  if (apply) {
    if (!await waitAccessConfigurationExclusiveTx(tx, tenantId, { attempts: 2, maxBackoffMs: 250 })) {
      return 'busy';
    }
    await lockOwnerTenantCatalogsTx(tx, tenantId);
  }
  const [state] = await tx.execute<{ entitled: boolean; hasDefault: boolean; nameInUse: boolean }>(sql`
    select exists (
      select 1 from public.tenant_module
      where tenant_id=${tenantId}::uuid and module_code='attendance' and status in ('active','trial')
        and (expires_at is null or expires_at > now())
    ) as entitled,
    exists (select 1 from public.attendance_rule where tenant_id=${tenantId}::uuid and is_default) as "hasDefault",
    exists (select 1 from public.attendance_rule where tenant_id=${tenantId}::uuid and lower(name)='standard') as "nameInUse"
  `);
  if (!state.entitled) return 'not-entitled';
  if (state.hasDefault) return 'ready';
  if (state.nameInUse) return 'name-conflict';
  if (!apply) return 'missing';
  return await installAttendanceStandardRule(tx, tenantId) ? 'installed' : 'name-conflict';
}

async function main() {
  const { values } = parseArgs({ options: {
    tenant: { type: 'string' },
    apply: { type: 'boolean', default: false },
  } });
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url || !values.tenant) throw new Error('MIGRATION_DATABASE_URL and --tenant are required.');
  const { createDb } = await import('../db/client');
  const owner = createDb(url, { max: 1 });
  try {
    const { tenant, apply } = values;
    const status = await owner.db.transaction(tx => backfillAttendanceStandard(tx, tenant, apply), {
      accessMode: apply ? 'read write' : 'read only',
    });
    console.log(JSON.stringify({ tenant, apply, status }));
    if (status === 'busy' || status === 'name-conflict') process.exitCode = 1;
  } finally {
    await owner.client.end();
  }
}

if (process.argv[1]?.endsWith('/backfill-attendance-standard.ts')) {
  main().catch(() => {
    console.error('Attendance Standard backfill failed.');
    process.exitCode = 1;
  });
}
