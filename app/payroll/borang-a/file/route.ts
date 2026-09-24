/**
 * cc74dcb2 / 3aae0789 — THE KWSP BORANG A UPLOAD FILE, for i-Akaun (Employer).
 *
 * A ROUTE HANDLER, NOT A GUARDED PAGE (r191's CP22 text download is the precedent this follows): a
 * `route.ts` has no screen column in the function-access matrix and needs none. The one guarded PAGE this
 * feature adds is `../preview`, and that one IS registered in lib/permissions.ts.
 *
 * ⚠️ NOT THE SAME THING AS `../text`. That route writes the form out for a human to read while keying by
 * hand. THIS is the machine format: 129 characters per line, CRLF, records 00 / 01 / 02… / 99, every
 * field at a fixed offset. Both are built from the same rows, so they cannot disagree about who is on the
 * return, but only one of them is uploadable and they are deliberately two separate buttons with two
 * names that cannot be confused.
 *
 * ONE ROUTE, TWO RENDERINGS, AND DELIBERATELY NOT TWO ROUTES. `?report=1` returns the FIELD-BY-FIELD
 * CHECK over the very same emitted characters instead of the file: every line's length, and every field
 * with its columns, its length and its value. A second route would have to build the file a second time
 * and could describe a different one; here the report is a pure function of the bytes this request just
 * produced, so it cannot describe a file nobody downloaded.
 *
 * EVERY REFUSAL IS BEFORE THE DOWNLOAD, NEVER AFTER IT. `loadBorangAFile` applies the paper form's gate,
 * then the file's own stricter one (a member number that is not digits, an identity card number that is
 * not twelve digits, an employer reference that is not numeric), then the builder's self-check on the
 * emitted bytes: for both contribution columns, header total == trailer total == the sum over the 02
 * records. A file that does not add up is never offered — it is rejected at the portal, which is a slower
 * way to learn the same fact. The report is subject to all three, because it is made FROM the file.
 *
 * ASCII, and the charset says so. Every character in the file is inside 0x20-0x7E by construction, and a
 * fixed-width record read as anything else would shift every field after the first non-ASCII byte. The
 * report is ASCII for the same reason it describes: a document about byte positions should not contain a
 * character whose byte count is arguable.
 */
import { borangAFileReport } from '@/lib/kwsp-borang-a-file';
import { borangAUploadFilename, loadBorangAFile } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const report = (q.get('report') ?? '') !== '';
  const loaded = await loadBorangAFile({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) return new Response(loaded.message, { status: loaded.status });

  return new Response(report ? borangAFileReport(loaded.text) : loaded.text, {
    headers: {
      'Content-Type': 'text/plain; charset=us-ascii',
      // The report is shown, the file is saved: a check you have to open a downloads folder to read is a
      // check nobody performs, and a file the browser renders instead of saving is not an upload.
      'Content-Disposition': `${report ? 'inline' : 'attachment'}; filename="${borangAUploadFilename(loaded.form.employerRef, loaded.form.contributionPeriodKey, report)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
