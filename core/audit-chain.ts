/**
 * ADR-0030 Layer-2 hash-chain verifier. Re-derives the per-tenant chain in SQL using the SAME
 * app.domain_event_hash function the trigger used (so they can't diverge) and reports any break:
 *   - chain_seq not contiguous  → a row was inserted or deleted
 *   - prev_hash doesn't link     → rows were reordered
 *   - recomputed hash ≠ stored   → a row's content was mutated
 *
 * Admin-only: it relies on the admin's unfiltered domain_event RLS read to see the whole chain (a
 * subject-scoped non-admin would see a partial chain and report false gaps).
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';

export type ChainIssue = { chainSeq: number; problem: 'gap' | 'reorder' | 'mutated' };
export type ChainVerification = { valid: boolean; checked: number; firstBadSeq: number | null; issues: ChainIssue[] };

function ctxIsAdmin(ctx: SessionContext): boolean {
  const roles = ctx.roles ?? (ctx.grants ?? []).map((g) => g.role);
  return roles.some((r) => r === 'hr_admin' || r === 'super_admin');
}

export async function verifyTenantChain(ctx: SessionContext): Promise<ChainVerification> {
  if (!ctxIsAdmin(ctx)) throw new Error('verifyTenantChain is admin-only (needs the full event log).');
  return withTenant(ctx, async (tx) => {
    const countRes = await tx.execute(
      sql`SELECT count(*)::int AS n FROM domain_event WHERE tenant_id = ${ctx.tenantId} AND chain_seq IS NOT NULL`,
    );
    const checked = Number((countRes as unknown as { n: number }[])[0]?.n ?? 0);

    // Returns only the BROKEN rows (empty result ⇒ intact chain). No boolean columns to parse across drivers.
    const badRes = await tx.execute(sql`
      WITH ordered AS (
        SELECT chain_seq, prev_hash, hash, tenant_id, aggregate_type, aggregate_id, event_type,
               actor_type, actor_id, subject_employment_id, payload,
               lag(hash) OVER (ORDER BY chain_seq) AS prior_hash,
               lag(chain_seq) OVER (ORDER BY chain_seq) AS prior_seq
        FROM domain_event
        WHERE tenant_id = ${ctx.tenantId} AND chain_seq IS NOT NULL
      )
      SELECT chain_seq AS "chainSeq", problem FROM (
        SELECT chain_seq,
          CASE
            WHEN chain_seq <> coalesce(prior_seq, 0) + 1 THEN 'gap'
            WHEN prev_hash IS DISTINCT FROM coalesce(prior_hash, 'GENESIS') THEN 'reorder'
            WHEN hash IS DISTINCT FROM app.domain_event_hash(prev_hash, tenant_id, chain_seq, aggregate_type,
              aggregate_id, event_type, actor_type::text, actor_id, subject_employment_id, payload) THEN 'mutated'
            ELSE NULL
          END AS problem
        FROM ordered
      ) q WHERE problem IS NOT NULL ORDER BY chain_seq
    `);
    const issues = (badRes as unknown as { chainSeq: number | string; problem: ChainIssue['problem'] }[]).map((r) => ({
      chainSeq: Number(r.chainSeq),
      problem: r.problem,
    }));
    const firstBadSeq = issues.length ? Math.min(...issues.map((i) => i.chainSeq)) : null;
    return { valid: issues.length === 0, checked, firstBadSeq, issues };
  });
}
