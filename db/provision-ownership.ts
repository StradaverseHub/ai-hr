import { sql } from 'drizzle-orm';
import type { Tx } from './client';
import { lockAccessConfigurationTx } from '../core/access-configuration-lock';

/** Injected owner bootstrap only: no app principal, session mutation or role elevation. The caller
 * owns the entire transaction; any busy phase requires its rollback. New uncommitted tenants remain
 * invisible to app sessions, while an existing-tenant catalog caller joins the ordinary interval. */
export async function lockOwnerTenantCatalogsTx(tx: Tx, tenantId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
    throw new Error('Tenant catalogs are busy or unavailable.');
  await lockAccessConfigurationTx(tx, tenantId);
  const [ownership] = await tx.execute<{ acquired: boolean }>(sql`select case when
    current_setting('transaction_isolation')='read committed'
    and current_setting('transaction_read_only')='off'
    and exists(select 1 from pg_catalog.pg_roles r join pg_catalog.pg_class c
      on c.oid='public.tenant'::regclass
      where r.rolname=current_user and (r.rolsuper or c.relowner=r.oid))
    then pg_try_advisory_xact_lock(hashtextextended(${'leave-dependency-configuration:' + tenantId},0))
    else false end as acquired`);
  if (ownership?.acquired !== true) throw new Error('Tenant catalogs are busy or unavailable.');
}
