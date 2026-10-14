import { withTenant, type SessionContext, type Tx } from './client';

/** Compose existing mutation services into one already-scoped transaction. Server callers only. */
export function tenantMutation<T>(ctx: SessionContext, tx: Tx | undefined, mutate: (tx: Tx) => Promise<T>): Promise<T> {
  return tx ? mutate(tx) : withTenant(ctx, mutate);
}
