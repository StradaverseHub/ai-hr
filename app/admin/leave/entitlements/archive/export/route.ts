/**
 * 6e9a126e — the entitlement configuration record, as a CSV.
 *
 * The half of the plan's promise the listing cannot keep on its own: "you can open AND DOWNLOAD" it. HR
 * retypes 359 pieces of configuration from this, and doing that from a browser table across two screens is
 * how a figure gets lost.
 *
 * Read-only: downloading changes nothing and appends no event (the same documented skip the Leave Audit
 * export takes — a read is not a domain fact).
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { entitlementResetArchiveCsv } from '@/packs/leave/service';

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  try {
    const capture = new URL(req.url).searchParams.get('capture') || undefined;
    const file = await entitlementResetArchiveCsv(s, { captureTag: capture });
    return new Response(file.content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    });
  } catch (e) {
    console.error('entitlement reset archive CSV generation failed', e);
    return new Response('Could not generate the configuration record — please try again.', { status: 500 });
  }
}
