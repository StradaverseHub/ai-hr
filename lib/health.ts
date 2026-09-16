/**
 * The readiness probe behind `/health` (readiness 1.6).
 *
 * ── PROCESS ALIVE IS NOT THE SAME QUESTION AS CAN SERVE REQUESTS ─────────────────────────────────
 *
 * A route handler that returns a constant 200 answers only the first question, and it answers it
 * badly: if the process were dead the request would not be answered at all, so the constant 200 tells
 * a monitor nothing it did not already learn by connecting. Worse, it ACTIVELY LIES during the outage
 * that matters most — Postgres down, the pool exhausted, a revoked GRANT — because the Next server
 * stays up and cheerfully serves 200 while every real page 500s. A health check nobody has ever seen
 * fail is not a guard; it is a green light wired to nothing.
 *
 * So this probe does a real database round trip, and the two questions are distinguished by what the
 * monitor observes, with no ambiguity between them:
 *
 *   connection refused / timeout   the process is not alive (or nothing is routing to it)
 *   503 {"status":"unhealthy"}     the process is alive and CANNOT serve requests
 *   200 {"status":"ok"}            alive, and the dependency a request needs answered
 *
 * There is deliberately NO liveness-only URL next to this one. A permanently-200 endpoint sitting
 * beside the real check is a trap: someone eventually points the monitor at the cheap one, and the
 * whole item quietly reverts to the thing it was built to replace.
 *
 * ── WHAT THE PROBE PROVES, AND WHAT IT DOES NOT ──────────────────────────────────────────────────
 *
 * `select 1` as the application role proves: TCP reachability, authentication, that the server is
 * accepting queries and not in recovery-refusal, and that the pool can hand out a connection inside
 * the timeout. That is the set of failures that make every page 500.
 *
 * It does NOT prove the schema is at the right migration, that RLS policies are intact, or that the
 * app role still holds its GRANTs. Those are real risks (see readiness 1.7 on `bootstrap-db.sql`
 * silently restoring a grant) but they are not what a polled endpoint should answer: a query that
 * touches a table would either be filtered to zero rows by RLS with no tenant GUC — indistinguishable
 * from an empty table — or would need a tenant context this endpoint has no business holding. An
 * honest cheap check plus this comment beats an expensive one that over-claims.
 *
 * ── KEEPING IT CHEAP, BECAUSE IT WILL BE POLLED ──────────────────────────────────────────────────
 *
 * This is the only unauthenticated endpoint in the application, which makes it the only one an
 * anonymous caller can use to make the app do work. Two bounds, and both are load-bearing:
 *
 *   SINGLE FLIGHT — concurrent callers share one probe. Without it, N simultaneous requests take N
 *     connections out of a pool of 10 and starve the real traffic this endpoint exists to protect.
 *   A ONE-SECOND CACHE — repeat callers inside the window get the last verdict. This bounds the
 *     database cost of the endpoint to one `select 1` per second no matter how hard it is hit, and a
 *     one-second staleness is irrelevant to a monitor polling every 10 to 60 seconds.
 *
 * ── LOGGING ON TRANSITION, NOT PER REQUEST ───────────────────────────────────────────────────────
 *
 * The RESPONSE is the alarm; the JOURNAL is the diagnosis. Logging every failed probe would write a
 * line a second for the length of an outage and bury the one line that says when it began. So the
 * reason is logged when the verdict CHANGES, in both directions, which is exactly "when did it start"
 * and "when did it come back". The monitor is the repeater; this is not.
 */

/** The probe's whole budget. Short on purpose: a monitor typically gives up at five to ten seconds,
 *  and a database that has not answered `select 1` in two seconds cannot serve a page either. */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/** How long a verdict is reused for. See "keeping it cheap" above. */
export const HEALTH_CACHE_MS = 1_000;

/**
 * A thunk that performs one round trip and resolves on success / rejects on failure.
 *
 * Passed in rather than imported so this module holds no database handle of its own — the route
 * supplies the REAL application pool (`db/client.ts`), which is the point: the probe must exercise the
 * same connections a page would use, not a private one that can be healthy while the app's is not.
 */
export type HealthProbe = () => PromiseLike<unknown>;

type Verdict = { at: number; healthy: boolean };

let last: Verdict | null = null;
let inFlight: Promise<boolean> | null = null;

/** Tests only — the cache and the transition memory are process-lifetime by design. */
export function __resetHealthStateForTests(): void {
  last = null;
  inFlight = null;
}

/**
 * Bound the probe. `Promise.race` keeps a rejection handler attached to `p`, so a probe that fails
 * AFTER the timeout has already fired is still handled and cannot surface as an unhandledRejection —
 * which on this service would be a crash, i.e. a health check that kills the thing it measures.
 */
async function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`probe did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runProbe(probe: HealthProbe): Promise<boolean> {
  let healthy: boolean;
  let reason = '';
  try {
    await withTimeout(probe(), HEALTH_PROBE_TIMEOUT_MS);
    healthy = true;
  } catch (e) {
    healthy = false;
    // The reason goes to the JOURNAL and never to the response body: a Postgres connection error
    // names the host, the port, the role and the database.
    reason = e instanceof Error ? e.message : String(e);
  }

  // THE TWO ARMS ARE NOT SYMMETRIC, and running it is what showed that. A first probe in a fresh
  // process has no previous verdict, so `last === null || last.healthy !== healthy` announced
  // "recovered" on every ordinary boot — a line claiming an outage had just ended when nothing had
  // ever failed. In a journal nobody is watching closely (which is the whole premise of 1.6) that is
  // exactly the kind of line someone chases at 3am. So:
  //   FAILURE is announced on the first probe, because an instance that comes up unable to reach the
  //     database has genuinely failed and there may never be a "transition" to report.
  //   RECOVERY is announced only when there is a failure to recover FROM.
  if (!healthy && (last === null || last.healthy)) {
    console.error(
      `✗ HEALTH: the database probe FAILED, so /health is answering 503 and this instance cannot ` +
        `serve requests. Reason: ${reason}`,
    );
  } else if (healthy && last !== null && !last.healthy) {
    console.log('✓ HEALTH: the database probe recovered; /health is answering 200 again.');
  }
  // Stamped AFTER the probe, not before: a probe that burns the full timeout would otherwise store a
  // verdict that is already older than the cache window, so every request during a hang would start
  // its own two-second probe.
  last = { at: Date.now(), healthy };
  return healthy;
}

/**
 * The verdict behind `/health`. Never throws: a probe that fails IS the answer, and an exception here
 * would become a 500, which reads to a monitor as a different kind of broken than it is.
 */
export async function checkHealth(probe: HealthProbe): Promise<boolean> {
  if (last !== null && Date.now() - last.at < HEALTH_CACHE_MS) return last.healthy;
  if (inFlight !== null) return inFlight;
  const p = runProbe(probe);
  inFlight = p;
  try {
    return await p;
  } finally {
    if (inFlight === p) inFlight = null;
  }
}

/** The entire vocabulary of the response body. Exported so the route and its tests cannot drift. */
export const HEALTH_BODY_OK = { status: 'ok' } as const;
export const HEALTH_BODY_UNHEALTHY = { status: 'unhealthy' } as const;
