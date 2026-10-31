/**
 * 72b100cd (r328) — THE PCB 2(II) RESPONSE, GATE AND ALL, WRITTEN ONCE.
 *
 * r323 shipped `download/route.ts`. r328 added `preview/route.ts` beside it, and the only difference
 * between the two is ONE header value — `attachment` or `inline`. Everything else has to be identical or
 * the preview is a second, weaker door onto the same tax numbers and identity card numbers.
 *
 * ⚠️ SO THE GATE LIVES HERE, NOT IN EITHER ROUTE. A preview that re-implemented `scopedAdmin`, the UUID
 * shape test, the selection ceiling, the scope check and the lang allowlist would be two copies of one
 * access decision, and the copy that drifts is the one nobody looks at again. Both routes are four lines
 * long for exactly that reason: there is nothing in either of them that COULD drift.
 *
 * GATED LIKE THE EA BATCH BESIDE IT, AND FOR THE SAME REASON. `scopedAdmin` rather than `isAdmin`: an
 * hr_admin grant on ANY company makes `isAdmin` true, and this response carries many named people's tax
 * numbers, identity card numbers and a year of tax deductions. A malformed id, a foreign company, an
 * out-of-scope company and an employment with no statement are ALL the same bare 404, so the URL cannot
 * be used to enumerate any of them.
 *
 * ⚠️ A PREVIEW IS NOT A LIGHTER SURFACE. It renders the SAME bytes the download does — the same figures,
 * the same names, the same identity card numbers — so it is refused in exactly the same places. The only
 * thing `inline` changes is whether the browser opens the file or saves it.
 *
 * ONE RENDERER, ONE READ, AND NEITHER LIVES HERE. `renderPcb2iiPdf` over `employeePcb2iiStatement` — this
 * module concatenates their output and does not lay out, total or translate a single box of its own. A
 * second PCB 2(II) renderer is two versions of one statutory form that drift, which is what lib/ea-pdf.ts
 * refuses in as many words and what this file refuses by having nothing to drift. That is also why the
 * preview is this PDF served inline and NOT an HTML rendition of the form: an HTML preview would be the
 * second renderer, and the operator would be checking a document that is not the one they send.
 *
 * ⚠️ IT REFUSES A PARTIAL ANSWER RATHER THAN QUIETLY SHIPPING ONE. If any requested employment has no
 * statement for the year, the whole request 404s instead of returning a file silently short of the people
 * who were ticked — nothing on the page it produces would say who is missing from it. The picker only
 * offers the year's actual population, so this is the hand-edited-URL path, not the ordinary one.
 *
 * ⚠️ `lang` IS ALLOWLISTED A SECOND TIME (the screen allowlists it first). LHDN publishes this form in
 * English and Bahasa Malaysia and the two differ by more than translation — the English sheet heads a
 * column MTD where the Malay one heads it PCB. Which was asked for must not become "whatever the screen
 * was set to", and an unknown value falls back to English rather than being handed on.
 *
 * NO DOMAIN EVENT: rendering a statement is a read, and neither of these routes is a filing.
 */
import { PDFDocument } from 'pdf-lib';
import { scopedAdmin } from '@/lib/scope';
import { employeePcb2iiStatement } from '@/core/reporting';
import { listCompanies } from '@/core/read';
import { renderPcb2iiPdf } from '@/lib/pcb2ii-pdf';
import { Pcb2iiPreparationError, validPcb2iiSelectedDate, type Pcb2iiForm } from '@/lib/pcb2ii-form';
import type { Pcb2iiLang } from '@/lib/pcb2ii-labels';
// The ceiling, shared with the picker so the number the screen advertises is the number enforced here.
import { MAX_EA_SELECTION } from '../ea/limits';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR = /^\d{4}$/;
const LANGS = ['en', 'ms'] as const;

const notFound = () => new Response('Not found', { status: 404 });

/** `attachment` saves the file; `inline` opens it in the browser's own PDF viewer. Nothing else differs. */
export type Pcb2iiDisposition = 'attachment' | 'inline';

/**
 * The ticked employees' PCB 2(II) statements, concatenated into ONE PDF.
 *
 * One id or two hundred is one file: the ids are de-duplicated (the same person ticked twice — only
 * reachable by hand-editing the URL — is one copy, not two) and looped into a single `PDFDocument`.
 */
export async function pcb2iiPdfResponse(req: Request, disposition: Pcb2iiDisposition): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const companyId = q.get('companyId') ?? '';
  const year = q.get('year') ?? '';
  const ids = q.getAll('id');
  // Shape first, before any query: a malformed id never reaches the database.
  if (!UUID.test(companyId) || !YEAR.test(year)) return notFound();
  if (ids.length === 0 || ids.length > MAX_EA_SELECTION || !ids.every((id) => UUID.test(id))) return notFound();
  const unique = [...new Set(ids)];

  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(companyId)) return notFound();

  const langParam = q.get('lang');
  const lang: Pcb2iiLang = LANGS.includes(langParam as Pcb2iiLang) ? (langParam as Pcb2iiLang) : 'en';

  const selectedDate = q.get('selectedDate') ?? '';
  const preparationRefusal = (code: Pcb2iiPreparationError['code'], field?: string) => {
    const back = new URL('/payroll/statutory-forms/pcb2ii', req.url);
    back.searchParams.set('companyId', companyId);
    back.searchParams.set('year', year);
    back.searchParams.set('lang', lang);
    if (validPcb2iiSelectedDate(selectedDate)) back.searchParams.set('selectedDate', selectedDate);
    back.searchParams.set('error', code);
    if (field) back.searchParams.set('field', field);
    // r402: the viewer follows this refusal at the top level (no new tab any more), so the picker must come
    // back with the same people ticked; it pre-ticks `id`s, filtered to that year's population.
    for (const id of unique) back.searchParams.append('id', id);
    return new Response(null, {
      status: 303,
      headers: { Location: back.toString(), 'Cache-Control': 'private, no-store' },
    });
  };

  const companies = await listCompanies(s);
  const employerName = companies.find((c) => c.id === companyId)?.name ?? 'company';

  // Each assembler resolves subject/employer ownership before any typed preparation error.
  // A later unauthorized ID wins a generic 404 even if an earlier visible field cannot be prepared.
  const forms: Pcb2iiForm[] = [];
  let preparationError: Pcb2iiPreparationError | null = null;
  for (const employmentId of unique) {
    try {
      const form = await employeePcb2iiStatement(s, { employmentId, year, companyId, selectedDate });
      if (!form) return notFound();
      forms.push(form);
    } catch (error) {
      if (!(error instanceof Pcb2iiPreparationError)) throw error;
      preparationError ??= error;
    }
  }
  if (preparationError) return preparationRefusal(preparationError.code, preparationError.field);

  const out = await PDFDocument.create();
  try {
    for (const form of forms) {
      const bytes = await renderPcb2iiPdf(form, lang);
      const src = await PDFDocument.load(bytes);
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
    }
  } catch (error) {
    if (error instanceof Pcb2iiPreparationError) return preparationRefusal(error.code, error.field);
    throw error;
  }

  // ASCII-only, because Content-Disposition's plain `filename` is Latin-1.
  const slug = employerName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'company';
  const fname = `pcb2ii-${year}-${slug}-${lang}.pdf`;
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
