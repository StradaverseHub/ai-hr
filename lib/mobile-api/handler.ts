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
 *     `mobileBinaryRoute` (below) is the sibling for a protected file: `private, no-store`, attachment only;
 *   • failures are told apart for the app: 401 means "sign in again", 503 means "retry, you are still
 *     signed in", 500 means a bug. Error bodies carry a code, never a message, a stack or a SQL error.
 */
import type { z } from 'zod';
import type { SessionContext } from '@/db/client';
import { AuthRequiredError } from '@/lib/auth-errors';
import { EntitlementsResolutionFailedError } from '@/core/entitlements';
import { getMobileSession } from '@/lib/session';
import {randomUUID} from 'node:crypto';
import type { ErrorResponse } from './contract';
import { PageRequestRefused } from './v2/common';
import { hasMobileBinarySignature, isMobileBinaryType, MOBILE_BINARY_TYPES, safeMobileFileName, type MobileBinaryType } from './binary-types';
import { createRequestAdmission, createScopedAdmission, RequestBudgetExceeded, takeRequestBudget, trustedRequestSource } from '../request-budget';

const admit = createRequestAdmission(24);
const admitSource = createScopedAdmission(16);
const admitActor = createScopedAdmission(12);

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export function mobileJson(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: HEADERS });
}

function mobileError(status: number, error: ErrorResponse['error'],supportId?:string): Response {
  const response=mobileJson(status,{error} satisfies ErrorResponse);
  if(supportId)response.headers.set('x-aihr-support-id',supportId);
  return response;
}

/** Error objects/causes, SQL parameters, schema messages and URLs may contain private HR or credentials. */
function privateFailure(status:500|503,error:ErrorResponse['error'],stage:'session'|'handler'|'contract'|'admission'){
  const supportId=randomUUID();
  console.error('[mobile-api]',{event:'request_failed',stage,supportId});
  return mobileError(status,error,supportId);
}

/** A known temporary dependency/configuration failure; never serialize its private cause. */
export class MobileServiceUnavailable extends Error {
  constructor(){super('Mobile service unavailable');this.name='MobileServiceUnavailable';}
}

/** Thrown by a handler for input it refuses; answered 400 with no detail. */
export class MobileBadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileBadRequest';
  }
}

export type MobileSessionResolver = () => Promise<SessionContext>;
export type MobileBudget = typeof takeRequestBudget;

/** Push-token enrollment (D6): its own hourly allowance per actor, beside the per-minute write budget. */
export const MOBILE_PUSH_ENROLLMENT_PATH = '/push/enrollment';

/**
 * Shared admission for every mobile wrapper: concurrency, source and actor budgets, per-path hourly
 * allowances, then the session. `handle` maps its own failures; only RequestBudgetExceeded escapes it.
 */
async function admitMobile(req: Request, resolve: MobileSessionResolver, budget: MobileBudget, binary: boolean, handle: (s: SessionContext) => Promise<Response>): Promise<Response> {
  let release: (() => void) | undefined;
  let releaseSource: (() => void) | undefined;
  let releaseActor: (() => void) | undefined;
  try {
    release = admit();
    const source = trustedRequestSource(req);
    if (source) { releaseSource = admitSource(source); await budget(['mobile-source', source], 180, 60); }
    let s: SessionContext;
    try {
      s = await resolve();
    } catch (e) {
      if (e instanceof AuthRequiredError) return mobileError(401, 'auth_required');
      // WorkOS keys unreachable, or the database behind principal_by_subject: an availability fault.
      return privateFailure(503,'unavailable','session');
    }
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    releaseActor = admitActor(JSON.stringify([s.tenantId, s.userId ?? s.personId ?? 'unbound']));
    await budget(['mobile-actor', s.tenantId, s.userId ?? s.personId ?? 'unbound', write ? 'write' : 'read'], write ? 30 : 180, 60);
    const pathname = new URL(req.url).pathname;
    if (pathname.endsWith('/clock-device')) await budget(['mobile-enrollment', s.tenantId, s.userId ?? 'unbound'], 5, 3600);
    // Offline claim upload carries up to 3 MiB (photo and proof): a weighted hourly allowance per actor, beside the
    // per-minute write budget. Engineering admission limit, not attendance policy; retries of a receipt count too.
    if (pathname.endsWith('/offline/claim')) await budget(['mobile-offline-claim', s.tenantId, s.userId ?? 'unbound'], 64, 3600);
    // Engineering admission limits, not HR policy: protected PDFs (payslip, EA) and push-token enrollment.
    if (binary) await budget(['mobile-document', s.tenantId, s.userId ?? 'unbound'], 30, 3600);
    if (pathname.endsWith(MOBILE_PUSH_ENROLLMENT_PATH)) await budget(['mobile-push-enrollment', s.tenantId, s.userId ?? 'unbound'], 10, 3600);
    return await handle(s);
  } catch (error) {
    if (error instanceof RequestBudgetExceeded) return Response.json({ error: 'unavailable' } satisfies ErrorResponse, {
      status: 429, headers: { ...HEADERS, 'retry-after': String(error.retryAfter) },
    });
    // A failed budget store must never grant an unmetered request.
    return privateFailure(503,'unavailable','admission');
  } finally { releaseActor?.(); releaseSource?.(); release?.(); }
}

