/**
 * The one way a mobile route handler obtains a session and sends a response (ADR-0088 §2).
 *
 *   export const GET = mobileRoute(MeResponse, async (s) => ({ ... }));
 *
 * What it guarantees, so no handler has to remember it:
 *   • the caller is resolved by `getMobileSession()` — a verified bearer token, never a cookie;
 *   • the body is parsed through its contract schema BEFORE it is sent, so an unlisted field is stripped
 *     and a malformed one is a logged 500, never a best-effort send;
 *   • every response is `Cache-Control: no-store` (payslips and balances must not sit in an HTTP cache);
 *   • failures are told apart for the app: 401 means "sign in again", 503 means "retry, you are still
 *     signed in", 500 means a bug. Error bodies carry a code, never a message, a stack or a SQL error.
 */
import type { z } from 'zod';
import type { SessionContext } from '@/db/client';
import { AuthRequiredError } from '@/lib/auth-errors';
import { getMobileSession } from '@/lib/session';
import { JwksUnavailableError } from './jwt';
import type { ErrorResponse } from './contract';

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export function mobileJson(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: HEADERS });
}

function mobileError(status: number, error: ErrorResponse['error']): Response {
  return mobileJson(status, { error } satisfies ErrorResponse);
}

/** Thrown by a handler for input it refuses; answered 400 with no detail. */
export class MobileBadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileBadRequest';
  }
}

export type MobileSessionResolver = () => Promise<SessionContext>;

export function mobileRoute<S extends z.ZodType>(
  schema: S,
  fn: (s: SessionContext, req: Request) => Promise<z.input<S>>,
  // Injectable for tests only; production always resolves through getMobileSession().
  resolve: MobileSessionResolver = () => getMobileSession(),
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    let s: SessionContext;
    try {
      s = await resolve();
    } catch (e) {
      if (e instanceof AuthRequiredError) return mobileError(401, 'auth_required');
      // WorkOS keys unreachable, or the database behind principal_by_subject: an availability fault.
      console.error('[mobile-api] session resolution failed', e instanceof JwksUnavailableError ? e.message : e);
      return mobileError(503, 'unavailable');
    }
    let out: unknown;
    try {
      out = await fn(s, req);
    } catch (e) {
      if (e instanceof MobileBadRequest) return mobileError(400, 'bad_request');
      if (e instanceof AuthRequiredError) return mobileError(401, 'auth_required');
      console.error(`[mobile-api] ${new URL(req.url).pathname} failed`, e);
      return mobileError(500, 'internal');
    }
    const parsed = schema.safeParse(out);
    if (!parsed.success) {
      // Contract drift between core and the published shape. Never send the unparsed body.
      console.error(`[mobile-api] ${new URL(req.url).pathname} response broke its contract`, parsed.error.issues);
      return mobileError(500, 'internal');
    }
    return mobileJson(200, parsed.data);
  };
}
