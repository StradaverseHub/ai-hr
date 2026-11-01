import { sql } from 'drizzle-orm';
import { client, withTenant, type SessionContext } from '../../db/client';
import { readRecord, writeRecord } from '../internal-auth/store';
import { internalSelected } from '../internal-auth/config';
import { entraConfigSchema, EntraError, type EntraConfig } from './model';
export async function connector(tenantId: string, tx = client): Promise<EntraConfig|null> {
  const value = await readRecord<unknown>(tx, `entra-config:${tenantId}`);
  return value ? entraConfigSchema.parse(value) : null;
}
export async function connectorByOrganization(organization: string) {
  const code = organization.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(code) || !internalSelected()) throw new EntraError('invalid');
  const rows = await client.unsafe('select tenant_id from app.entra_organization($1)', [code]);
  const config = rows[0] ? await connector(rows[0].tenant_id) : null;
  if (!config?.enabled) throw new EntraError('unavailable');
  return config;
}
export async function requireEntraAdmin(ctx: SessionContext) {
  if (!internalSelected() || !ctx.userId) throw new EntraError('forbidden');
  await withTenant(ctx, async tx => {
    const rows = await tx.execute(sql`select app.entra_admin() allowed`) as unknown as {allowed:boolean}[];
    if (!rows[0]?.allowed) throw new EntraError('forbidden');
  });
}
export async function saveConnector(ctx: SessionContext, input: EntraConfig, expectedRevision: string|null) {
  await requireEntraAdmin(ctx);
  const config = entraConfigSchema.parse(input);
  if (config.tenantId !== ctx.tenantId) throw new EntraError('forbidden');
  const previous=await connector(ctx.tenantId);
  if(previous&&(['domain','servicePrincipalId','jobId','sourceAnchorAttribute'] as const).some(key=>previous[key]!==config[key]))throw new EntraError('conflict');
  // Private record and public connector revision commit together. Credentials never enter audit payloads.
  await withTenant(ctx, async tx => {
    await tx.execute(sql`select app.entra_configure(${config.organization},${config.directoryTenantId}::uuid,${config.mode},${config.enabled},${config.provisioningEnabled},${config.revision}::uuid,${expectedRevision}::uuid)`);
    const { encryptRecord } = await import('../internal-auth/crypto');
    const key = `entra-config:${ctx.tenantId}`;
    await tx.execute(sql`select app.internal_auth_write(${key},NULL,${encryptRecord(config,key,null)},NULL)`);
  });
}
export async function assertConnector(config: EntraConfig) {
  const current = await connector(config.tenantId);
  if (!current?.enabled || current.revision !== config.revision) throw new EntraError('forbidden');
}
export { readRecord, writeRecord };

export async function assertProvisioning(config:EntraConfig) {
  await assertConnector(config);
  const rows=await client.unsafe('select app.entra_provision_allowed($1::uuid,$2::uuid) allowed',[config.tenantId,config.revision]);
  if(!rows[0]?.allowed)throw new EntraError('forbidden');
}
