import { createHash } from 'node:crypto';

/** An equality binding, not an authorization credential. The authenticated session still owns access. */
export function clockCommandContext(tenantId: string, userId: string | undefined, employmentId: string) {
  return createHash('sha256').update(JSON.stringify([tenantId, userId, employmentId])).digest('hex');
}
