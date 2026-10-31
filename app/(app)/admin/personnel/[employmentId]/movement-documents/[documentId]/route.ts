/**
 * 1d58019a Step 2 (ADR-0166) — download one supporting document of a movement.
 *
 * The authorization is the service's, not this route's: readMovementAttachment requires an admin with
 * workforce view of this employee, a document of a movement this employee's Employment History shows, and
 * (through the table's read policy) pay access for a document filed against a pay field. Every refusal is a
 * 404, so a probe cannot tell "does not exist" from "not yours". Read-only: no event is appended.
 *
 * Same response hardening as the profile-attachment download (app/(app)/me/profile-attachments/[id]/route.ts):
 * attachment disposition with an RFC 5987 file name, private no-store caching and nosniff.
 */
import { requireAdmin } from '@/lib/authz';
import { MovementDocumentError, readMovementAttachment } from '@/core/movement';
import { WorkforceAccessError } from '@/core/workforce-access';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ employmentId: string; documentId: string }> },
) {
  const s = await requireAdmin();
  const { employmentId, documentId } = await params;
  if (!UUID_RE.test(employmentId) || !UUID_RE.test(documentId)) return new Response(null, { status: 404 });
  try {
    const file = await readMovementAttachment(s, employmentId, documentId);
    return new Response(new Uint8Array(file.content), {
      headers: {
        'Content-Type': file.mimeType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof MovementDocumentError || error instanceof WorkforceAccessError) {
      return new Response(null, { status: 404 });
    }
    throw error;
  }
}
