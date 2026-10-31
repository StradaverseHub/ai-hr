/**
 * Request parsing shared by the M11 v2 claim routes (app/api/mobile/v2/claims/**). Server only in practice (it reads
 * the request body and hashes it with node:crypto).
 *
 *   claimEmployment  which of the caller's OWN claim-eligible employments the request is about
 *   claimIdOf        the `{id}` after `/claims/`, a UUID or a 400
 *   attachmentOf     `?attachment=`, a UUID or a 400
 *   claimUpload      the multipart `command` (parsed by its own contract) and the optional `receipt`, SNIFFED
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { SessionContext } from '@/db/client';
import { myOwnEmploymentSubjects } from '@/core/read';
import type { ClaimUpload } from '@/core/mobile-claims';
import { MobileBadRequest } from './handler';
import { mobileForm } from './body';
import { hasMobileBinarySignature } from './binary-types';
import { CLAIM_RECEIPT_MAX_BYTES, CLAIM_RECEIPT_TYPES, CLAIM_UPLOAD_PARTS } from './v2/claims';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The receipt's 10 MB plus room for the command and the multipart framing; a longer body is a 400 before parsing. */
export const CLAIM_UPLOAD_BODY_LIMIT = CLAIM_RECEIPT_MAX_BYTES + 64 * 1024;

function one(url: URL, key: string): string | null {
  const all = url.searchParams.getAll(key);
  if (all.length > 1) throw new MobileBadRequest(`Repeated ${key}`);
  return all[0] ?? null;
}

/**
 * The caller's OWN claim-eligible employment: no `?employmentId=` ⇒ the first; a named one must be among them, else
 * null. The set is the claims kernel's own subject rule (app/(app)/claims/subject.ts ownClaimSubject, core/claims.ts
 * ownClaimFormAvailable): myOwnEmploymentSubjects({profileEdit:true}) — the login's own person, started, not past its
 * last working day, not blacklisted, and the login not blocked. An offboarded or blocked caller therefore has none
 * (`no_employment` / an empty list), and an id that is not theirs never reaches a claim read. A malformed id is a 400.
 */
export async function claimEmployment(s: SessionContext, req: Request): Promise<string | null> {
  const requested = one(new URL(req.url), 'employmentId');
  if (requested !== null && !UUID.test(requested)) throw new MobileBadRequest('Invalid employmentId');
  if (!s.userId || !s.personId) return null;
  const own = await myOwnEmploymentSubjects(s, { profileEdit: true });
  if (requested === null) return own[0]?.employmentId ?? null;
  return own.find((e) => e.employmentId === requested.toLowerCase())?.employmentId ?? null;
}

/** The `{id}` segment after `/claims/`: a UUID or a 400 (the app never sends anything else). */
export function claimIdOf(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  const at = parts.indexOf('claims');
  const id = at < 0 ? '' : parts[at + 1] ?? '';
  if (!UUID.test(id)) throw new MobileBadRequest('Invalid claim id');
  return id.toLowerCase();
}

/** `?attachment=` — the receipt to send. A UUID or a 400. */
export function attachmentOf(req: Request): string {
  const id = one(new URL(req.url), 'attachment');
  if (!id || !UUID.test(id)) throw new MobileBadRequest('Invalid attachment');
  return id.toLowerCase();
}

/**
 * The receipt's type FROM ITS BYTES (app/(app)/claims/actions.ts sniffMime's rule, fail closed), never the part's declared
 * type. The signatures are lib/mobile-api/binary-types.ts's — the ones the receipt routes check before SENDING a file
 * — so every receipt accepted here can be sent back to the phone (a stricter read of the web's 4-byte PDF/PNG check).
 */
export function sniffReceipt(bytes: Uint8Array): (typeof CLAIM_RECEIPT_TYPES)[number] | null {
  return CLAIM_RECEIPT_TYPES.find((type) => hasMobileBinarySignature(type, bytes)) ?? null;
}

/**
 * A claim upload: multipart with a JSON `command` part (parsed by `schema`, else a 400) and an optional `receipt`
 * file. An empty, oversized or unrecognised receipt is a typed refusal (`receipt_empty` / `receipt_too_large` /
 * `receipt_type`), decided here before any command runs; a body past CLAIM_UPLOAD_BODY_LIMIT is a 400.
 */
export async function claimUpload<S extends z.ZodType>(req: Request, schema: S): Promise<{ command: z.output<S>; upload: ClaimUpload }> {
  const form = await mobileForm(req, CLAIM_UPLOAD_PARTS, CLAIM_UPLOAD_BODY_LIMIT);
  const raw = form.get('command');
  if (typeof raw !== 'string') throw new MobileBadRequest('Invalid command');
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new MobileBadRequest('Invalid command'); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new MobileBadRequest('Invalid command');
  const command = parsed.data as z.output<S>;
  const file = form.get('receipt');
  if (file === null) return { command, upload: { kind: 'none' } };
  if (!(file instanceof File) || file.name.length > 200) throw new MobileBadRequest('Invalid receipt');
  if (file.size === 0) return { command, upload: { kind: 'refused', code: 'receipt_empty' } };
  if (file.size > CLAIM_RECEIPT_MAX_BYTES) return { command, upload: { kind: 'refused', code: 'receipt_too_large' } };
  const content = Buffer.from(await file.arrayBuffer());
  const mimeType = sniffReceipt(content);
  if (!mimeType) return { command, upload: { kind: 'refused', code: 'receipt_type' } };
  return {
    command,
    upload: { kind: 'file', fileName: file.name.trim() || 'receipt', mimeType, content, sha256: createHash('sha256').update(content).digest('hex') },
  };
}
