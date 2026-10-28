/** Explicit supplied-transaction seam for canonical readers used by module agents.
 * Ordinary calls preserve their module's existing transaction owner and business body.
 */
import type { SessionContext, Tx } from '../db/client';
import { assertAiPrincipalTx } from './ai-principal';
import { assertModuleEnabled, resolveEntitlementsTx } from './entitlements';
type ReadOwner = <T>(ctx: SessionContext, read: (tx: Tx) => Promise<T>) => Promise<T>;
export async function withCanonicalAiReadTx<T>(ctx: SessionContext, existingTx: Tx | undefined,
  module: string, ordinaryOwner: ReadOwner, read: (tx: Tx) => Promise<T>): Promise<T> {
  if (!existingTx) return ordinaryOwner(ctx, read);
  await assertAiPrincipalTx(existingTx, ctx);
  const fresh = { ...ctx, entitlements: await resolveEntitlementsTx(existingTx, ctx.tenantId) };
  assertModuleEnabled(fresh, module);
  return read(existingTx);
}
