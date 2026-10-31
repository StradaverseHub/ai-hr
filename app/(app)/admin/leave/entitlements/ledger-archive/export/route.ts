/**
 * c8052ae3 — the Medical / Hospitalization balance record, as a CSV.
 *
 * The half of the plan's promise the listing cannot keep on its own: "a permanent written record you can
 * read on screen AND DOWNLOAD". 147 removed rows plus their recalculation history is checked in a
 * spreadsheet, not by scrolling a browser table — and the point of the record is that the figures can be
 * checked at all.
 *
 * Read-only: downloading changes nothing and appends no event (the same documented skip the configuration
 * record's export and the Leave Audit export take — a read is not a domain fact).
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { leaveLedgerResetArchiveCsv } from '@/packs/leave/service';

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  try {
    const capture = new URL(req.url).searchParams.get('capture') || undefined;
    const file = await leaveLedgerResetArchiveCsv(s, { captureTag: capture });
    return new Response(file.content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    });
  } catch (e) {
    console.error('leave ledger reset archive CSV generation failed', e);
    return new Response('Could not generate the balance record — please try again.', { status: 500 });
  }
}
