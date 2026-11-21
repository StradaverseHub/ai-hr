/**
 * Recruitment slice 8 — request handling shared by the public careers route handlers: per-process admission, the public
 * origin for "Copy link", the bounded form body (parsed once, straight from the stream), and the one log line a failure
 * may write (the error's kind and SQLSTATE only — never a value, an address or a field the visitor typed).
 */
import { appOrigin } from '../../lib/real-auth';
import { pgSqlState } from '../../lib/db-error';
import { createRequestAdmission } from '../../lib/request-budget';
import { CAREERS_BODY_MAX_BYTES } from '../../lib/careers-route';

/**
 * Per-process admission: at most this many careers requests are in progress in one server process; the rest are turned
 * away at once (reads: a short "busy" page; submissions: 429) instead of queueing memory, sockets or database work.
 *
 * Sized against the careers pool (4 connections, packs/recruitment/careers.ts), not against demand: 8 reads and 4
 * submissions mean at most 12 statements for 4 connections, so nothing waits behind more than two others. Reads are one
 * indexed statement of a few milliseconds, so the normal wait is a few milliseconds; the pathological wait is bounded by
 * the pool's 5-second statement timeout times that depth. A pool acquire timeout was not used because postgres.js has
 * none — a fixed, small admission is the bound. Anyone beyond it gets an immediate answer instead of a queue.
 */
export const CAREERS_READ_ADMISSION = 8;
export const CAREERS_SUBMIT_ADMISSION = 4;
export const admitCareersRead = createRequestAdmission(CAREERS_READ_ADMISSION);
export const admitCareersSubmit = createRequestAdmission(CAREERS_SUBMIT_ADMISSION);

/** The configured public origin; the request's own origin only when none is configured (local development). */
export function careersOrigin(request: Request): string {
  return appOrigin() ?? new URL(request.url).origin;
}

export function logCareersFailure(stage: string, e: unknown): void {
  console.error('careers request failed', stage, e instanceof Error ? e.name : typeof e, pgSqlState(e) ?? '');
}

/** A query-string value as plain text: control characters dropped, trimmed, bounded. */
export function careersQueryText(value: string | null, max: number): string {
  return [...(value ?? '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim()].slice(0, max).join('');
}

class TooLarge extends Error {}

/**
 * The form body, refused above CAREERS_BODY_MAX_BYTES before it is parsed: first by its declared Content-Length, then by
 * counting the stream as the parser reads it (a body without a length, or longer than it said, is cut off at the limit).
 * The parser reads the stream directly: the body is never gathered into a second buffer first.
 */
export async function readCareersForm(request: Request): Promise<FormData | 'too_large' | 'malformed'> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,12}$/.test(declared.trim()) || Number(declared) > CAREERS_BODY_MAX_BYTES)) return 'too_large';
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;/i.test(type) && !/^application\/x-www-form-urlencoded\b/i.test(type)) return 'malformed';
  if (!request.body) return 'malformed';
  let total = 0;
  let over = false;
  const counted = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > CAREERS_BODY_MAX_BYTES) {
        over = true;
        controller.error(new TooLarge());
      } else controller.enqueue(chunk);
    },
  }));
  try {
    return await new Response(counted, { headers: { 'content-type': type } }).formData();
  } catch {
    return over ? 'too_large' : 'malformed';
  }
}
