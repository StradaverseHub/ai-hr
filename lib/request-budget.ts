/** Shared abuse budgets contain hashes/counters only, never credentials or HR payloads. */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { client } from '../db/client';

export class RequestBudgetExceeded extends Error {
  constructor(public readonly retryAfter: number) { super('Request budget exceeded'); }
}

/** Only a reviewed ingress may overwrite this header; arbitrary forwarding headers are ignored. */
export function trustedRequestSource(request: Request): string | null {
  if (process.env.AIHR_TRUST_REQUEST_SOURCE !== '1') return null;
  const address = request.headers.get('x-aihr-request-source')?.trim();
  if(!address||!isIP(address))throw new Error('Trusted request source unavailable');
  return address;
}

export async function takeRequestBudget(scope: readonly string[], capacity: number, windowSeconds: number) {
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const rows = await client.unsafe('select app.consume_request_budget($1,$2,$3) retry_after', [key, capacity, windowSeconds]);
  const wait = Number(rows[0]?.retry_after);
  if (!Number.isFinite(wait) || wait < 0) throw new Error('Request budget unavailable');
  if (wait > 0) throw new RequestBudgetExceeded(Math.max(1, Math.ceil(wait)));
}

/** Local admission bounds outstanding session/DB work; shared budgets separately bound request rate. */
export function createRequestAdmission(capacity: number) {
  let active = 0;
  return () => {
    if (active >= capacity) throw new RequestBudgetExceeded(1);
    active++;
    let released = false;
    return () => { if (!released) { released = true; active--; } };
  };
}

/** Entries exist only while a request is admitted; no unbounded history of arbitrary source keys. */
export function createScopedAdmission(capacity: number) {
  const active = new Map<string, number>();
  return (scope: string) => {
    const count = active.get(scope) ?? 0;
    if (count >= capacity) throw new RequestBudgetExceeded(1);
    active.set(scope, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (active.get(scope) ?? 1) - 1;
      if (remaining > 0) active.set(scope, remaining); else active.delete(scope);
    };
  };
}
