/**
 * r256 (item 858a1128) — the C.P.8A (EA) for the people who were TICKED, as one PDF.
 *
 * THE THIRD AND LAST STEP of the EA flow the reporter asked for: choose the form, choose company and year,
 * choose the people, generate. Everything before this point renders lists; this is the only place in the
 * flow that produces a document, and it produces one only when it is asked to.
 *
 * ONE RENDERER, AND IT IS THE ONE THE EMPLOYEE'S OWN DOWNLOAD USES. `renderEaPdf` + `eaPdfLabels` are
 * `app/me/ea/[employmentId]/pdf`'s exact pair, over `employeeEaStatement`'s exact read — this route
 * concatenates their output and does not lay out, total or translate a single box of its own. A second EA
 * renderer is two versions of one statutory form that drift, which is what lib/ea-pdf.ts's own header
 * refuses in as many words.
 *
 * GATED LIKE THE CP22 BATCH BESIDE IT, AND FOR THE SAME REASON. `scopedAdmin` rather than `isAdmin`: an
 * hr_admin grant on ANY company makes `isAdmin` true, and this response carries many named people's pay,
 * EPF, SOCSO and tax figures for a whole year. A malformed id, a foreign company, an out-of-scope company
 * and an employment with no statement are ALL the same bare 404, so the URL cannot be used to enumerate
 * any of them.
 *
 * ⚠️ IT REFUSES A PARTIAL ANSWER RATHER THAN QUIETLY SHIPPING ONE. If any requested employment has no
 * statement for the year, the whole request 404s instead of returning a file that is silently short of
 * the people who were ticked. A merged tax document missing two of the ten people asked for is worse than
 * no document: nothing on the page it produces says who is not in it (AGENTS 28). The picker only offers
 * the year's actual population, so this is the hand-edited-URL path, not the ordinary one.
 *
 * NO DOMAIN EVENT, for the reason the per-employee route gives: rendering a statement is a read, and this
 * download is explicitly not a filing.
 */
import { getLocale } from 'next-intl/server';
import { PDFDocument } from 'pdf-lib';
import { scopedAdmin } from '@/lib/scope';
import { employeeEaStatement } from '@/core/reporting';
import { listCompanies } from '@/core/read';
import { renderEaPdf, type EaPdfData, type EaPdfLabels } from '@/lib/ea-pdf';
import { eaPdfLabels } from '@/lib/ea-pdf-labels';
// The ceiling, shared with the picker so the number the screen advertises is the number enforced here.
// See ../limits.ts for why it is 200 and not the 500 this route first claimed — above ~405 ids the GET
// never reached this code at all, it was refused by the HTTP layer with a bare 431.
import { MAX_EA_SELECTION } from '../limits';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR = /^\d{4}$/;
const EA_LANGS = ['en', 'ms'] as const;
type EaLang = (typeof EA_LANGS)[number];

const notFound = () => new Response('Not found', { status: 404 });

export async function GET(req: Request) {
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
      statutoryVersion: ea.statutoryVersion,
      // 1.2.6 EA Data Overwrite — HR's EA-only amendments, so the PDF prints the "Amended" footnote.
      overrides: ea.overrides,
    };
    const bytes = await renderEaPdf(data, await labelsFor(ea.year, ea.statutoryVersion));
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
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
