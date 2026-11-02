import { sql } from 'drizzle-orm';
import type { Tx } from '../../../db/client';

/**
 * WP-E (E-1) — which frozen components a reader outside the person's own projection may show.
 *
 * Raw frozen provenance is reserved for scoped administration. Native presence guards and
 * participant/report bands use bounded database projections; this helper shares the same
 * current release owner for UI metadata and independently selected leader courses.
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
