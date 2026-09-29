import { getSession } from '@/lib/session';
import { inlineDisposition } from '@/lib/attachment-response';
import { getAttendanceCorrectionAttachment } from '@/packs/attendance/service';

/**
 * 2166ef79 — stream the supporting file on an attendance request. Verbatim reuse of
 * app/me/leave/attachment/[id]/route.ts, retargeted: `id` is the attendance_correction id, and
 * getAttendanceCorrectionAttachment runs under RLS (subject + manager + admin, via can_see_employment on
 * the denormalised employment_id).
 *
 * NO PAGE GUARD, and that is the design rather than an omission: the RLS policy IS the gate. A guard here
 * would have to re-answer "may this person see this employee's file", which the policy already answers
 * once, for every reader, including the approver looking at it from their inbox. A file the caller may not
 * see simply does not come back, and the route answers 404 — never "forbidden", which would confirm it
 * exists.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  const att = await getAttendanceCorrectionAttachment(s, id);
  if (!att) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  const disposition = inlineDisposition(req, att.mimeType);
  const bytes = new Uint8Array(att.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': att.mimeType || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${disposition}; filename="${safe(att.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
    },
  });
}
