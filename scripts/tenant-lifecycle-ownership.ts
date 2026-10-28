import type { Tx } from '../db/client';
import { lockOwnerTenantCatalogsTx } from '../db/provision-ownership';

/** Tenant lifecycle changes own the same owner-only Access/configuration interval as bootstrap.
 * The tenant-table owner is verified in SQL; no platform/customer principal is synthesized. */
export async function lockOwnerTenantLifecycleTx(tx: Tx, tenantId: string): Promise<void> {
  await lockOwnerTenantCatalogsTx(tx, tenantId);
}
