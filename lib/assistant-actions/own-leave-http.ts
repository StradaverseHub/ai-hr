/** Unmounted browser transport owner. No provider/model/tool capability or session supplied by POST.
 * The eventual route must bind authenticate to its real server session and operations to canonical
 * store/command owners; do not mount before source/security/migration acceptance. */
import { z } from 'zod';
import { isSameOriginBrowserRequest } from '../request-origin';
import { OwnLeaveConfirmation, OwnLeaveFinalReceipt, OwnLeaveHumanSelection, OwnLeaveHumanText,
  OwnLeaveNomination, OwnLeavePreparedReview } from './own-leave-contract';

const Packet = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), nomination: OwnLeaveNomination,
    selection: OwnLeaveHumanSelection, humanText: OwnLeaveHumanText }).strict(),
  z.object({ operation: z.literal('reopen'), actionId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('confirm'), confirmation: OwnLeaveConfirmation }).strict(),
  z.object({ operation: z.literal('discard'), confirmation: OwnLeaveConfirmation }).strict(),
]);
const PublicResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prepared'), review: OwnLeavePreparedReview }).strict(),
  z.object({ kind: z.literal('completed'), receipt: OwnLeaveFinalReceipt.refine(value => value.state === 'completed') }).strict(),
  z.object({ kind: z.literal('retired'), receipt: OwnLeaveFinalReceipt.refine(value => value.state !== 'completed') }).strict(),
  ...(['unavailable', 'needs_selection', 'needs_employee_remark', 'use_leave_form'] as const)
    .map(kind => z.object({ kind: z.literal(kind) }).strict()),
]);
type Packet = z.infer<typeof Packet>;
export type OwnLeaveBrowserOwners<Session> = Readonly<{
  authenticate(): Promise<Session>;
  prepare(session: Session, packet: Extract<Packet, { operation: 'prepare' }>): Promise<unknown>;
  reopen(session: Session, actionId: string): Promise<unknown>;
  confirm(session: Session, confirmation: z.infer<typeof OwnLeaveConfirmation>): Promise<unknown>;
  discard(session: Session, confirmation: z.infer<typeof OwnLeaveConfirmation>): Promise<unknown>;
}>;
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie, Authorization',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const failure = (status: number) => Response.json({ error: 'unavailable' }, { status, headers });
const MAX_BYTES = 20 * 1024;

/** Byte, fragment and total-time bounds apply before identity/database work. No text is logged or
 * retained. Cancellation before dispatch prevents dispatch; once canonical confirmation starts,
 * transport loss is uncertain and the client must reopen the SAME action, never auto-create/retry. */
async function readPacket(request: Request): Promise<Packet> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BYTES)) throw Error();
  if (!request.body || request.signal.aborted) throw Error();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0, reads = 0, timeout!: ReturnType<typeof setTimeout>, rejectAbort!: () => void;
  const stopped = new Promise<never>((_, reject) => { rejectAbort = () => reject(Error()); });
  void stopped.catch(() => {});
  const abort = () => { rejectAbort(); void reader.cancel().catch(() => {}); };
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  timeout = setTimeout(abort, 5000);
  try {
    for (;;) {
      if (++reads > 512) throw Error();
      const part = await Promise.race([reader.read(), stopped]);
      if (part.done) break;
      bytes += part.value.byteLength; if (bytes > MAX_BYTES) throw Error();
      chunks.push(part.value);
    }
    if (request.signal.aborted) throw Error();
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return Packet.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
  } catch { void reader.cancel().catch(() => {}); throw Error(); }
  finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** Every operation is explicit POST. GET/reopen cannot become an effect path; scope/locale/user/tenant
 * and confirmation business fields cannot be injected. Authentication failure never reaches owners.
 * Dependencies are bound server-side, not constructed from a posted name, callback or model tool. */
export function createOwnLeaveBrowserHandler<Session>(owners: OwnLeaveBrowserOwners<Session>) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return Response.json({ error: 'unavailable' }, { status: 405, headers: { ...headers, Allow: 'POST' } });
    const site = request.headers.get('sec-fetch-site');
    if (new URL(request.url).search || !isSameOriginBrowserRequest(request) || (site !== null && site !== 'same-origin')) return failure(403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return failure(415);
    let packet: Packet;
    try { packet = await readPacket(request); } catch { return failure(400); }
    let session: Session;
    try { session = await owners.authenticate(); } catch { return failure(401); }
    if (request.signal.aborted) return failure(408);
    try {
      const result = packet.operation === 'prepare' ? await owners.prepare(session, packet)
        : packet.operation === 'reopen' ? await owners.reopen(session, packet.actionId)
          : packet.operation === 'confirm' ? await owners.confirm(session, packet.confirmation)
            : await owners.discard(session, packet.confirmation);
      // Strict validation refuses accidental private fields, rather than forwarding a server object.
      return Response.json(PublicResult.parse(result), { status: 200, headers });
    } catch { return failure(503); }
  };
}
