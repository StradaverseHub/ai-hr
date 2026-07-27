/**
 * ADR-0030 Layer-2 hash-chain verifier. Re-derives the per-tenant chain in SQL using the SAME
 * app.domain_event_hash function the trigger used (so they can't diverge) and reports any break:
 *   - chain_seq not contiguous  → a row was inserted or deleted
 *   - prev_hash doesn't link     → rows were reordered
 *   - recomputed hash ≠ stored   → a row's content was mutated
 *
 * Admin-only: it relies on the admin's unfiltered domain_event RLS read to see the whole chain (a
 * subject-scoped non-admin would see a partial chain and report false gaps).
 *
 * WHAT THIS CANNOT SEE, STATED BECAUSE SLICE 3 BRIEFLY CLAIMED THE OPPOSITE (ADR-0077 review r2).
 * Every query below filters `chain_seq IS NOT NULL`, and the trigger only assigns those columns while
 * the `app.audit_hash_chain` GUC is on. So an event appended with the chain DISARMED is not a broken
 * link — it is not in the chain at all, and no `gap`/`reorder`/`mutated` check can ever see it. Worse,
 * the trigger takes the chain head from `max(chain_seq)` over CHAINED rows only, so re-arming the gate
 * links the next event straight onto the last chained one: an arm → disarm → re-arm window leaves a
 * contiguous chain, a matching prev_hash link, and a green `valid: true`.
 *
 * That window is a real hole in the tamper evidence — events written inside it carry no digest — and it
 * used to be invisible. `unchained` is therefore counted and reported alongside `checked`, so "intact
 * over N chained events" and "N chained, M unprotected" are different answers on the DPO surface
 * instead of the same one. `valid` deliberately still means "the chained rows link correctly": it is
 * the tamper verdict, not a coverage verdict, and conflating the two would make an ordinary
 * chain-was-off-then-on deployment indistinguishable from an actual mutation.
 *
 * AND THE COUNT ALONE DOES NOT DISCRIMINATE, which review r3 caught and which is why
 * `unchainedInsideChain` exists. 0074:5 defers the backfill of pre-existing events by design, so every
 * event a tenant recorded before the chain was first armed stays `chain_seq IS NULL` forever — meaning
 * `checked > 0 && unchained > 0`, the shape this file called "dangerous", is also the shape of every
 * perfectly healthy tenant that predates the arming. Position is what separates the two: unchained
 * events that occurred AFTER the first chained one are inside the chain's coverage and can only be a
 * hole. That is the figure the DPO surface renders.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';

export type ChainIssue = { chainSeq: number; problem: 'gap' | 'reorder' | 'mutated' };
export type ChainVerification = {
  valid: boolean;
  checked: number;
  /**
   * Events for this tenant with NO chain columns — appended while the gate was off. Not a tamper
   * signal; a COVERAGE signal.
   */
  unchained: number;
  /**
   * The subset of `unchained` that occurred AFTER this tenant's first chained event — i.e. a genuine
   * HOLE inside the chain's coverage, as opposed to ordinary history from before the chain was ever
   * armed.
   *
   * WHY THE POSITION AND NOT THE COUNT (ADR-0077 slice 3 review). `checked > 0 && unchained > 0` was
   * documented here as "the dangerous shape" and rendered as such — but 0074:5 states by design that
   * "backfill of pre-existing events is deferred to the historical-redaction migration (ADR-0030 §3)",
   * so every event a tenant recorded before the chain was first switched on is permanently
   * `chain_seq IS NULL`. Any tenant that predates the arming therefore matches that shape FOREVER, with
   * or without a hole, which makes it a banner nobody can act on and the arm→disarm→re-arm window
   * indistinguishable from ordinary pre-chain history. Non-zero on THIS figure is unambiguous.
   */
  unchainedInsideChain: number;
  firstBadSeq: number | null;
  issues: ChainIssue[];
};

function ctxIsAdmin(ctx: SessionContext): boolean {
  const roles = ctx.roles ?? (ctx.grants ?? []).map((g) => g.role);
  return roles.some((r) => r === 'hr_admin' || r === 'super_admin');
}

export async function verifyTenantChain(ctx: SessionContext): Promise<ChainVerification> {
  if (!ctxIsAdmin(ctx)) throw new Error('verifyTenantChain is admin-only (needs the full event log).');
  return withTenant(ctx, async (tx) => {
    // ALL THREE counts in one pass, so they are read from the same snapshot and cannot disagree.
    //
    // The third is positional, keyed on `sequence` — the table's bigserial — and NOT on `occurred_at`.
    // `occurred_at` defaults to `now()`, which in Postgres is the TRANSACTION timestamp, so every event
    // appended inside one transaction shares it and a strict comparison would silently drop a whole
    // batch onto the wrong side of the boundary. `sequence` is assigned per row at INSERT and is the
    // append order this is actually asking about.
    //
    // When the tenant has no chained event the scalar subquery is NULL, the comparison is NULL rather
    // than true, and the count is 0 — the right answer, because a tenant with no chain has no hole in
    // one. `>`, not `>=`, because the minimum is itself a chained row.
    const countRes = await tx.execute(sql`
      SELECT count(*) FILTER (WHERE chain_seq IS NOT NULL)::int AS chained,
             count(*) FILTER (WHERE chain_seq IS NULL)::int     AS unchained,
             count(*) FILTER (
               WHERE chain_seq IS NULL
                 AND sequence > (SELECT min(sequence) FROM domain_event c
                                  WHERE c.tenant_id = ${ctx.tenantId} AND c.chain_seq IS NOT NULL)
             )::int AS unchained_inside
        FROM domain_event WHERE tenant_id = ${ctx.tenantId}`);
    const counts = (countRes as unknown as { chained: number; unchained: number; unchained_inside: number }[])[0];
    const checked = Number(counts?.chained ?? 0);
    const unchained = Number(counts?.unchained ?? 0);
    const unchainedInsideChain = Number(counts?.unchained_inside ?? 0);

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
    return { valid: issues.length === 0, checked, unchained, unchainedInsideChain, firstBadSeq, issues };
  });
}
