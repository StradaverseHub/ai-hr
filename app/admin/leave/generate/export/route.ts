/**
 * 93249794 — the processing log of one Generate Entitlement run, as a CSV.
 *
 * "Allow HR to download the processing log", from the request. A run reaches every selected employee for
 * every selected leave type, so the interesting half of it — WHO failed and WHY — is a table, not a
 * summary, and reading it off a browser page is how a line gets missed.
 *
 * Read-only: downloading changes nothing and appends no event (the same documented skip the Leave Audit
 * and entitlement-archive exports take — a read is not a domain fact).
 *
 * `isAdmin` before a single row is read, mirroring the sibling export routes. RLS scopes the rows to the
 * tenant underneath; this is the fail-fast layer in front of it.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { leaveGenerationRunCsv } from '@/core/leave-generation';

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  const runId = new URL(req.url).searchParams.get('run') ?? '';
  if (!runId) return new Response('Missing run id', { status: 400 });
  try {
    const file = await leaveGenerationRunCsv(s, { runId });
    return new Response(file.content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    });
  } catch (e) {
    console.error('leave generation log CSV generation failed', e);
    return new Response('Could not generate the processing log — please try again.', { status: 500 });
  }
}
