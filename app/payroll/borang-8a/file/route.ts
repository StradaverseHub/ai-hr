/**
 * 18c1d92b — THE PERKESO ASSIST PORTAL UPLOAD FILE for combined SOCSO + EIS.
 *
 * A ROUTE HANDLER, NOT A GUARDED PAGE (the sibling `../text` and the KWSP `borang-a/file` are the
 * precedents this follows): a `route.ts` has no screen column in the function-access matrix and needs
 * none. The one guarded PAGE this feature touches is `../preview`, which is already registered.
 *
 * ⚠️ NOT THE SAME THING AS `../text`. That route writes the Borang 8A out for a human to read while
 * keying into the portal by hand — Malay headings, sheet columns, page totals. THIS is the machine
 * format: 278 characters per employee, one record each, no separators, every field at a fixed position.
 * Both are built from the same `Borang8AForm`, so they cannot disagree about who is on the return, but
 * only one of them is uploadable and they are deliberately three separate buttons.
 *
 * EVERY REFUSAL IS BEFORE THE DOWNLOAD, NEVER AFTER IT — see `loadBorang8AFile`.
 *
 * ASCII, and the charset says so. Every character is inside 0x20-0x7E by construction, and a fixed-width
 * record read as anything else would shift every field after the first non-ASCII byte.
 */
import { perkesoFileReport } from '@/lib/perkeso-socso-file';
import { loadBorang8AFile } from '../shared';

export const runtime = 'nodejs';

/** `perkeso-socso-<employer code>-<MMYYYY>.txt` — distinct from the readable export's name. */
function uploadFilename(employerCode: string, contributionPeriodKey: string): string {
  const code = (employerCode || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  return `perkeso-socso-${code}-${contributionPeriodKey.replace('-', '')}.txt`;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadBorang8AFile({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) return new Response(loaded.message, { status: loaded.status });

  // 18c1d92b — `?report=1` returns the field-by-field check INSTEAD of the file, which is what the plan
  // promised the reporter: something to read BEFORE downloading. Deliberately the same route and the
  // same load, so the report can only ever describe the bytes this route would hand over — a separate
  // endpoint could drift from it and then reassure somebody about a file they did not get. Rendered
  // inline (no attachment header) so it opens in the browser rather than landing in Downloads.
  if (q.get('report') === '1') {
    return new Response(perkesoFileReport(loaded.text), {
      headers: { 'Content-Type': 'text/plain; charset=us-ascii', 'Cache-Control': 'private, no-store' },
    });
  }

  return new Response(loaded.text, {
    headers: {
      'Content-Type': 'text/plain; charset=us-ascii',
      'Content-Disposition': `attachment; filename="${uploadFilename(loaded.form.employerCode, loaded.form.contributionPeriodKey)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
