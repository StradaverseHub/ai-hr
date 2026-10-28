import { sql } from 'drizzle-orm';
import type { Tx } from '../../../db/client';

/**
 * WP-E (E-1) — which frozen components a reader outside the person's own projection may show.
 *
 * performance_onehr_result stays readable to the line manager under RLS (onehr_result_read), because several
 * services use "can I see the frozen row" as their is-it-frozen guard. Readers that SHOW a frozen band to
 * anyone but the person mask it here instead: a cycle administrator reads every component; a leader reads a
 * component once it is released to leaders (business group CEOs and group chiefs at once); anyone else none.
 * The decision is app.onehr_frozen_visible (0665).
 */
export type FrozenVisibility = { performance: boolean; potential: boolean; talent: boolean };
const NONE: FrozenVisibility = { performance: false, potential: false, talent: false };

export async function frozenVisibilityTx(tx: Tx, reviewIds: readonly string[]): Promise<Map<string, FrozenVisibility>> {
  const unique = [...new Set(reviewIds)].sort();
  if (!unique.length) return new Map();
  const rows = await tx.execute<{ id: string; value: FrozenVisibility | null }>(
    sql`select q.id, app.onehr_frozen_visible(q.id) as value from unnest(array[${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]) as q(id) order by q.id`,
  );
  return new Map(rows.map((r) => [r.id, r.value ?? NONE]));
}

export async function frozenVisibilityOneTx(tx: Tx, reviewId: string): Promise<FrozenVisibility> {
  return (await frozenVisibilityTx(tx, [reviewId])).get(reviewId) ?? NONE;
}
