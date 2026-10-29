/**
 * Shared v2 contract pieces for the native employee/approver journeys (ADR-0088 §2). Imported by route
 * handlers AND by the Expo app, so this file stays dependency-free: zod plus TextEncoder/TextDecoder, no
 * server module, no Node Buffer, no 'server-only'.
 *
 * v1 enums are closed (lib/mobile-api/contract.ts ErrorResponse, LeaveResult): a store-installed v1 app
 * would reject a new value. New refusal codes and list shapes therefore live here, in v2 only.
 */
import { z } from 'zod';

// ── Paged lists ────────────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 50;
/** Encoded cursor bound. A keyset tuple (instant + uuid + list kind) encodes to ~150 characters. */
export const CURSOR_MAX_LENGTH = 512;
const CURSOR_VERSION = 1;
const CURSOR_PART_MAX = 128;
const CURSOR_PARTS_MAX = 4;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Refused list input: a garbage, tampered, oversized or foreign cursor, or a bad page size. The mobile
 * wrappers answer it 400 `bad_request`, never 500. The cursor is NOT an authorization token: every page
 * re-runs its keyset query under the caller's own session and RLS, so a forged cursor only moves the
 * caller's position inside what they may already read.
 */
export class PageRequestRefused extends Error {
  constructor(message = 'Invalid page request') { super(message); this.name = 'PageRequestRefused'; }
}

export const PageCursor = z.string().min(1).max(CURSOR_MAX_LENGTH).regex(BASE64URL);
/** `{items, nextCursor}`; `nextCursor` null ⇔ this is the last page. */
export function pageOf<S extends z.ZodType>(item: S) {
  return z.object({ items: z.array(item).max(PAGE_SIZE_MAX), nextCursor: PageCursor.nullable() });
}
export type Page<T> = { items: T[]; nextCursor: string | null };

type CursorPart = string | number | null;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += ALPHABET[n & 63];
  }
  return out;
}
function fromBase64Url(text: string): Uint8Array {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new PageRequestRefused();
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    let n = 0;
    for (let j = 0; j < 4; j++) n = (n << 6) | (j < chunk.length ? ALPHABET.indexOf(chunk[j]) : 0);
    bytes.push((n >> 16) & 255);
    if (chunk.length > 2) bytes.push((n >> 8) & 255);
    if (chunk.length > 3) bytes.push(n & 255);
  }
  const out = Uint8Array.from(bytes);
  // Canonical form only: non-zero padding bits would give two spellings of one cursor.
  if (toBase64Url(out) !== text) throw new PageRequestRefused();
  return out;
}
const validPart = (part: unknown): part is CursorPart =>
  part === null || (typeof part === 'number' && Number.isFinite(part)) || (typeof part === 'string' && part.length <= CURSOR_PART_MAX);

/**
 * Opaque keyset cursor: base64url(JSON `[version, list, ...tuple]`). `list` names the list the cursor
 * belongs to, so a cursor from one list is refused by another instead of being misread as its position.
 */
export function encodeCursor(list: string, tuple: readonly CursorPart[]): string {
  if (!list || list.length > 64 || tuple.length < 1 || tuple.length > CURSOR_PARTS_MAX || !tuple.every(validPart)) throw new Error('Invalid cursor tuple');
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify([CURSOR_VERSION, list, ...tuple])));
  if (encoded.length > CURSOR_MAX_LENGTH) throw new Error('Cursor too large');
  return encoded;
}

/** Null for the first page. Anything else must decode to this list's tuple, or it is refused. */
export function decodeCursor<T extends readonly CursorPart[]>(list: string, raw: string | null | undefined, tuple: z.ZodType<T>): T | null {
  if (raw == null || raw === '') return null;
  if (raw.length > CURSOR_MAX_LENGTH) throw new PageRequestRefused();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(raw))); }
  catch { throw new PageRequestRefused(); }
  if (!Array.isArray(value) || value[0] !== CURSOR_VERSION || value[1] !== list) throw new PageRequestRefused();
  const parts = value.slice(2);
  if (parts.length < 1 || parts.length > CURSOR_PARTS_MAX || !parts.every(validPart)) throw new PageRequestRefused();
  const parsed = tuple.safeParse(parts);
  if (!parsed.success) throw new PageRequestRefused();
  return parsed.data;
}

/** `?limit=` (default 25, 1..50, digits only) and `?cursor=` for a list `list`. */
export function pageRequest<T extends readonly CursorPart[]>(url: URL, list: string, tuple: z.ZodType<T>): { limit: number; cursor: T | null } {
  const rawLimit = url.searchParams.get('limit');
  if (url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('cursor').length > 1) throw new PageRequestRefused();
  let limit = PAGE_SIZE_DEFAULT;
  if (rawLimit !== null) {
    if (!/^\d{1,2}$/.test(rawLimit)) throw new PageRequestRefused();
    limit = Number(rawLimit);
    if (limit < 1 || limit > PAGE_SIZE_MAX) throw new PageRequestRefused();
  }
  return { limit, cursor: decodeCursor(list, url.searchParams.get('cursor'), tuple) };
}

// ── Refusals and commands ──────────────────────────────────────────────────────────────────────────

const refusalCode = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
/** A business refusal is HTTP 200 `{outcome:'refused',code,message?}`, as v1 LeaveResult. */
export function refusalOf<const C extends readonly [string, ...string[]]>(codes: C) {
  return z.object({ outcome: z.literal('refused'), code: z.enum(codes), message: z.string().max(4000).optional() });
}
/** Any v2 refusal, for a client that must recognise one before it knows the command. */
export const MobileRefusal = z.object({ outcome: z.literal('refused'), code: refusalCode, message: z.string().max(4000).optional() });
export type MobileRefusal = z.infer<typeof MobileRefusal>;

/** The same requestId already recorded a different intent (core/mobile-command-receipt.ts). */
export const CommandConflict = refusalOf(['request_conflict']);
export type CommandConflict = z.infer<typeof CommandConflict>;
export const COMMAND_CONFLICT: CommandConflict = { outcome: 'refused', code: 'request_conflict' };

/** Every v2 command carries a client-generated idempotency key; identity and policy never travel in the body. */
export const CommandEnvelope = z.object({ requestId: z.string().uuid() });
export function commandOf<S extends z.ZodRawShape>(shape: S) {
  return CommandEnvelope.extend(shape).strict();
}