/** A handler's thrown failure as the app reads it. RequestBudgetExceeded is rethrown to admission. */
function handlerFailure(e: unknown): Response {
  if (e instanceof RequestBudgetExceeded) throw e;
  if (e instanceof MobileServiceUnavailable) return mobileError(503,'unavailable');
  // The tenant's entitlements could not be read (an infrastructure fault): "retry", never "this module is off".
  if (e instanceof EntitlementsResolutionFailedError) return mobileError(503,'unavailable');
  if (e instanceof MobileBadRequest || e instanceof PageRequestRefused) return mobileError(400, 'bad_request');
  if (e instanceof AuthRequiredError) return mobileError(401, 'auth_required');
  return privateFailure(500,'internal','handler');
}

export function mobileRoute<S extends z.ZodType>(
  schema: S,
  fn: (s: SessionContext, req: Request) => Promise<z.input<S>>,
  // Injectable for tests only; production always resolves through getMobileSession().
  resolve: MobileSessionResolver = () => getMobileSession(),
  budget: MobileBudget = takeRequestBudget,
): (req: Request) => Promise<Response> {
  return (req: Request) => admitMobile(req, resolve, budget, false, async (s) => {
    let out: unknown;
    try {
      out = await fn(s, req);
    } catch (e) {
      return handlerFailure(e);
    }
    const parsed = schema.safeParse(out);
    if (!parsed.success) {
      // Contract drift between core and the published shape. Never send the unparsed body.
      return privateFailure(500,'internal','contract');
    }
    return mobileJson(200, parsed.data);
  });
}

// ── Authenticated binary responses (protected PDFs) ────────────────────────────────────────────────

export { MOBILE_BINARY_TYPES, MOBILE_ATTACHMENT_TYPES, type MobileBinaryType } from './binary-types';
/** Hard ceiling for any binary route; a route may declare a lower one. */
export const MOBILE_BINARY_MAX_BYTES = 10 * 1024 * 1024;
export type MobileBinary = { outcome: 'file'; contentType: MobileBinaryType; fileName: string; bytes: Uint8Array };

/**
 * `mobileRoute` for a file the phone saves: the same bearer session, budgets and failure mapping, plus an
 * hourly per-actor document allowance. A success is the bytes, never JSON: `Cache-Control: private,
 * no-store`, `Content-Disposition: attachment`, a content type the route allows (`options.types`, default
 * MOBILE_BINARY_TYPES: PDF only), a size bound and the type's signature checked. A business refusal is JSON
 * `{outcome:'refused',...}` at HTTP 200, parsed through the route's own `refusal` schema. Anything else is a
 * logged 500, never a best-effort send.
 */
export function mobileBinaryRoute<R extends z.ZodType>(
  refusal: R,
  fn: (s: SessionContext, req: Request) => Promise<MobileBinary | z.input<R>>,
  options: { maxBytes?: number; types?: readonly MobileBinaryType[] } = {},
  resolve: MobileSessionResolver = () => getMobileSession(),
  budget: MobileBudget = takeRequestBudget,
): (req: Request) => Promise<Response> {
  const maxBytes = Math.min(options.maxBytes ?? MOBILE_BINARY_MAX_BYTES, MOBILE_BINARY_MAX_BYTES);
  const types: readonly string[] = options.types ?? MOBILE_BINARY_TYPES;
  return (req: Request) => admitMobile(req, resolve, budget, true, async (s) => {
    let out: unknown;
    try {
      out = await fn(s, req);
    } catch (e) {
      return handlerFailure(e);
    }
    if (typeof out === 'object' && out !== null && (out as { outcome?: unknown }).outcome === 'file') {
      const file = out as MobileBinary;
      const bytes = file.bytes;
      if (typeof file.contentType !== 'string' || !isMobileBinaryType(file.contentType, types) || !(bytes instanceof Uint8Array) ||
        bytes.byteLength > maxBytes || !hasMobileBinarySignature(file.contentType, bytes)) {
        return privateFailure(500,'internal','contract');
      }
      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      return new Response(body, { status: 200, headers: {
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-type': file.contentType,
        'content-length': String(body.byteLength), 'content-disposition': `attachment; filename="${safeMobileFileName(file.contentType, typeof file.fileName === 'string' ? file.fileName : '')}"`,
      } });
    }
    const parsed = refusal.safeParse(out);
    if (!parsed.success || (parsed.data as { outcome?: unknown } | null)?.outcome !== 'refused') return privateFailure(500,'internal','contract');
    return mobileJson(200, parsed.data);
  });
}
