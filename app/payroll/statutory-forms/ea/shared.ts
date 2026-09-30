/**
 * 2a1a6f42 (r331) — THE C.P.8A (EA) RESPONSE, GATE AND ALL, WRITTEN ONCE.
 *
 * r256 shipped `download/route.ts`. r331 adds `preview/route.ts` beside it, and the only difference
 * between the two is ONE header value — `attachment` or `inline`. Everything else has to be identical or
 * the preview is a second, weaker door onto the same pay, EPF, SOCSO and tax figures.
 *
 * ⚠️ SO THE GATE LIVES HERE, NOT IN EITHER ROUTE. A preview that re-implemented `scopedAdmin`, the UUID
 * shape test, the selection ceiling, the scope check and the lang allowlist would be two copies of one
 * access decision, and the copy that drifts is the one nobody looks at again. Both routes are four lines
 * long for exactly that reason: there is nothing in either of them that COULD drift. This is the shape
 * `../pcb2ii/shared.ts` established for the other per-employee annual form on this shelf; the EA is the
 * form that had no preview at all, and it now takes the same one.
 *
 * ⚠️ NOTHING ABOUT THE DOWNLOAD'S BEHAVIOUR MOVED IN THIS ROUND. Every line below arrived here verbatim
 * from `download/route.ts` — the shape tests, the de-duplication, the scope check, the locale fallback,
 * the label cache, the filename slug. The download is the same response it was; it is simply no longer
 * the only caller.
 *
 * GATED LIKE THE CP22 BATCH BESIDE IT, AND FOR THE SAME REASON. `scopedAdmin` rather than `isAdmin`: an
 * hr_admin grant on ANY company makes `isAdmin` true, and this response carries many named people's pay,
 * EPF, SOCSO and tax figures for a whole year. A malformed id, a foreign company, an out-of-scope company
 * and an employment with no statement are ALL the same bare 404, so the URL cannot be used to enumerate
 * any of them.
 *
 * ⚠️ A PREVIEW IS NOT A LIGHTER SURFACE. It renders the SAME bytes the download does — the same figures,
 * the same names, the same identity card numbers — so it is refused in exactly the same places. The only
 * thing `inline` changes is whether the browser opens the file or saves it.
 *
 * ONE RENDERER, AND IT IS THE ONE THE EMPLOYEE'S OWN DOWNLOAD USES. `renderEaPdf` + `eaPdfLabels` are
 * `app/me/ea/[employmentId]/pdf`'s exact pair, over `employeeEaStatement`'s exact read — this module
 * concatenates their output and does not lay out, total or translate a single box of its own. A second EA
 * renderer is two versions of one statutory form that drift, which is what lib/ea-pdf.ts's own header
 * refuses in as many words. That is also why the preview is this PDF served inline and NOT an HTML
 * rendition of the form: an HTML preview would be the second renderer, and the operator would be checking
 * a document that is not the one they send.
 *
 * ⚠️ IT REFUSES A PARTIAL ANSWER RATHER THAN QUIETLY SHIPPING ONE. If any requested employment has no
 * statement for the year, the whole request 404s instead of returning a file that is silently short of
 * the people who were ticked. A merged tax document missing two of the ten people asked for is worse than
 * no document: nothing on the page it produces says who is not in it. The picker only offers the year's
 * actual population, so this is the hand-edited-URL path, not the ordinary one.
 *
 * NO DOMAIN EVENT, for the reason the per-employee route gives: rendering a statement is a read, and
 * neither of these routes is a filing.
 */
import { getLocale } from 'next-intl/server';
import { PDFDocument } from 'pdf-lib';
import { scopedAdmin } from '@/lib/scope';
import { employeeEaStatement } from '@/core/reporting';
import { listCompanies } from '@/core/read';
import { renderEaPdf, type EaPdfData, type EaPdfLabels } from '@/lib/ea-pdf';
import { eaPdfLabels } from '@/lib/ea-pdf-labels';
// The ceiling, shared with the picker so the number the screen advertises is the number enforced here.
// See ./limits.ts for why it is 200 and not the 500 this route first claimed — above ~405 ids the GET
// never reached this code at all, it was refused by the HTTP layer with a bare 431.
import { MAX_EA_SELECTION } from './limits';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR = /^\d{4}$/;
const EA_LANGS = ['en', 'ms'] as const;
type EaLang = (typeof EA_LANGS)[number];

