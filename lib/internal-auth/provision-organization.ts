import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { organizationCode } from '../organization-code';
import { decryptRecord, encryptRecord } from './crypto';
import type { Organization } from './service';

/** Runs inside the owner provisioning transaction, before the invitation becomes usable. */
export async function provisionInternalOrganization(tx: Tx, input: { tenantId: string; code: string; name: string }) {
  const code = organizationCode(input.code);
  const orgKey = `org:${code}`, tenantKey = `tenant:${input.tenantId}`;
  // Same lock names/order as owner bootstrap. Neither namespace can be reassigned.
  for (const key of [orgKey, tenantKey]) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'internal-auth:' + key},0))`);
  }
  for (const key of [orgKey, tenantKey]) {
    const rows = await tx.execute<{ sealed: string }>(sql`select sealed from app.internal_auth_read(${key},true)`);
    const existing = rows[0] ? decryptRecord<Organization>(rows[0].sealed, key) : null;
    if (existing && (existing.tenantId !== input.tenantId || existing.code !== code)) {
      throw new Error('This organization code is already in use. Choose another code.');
    }
  }
  const organization: Organization = { code, tenantId: input.tenantId, name: input.name };
  for (const key of [orgKey, tenantKey]) {
    await tx.execute(sql`select app.internal_auth_write(${key},NULL,${encryptRecord(organization, key, null)},NULL)`);
  }
}
