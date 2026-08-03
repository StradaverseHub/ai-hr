/**
 * ADR-0077 slice 9 — WHICH TENANTS A SCHEDULED SWEEP MAY TOUCH.
 *
 * r104 made a tenant out of good standing read-only inside `withTenant`, and r105 built the only thing
 * that puts a tenant into that state. This is the third piece: the out-of-band sweeps run OUTSIDE a
 * request, enumerate every tenant with the owner role, and until now consulted nothing about standing.
 *
 * WHAT WAS ACTUALLY BROKEN, and it is not what it looks like. After r104 the sweeps disagreed (there
 * were four at the time; c459bff9 deleted expire-aged-leave, leaving three — the analysis is unchanged):
 *
 *   - accrue-earned and expire-carry build their context with
 *     `entitlementsExempt: 'sweeps'`, which means the context carries NO snapshot. r104 keys the
 *     read-only guard on `ctx.entitlements?.tenantStatus`, and deliberately treats an absent snapshot as
 *     "not known to be bad" rather than "bad" — so for these the guard NEVER ENGAGED. They granted
 *     leave, forfeited days and appended events inside a suspended tenant exactly as before.
 *   - review-sweep resolves a REAL snapshot (it has to: it calls the billable notifications gate). So for
 *     that one the guard DID engage — and engaged as a CRASH, a read-only transaction error counted as a
 *     per-tenant failure, which makes the process exit non-zero and pages an operator every night for a
 *     tenant that is suspended on purpose.
 *
 * So suspension was enforced for exactly one of them, and enforced there in the one form nobody wants.
 * The `entitlementsExempt` marker is not the bug — it exists for MODULE gating, and widening it to carry
 * standing would put the same decision in two places. The fix is that the sweeps decide who is in scope
 * BEFORE they open a transaction, and skipping is a first-class outcome rather than a failure.
 *
 * ONE PREDICATE, TWO CONSUMERS. Scope is decided by `TENANT_STATUS_GOOD_STANDING` — the SAME set
 * withTenant uses. That is the whole point: a sweep must never attempt a write the write boundary would
 * refuse. If the two used different rules they would drift, and the drift would surface as exactly the
 * read-only crash described above.
 *
 * AN UNRECOGNISED STATUS IS OUT OF SCOPE, and this cuts the opposite way from r105's dunning policy —
 * on purpose. There, an unknown `subscription.status` must NOT suspend, because acting on a value the
 * policy does not understand costs a customer their payroll. Here, an unknown `tenant.status` must NOT
 * be swept, because withTenant will refuse the writes anyway (it is not in the good-standing set) and the
 * sweep would merely discover that as an error. Both rules say the same thing: agree with the write
 * boundary, and never infer standing from a value you cannot interpret. The status is reported BY NAME so
 * an operator sees which value nobody taught this code about.
 *
 * SKIPPING IS NOT FAILING. A skipped tenant is reported, recorded in the run log, and leaves the exit
 * code alone. A suspended customer is a business state, not an incident.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: catch up. A sweep skipped during suspension is not replayed here.
 * Accrual happens to self-heal — `accrueEarned` computes from service dates up to `asOf`, so the next run
 * after reinstatement grants the missed months. EXPIRY DOES NOT: a naive re-run after reinstatement would
 * forfeit everything whose expiry date fell inside the suspended window, which is precisely what the
 * reactivation plan says must not happen ("records the suspended window, replays skipped sweeps with the
 * window excluded from expiry clocks"). Recording the skips is what gives that replay its input; the
 * replay itself is reactivation's job, not the sweep's. See the assertion in test/sweep-scope.test.ts
 * that pins this asymmetry so nobody "simplifies" it into a catch-up loop.
 */
import { ne } from 'drizzle-orm';
import type { createDb } from '../db/client';
import { tenant } from '../db/schema';
import { TENANT_STATUS_GOOD_STANDING } from './entitlement-types';

/**
 * The reserved tenant migration 0151 inserts so that PRE-AUTH audit events have something to FK to:
 * `app.append_auth_event` stamps this id for login-failed and reset-request, which happen before any
 * tenant is known. It is not a customer. It has no employments, no companies and no subscription.
 *
 * Every sweep has been enumerating it every night since they were written, because they selected
 * `id, name` straight off `tenant` with no filter. Nothing came of it — there is nothing there to sweep —
 * but it inflated `tenants_processed` in the run log by one, so every count on the Scheduled Actions
 * screen has been reporting one more customer than exists. scripts/reconcile-entitlement-parity.ts had
 * already learned this and skips it by hand; putting it in the shared enumerator is what stops the next
 * sweep from having to learn it again.
 */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** The columns a sweep needs to decide scope. Deliberately minimal — id, a name to print, and standing. */
export type SweepTenant = { id: string; name: string; status: string };

export type SweepSkip = { tenant: SweepTenant; reason: string };

/** Tenants a sweep may write to, and the ones it stepped over with the reason it did. */
export type SweepScope = { run: SweepTenant[]; skipped: SweepSkip[] };

/**
 * Why this tenant is out of scope, or null if it is in scope.
 *
 * Returns a REASON STRING rather than a boolean so the skip is self-explaining wherever it surfaces —
 * console line, run log, or an operator asking why last night granted nothing.
 */
export function sweepSkipReason(status: string): string | null {
  if (TENANT_STATUS_GOOD_STANDING.has(status)) return null;
  if (status === 'suspended') return 'suspended — writes are refused until the account is reinstated';
  if (status === 'closed') return 'closed — the tenant is in its retention window';
  // Not a defensive branch: `tenant.status` is plain text (the 0275 widening lesson), so a value this
  // code has never seen is reachable by adding one anywhere else. Naming it is the useful part.
  return `status '${status}' is not recognised as good standing`;
}

/** Split an enumerated tenant list into what a sweep may touch and what it must step over. */
export function partitionSweepTenants(tenants: readonly SweepTenant[]): SweepScope {
  const run: SweepTenant[] = [];
  const skipped: SweepSkip[] = [];
  for (const t of tenants) {
    const reason = sweepSkipReason(t.status);
    if (reason === null) run.push(t);
    else skipped.push({ tenant: t, reason });
  }
  return { run, skipped };
}

/** The console lines a sweep prints for what it stepped over. Empty when nothing was skipped. */
export function describeSkips(scope: SweepScope): string[] {
  return scope.skipped.map((s) => `  – ${s.tenant.name} (${s.tenant.id}): SKIPPED, ${s.reason}`);
}

/**
 * The owner Drizzle handle, derived from createDb's own return type (the core/job-run.ts precedent) so
 * the select below is checked against the real column types.
 */
type OwnerDb = ReturnType<typeof createDb>['db'];

/**
 * Enumerate every tenant and split it by standing. This replaces the bare `select id, name from tenant`
 * the sweeps each carried — the point is that `status` is no longer optional to ask for, so a new
 * sweep cannot forget to consider it by simply not selecting the column.
 *
 * Runs on the OWNER connection, so RLS does not bind it and the enumeration is genuinely every tenant.
 */
export async function loadSweepScope(db: OwnerDb): Promise<SweepScope> {
  const rows = await db
    .select({ id: tenant.id, name: tenant.name, status: tenant.status })
    .from(tenant)
    // Filtered in the QUERY, not reported as a skip: the reserved audit anchor is not a customer whose
    // standing was considered and found wanting, so listing it as "skipped" would be its own small lie.
    .where(ne(tenant.id, SYSTEM_TENANT_ID));
  return partitionSweepTenants(rows);
}