const notFound = () => new Response('Not found', { status: 404 });

/** `attachment` saves the file; `inline` opens it in the browser's own PDF viewer. Nothing else differs. */
export type EaDisposition = 'attachment' | 'inline';

/**
 * The ticked employees' C.P.8A (EA) statements, concatenated into ONE PDF.
 *
 * One id or two hundred is one file: the ids are de-duplicated (the same person ticked twice — only
 * reachable by hand-editing the URL — is one copy, not two) and looped into a single `PDFDocument`.
 */
export async function eaPdfResponse(req: Request, disposition: EaDisposition): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const companyId = q.get('companyId') ?? '';
  const year = q.get('year') ?? '';
  const ids = q.getAll('id');
  // Shape first, before any query: a malformed id never reaches the database.
  if (!UUID.test(companyId) || !YEAR.test(year)) return notFound();
  if (ids.length === 0 || ids.length > MAX_EA_SELECTION || !ids.every((id) => UUID.test(id))) return notFound();
  // The same person ticked twice — only reachable by hand-editing the URL — is one copy, not two.
  const unique = [...new Set(ids)];

  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(companyId)) return notFound();

  // Allowlisted, never trusted: an unrecognised `lang` falls back to the request locale rather than being
  // handed to next-intl, which throws on an unknown locale and would 500 a download.
  const langParam = q.get('lang');
  const lang: EaLang | null = EA_LANGS.includes(langParam as EaLang) ? (langParam as EaLang) : null;
  const locale = lang ?? (await getLocale());

  const companies = await listCompanies(s);
  const employerName = companies.find((c) => c.id === companyId)?.name ?? 'company';

  // The label bundle depends on the locale, the year and the statutory version — identical for everybody
  // in one company-year in practice, so it is resolved once per distinct version rather than per person.
  const labelCache = new Map<string, EaPdfLabels>();
  const labelsFor = async (statementYear: string, version: string): Promise<EaPdfLabels> => {
    const key = `${statementYear}|${version}`;
    const hit = labelCache.get(key);
    if (hit) return hit;
    const built = await eaPdfLabels(locale, { year: statementYear, version });
    labelCache.set(key, built);
    return built;
  };

  const out = await PDFDocument.create();
  for (const employmentId of unique) {
    // RLS-gated, and pinned to THIS company: after an Entity Transfer a year can span two employers, and
    // handing over the wrong employer's statement is the failure the per-employee route refuses too.
    const ea = await employeeEaStatement(s, { employmentId, year, companyId });
    if (!ea) return notFound();
    const data: EaPdfData = {
      year: ea.year,
      employer: ea.employer,
      // 6036dab7 — spread, not field-by-field: `EaPdfData.employee` / `partB` are structural subsets of
      // the read's own shapes, so every required field is carried by the spread or refused by tsc.
      employee: ea.employee,
      partB: ea.partB,
      partC: ea.partC,
      partD: ea.partD,
      partE: ea.partE,
      // r367 — the foot's Tarikh. Computed by the MY pack's eaFormDate() so the renderer stays pure; see
      // EaPdfData.formDate in lib/ea-pdf.ts for whose rule it is.
      formDate: ea.formDate,
      statutoryVersion: ea.statutoryVersion,
      // 1.2.6 EA Data Overwrite — HR's EA-only amendments, so the PDF prints the "Amended" footnote.
      overrides: ea.overrides,
    };
    const bytes = await renderEaPdf(data, await labelsFor(ea.year, ea.statutoryVersion), { locale });
    const src = await PDFDocument.load(bytes);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }

  // ASCII-only, because Content-Disposition's plain `filename` is Latin-1. A legal name written entirely
  // in a non-Latin script would otherwise leave a filename that is all dashes, so it falls back to a word.
  const slug = employerName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'company';
  const fname = `ea-${year}-${slug}${lang ? `-${lang}` : ''}.pdf`;
  return new Response(Buffer.from(await out.save()), {
    headers: {
      'Content-Type': 'application/pdf',
      // The filename rides along on BOTH dispositions: `inline` still names the file the operator saves
      // out of the viewer, so a previewed form and a downloaded one land on disk under the same name.
      'Content-Disposition': `${disposition}; filename="${fname}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
