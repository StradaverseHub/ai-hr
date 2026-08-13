/**
 * 3aae0789 — THE KWSP BORANG A UPLOAD FILE, for i-Akaun (Employer).
 *
 * A ROUTE HANDLER, NOT A GUARDED PAGE (r191's CP22 text download is the precedent this follows): a
 * `route.ts` has no screen column in the function-access matrix and needs none. The one guarded PAGE this
 * feature adds is `../preview`, and that one IS registered in lib/permissions.ts.
 *
 * ⚠️ NOT THE SAME THING AS `../text`. That route writes the form out for a human to read while keying by
 * hand. THIS is the machine format: 129 characters per line, CRLF, records 00 / 01 / 02… / 99, every
 * field at a fixed offset. Both are built from the same rows, so they cannot disagree about who is on the
 * return, but only one of them is uploadable and they are deliberately two separate buttons.
 *
 * EVERY REFUSAL IS BEFORE THE DOWNLOAD, NEVER AFTER IT. `loadBorangAFile` applies the paper form's gate,
 * then the file's own stricter one (a member number that is not digits, an identity card number that is
 * not twelve digits, an employer reference that is not numeric), then the builder's self-check on the
 * emitted bytes: header totals == trailer totals == the sum over the 02 records. A file that does not add
 * up is never offered — it is rejected at the portal, which is a slower way to learn the same fact.
 *
 * ASCII, and the charset says so. Every character in the file is inside 0x20-0x7E by construction, and a
 * fixed-width record read as anything else would shift every field after the first non-ASCII byte.
 */
import { loadBorangAFile } from '../shared';

export const runtime = 'nodejs';

/** `kwsp-borang-a-<employer ref>-<contribution period>.txt` — distinct from the readable export's name. */
function uploadFilename(employerRef: string, contributionPeriodKey: string): string {
  const ref = (employerRef || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  return `kwsp-borang-a-${ref}-${contributionPeriodKey.replace('-', '')}.txt`;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadBorangAFile({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) return new Response(loaded.message, { status: loaded.status });

  return new Response(loaded.text, {
    headers: {
      'Content-Type': 'text/plain; charset=us-ascii',
      'Content-Disposition': `attachment; filename="${uploadFilename(loaded.form.employerRef, loaded.form.contributionPeriodKey)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
