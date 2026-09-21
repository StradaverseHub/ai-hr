/**
 * 72b100cd (r323) — PCB 2(II) for the people who were TICKED, as one PDF.
 *
 * THE THIRD AND LAST STEP: choose the form, choose company and year, choose the people, generate.
 * Everything before this point renders lists; this is the only place in the flow that produces a
 * document, and it produces one only when it is asked to.
 *
 * ONE RENDERER, ONE READ, AND NEITHER LIVES HERE. `renderPcb2iiPdf` over `employeePcb2iiStatement` — this
 * route concatenates their output and does not lay out, total or translate a single box of its own. A
 * second PCB 2(II) renderer is two versions of one statutory form that drift, which is what lib/ea-pdf.ts
 * refuses in as many words and what this file refuses by having nothing to drift.
 *
 * GATED LIKE THE EA BATCH BESIDE IT, AND FOR THE SAME REASON. `scopedAdmin` rather than `isAdmin`: an
 * hr_admin grant on ANY company makes `isAdmin` true, and this response carries many named people's tax
 * numbers, identity card numbers and a year of tax deductions. A malformed id, a foreign company, an
 * out-of-scope company and an employment with no statement are ALL the same bare 404, so the URL cannot
 * be used to enumerate any of them.
 *
 * ⚠️ IT REFUSES A PARTIAL ANSWER RATHER THAN QUIETLY SHIPPING ONE. If any requested employment has no
 * statement for the year, the whole request 404s instead of returning a file silently short of the people
 * who were ticked — nothing on the page it produces would say who is missing from it. The picker only
 * offers the year's actual population, so this is the hand-edited-URL path, not the ordinary one.
 *
 * ⚠️ `lang` IS ALLOWLISTED A SECOND TIME. LHDN publishes this form in English and Bahasa Malaysia and the
 * two differ by more than translation — the English sheet heads a column MTD where the Malay one heads it
 * PCB. Which was asked for must not become "whatever the screen was set to", and an unknown value falls
 * back to English rather than being handed on.
 *
 * NO DOMAIN EVENT: rendering a statement is a read, and this download is explicitly not a filing.
 */
import { PDFDocument } from 'pdf-lib';
import { scopedAdmin } from '@/lib/scope';
import { employeePcb2iiStatement } from '@/core/reporting';
import { listCompanies } from '@/core/read';
import { renderPcb2iiPdf } from '@/lib/pcb2ii-pdf';
import type { Pcb2iiLang } from '@/lib/pcb2ii-labels';
// The ceiling, shared with the picker so the number the screen advertises is the number enforced here.
import { MAX_EA_SELECTION } from '../../ea/limits';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR = /^\d{4}$/;
const LANGS = ['en', 'ms'] as const;

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

  const langParam = q.get('lang');
  const lang: Pcb2iiLang = LANGS.includes(langParam as Pcb2iiLang) ? (langParam as Pcb2iiLang) : 'en';

  const companies = await listCompanies(s);
  const employerName = companies.find((c) => c.id === companyId)?.name ?? 'company';

  const out = await PDFDocument.create();
  for (const employmentId of unique) {
    // RLS-gated, and pinned to THIS company: after an Entity Transfer a year can span two employers, and
    // a statement of what THIS employer deducted must not carry another employer's months.
    const form = await employeePcb2iiStatement(s, { employmentId, year, companyId });
    if (!form) return notFound();
    const bytes = await renderPcb2iiPdf(form, lang);
    const src = await PDFDocument.load(bytes);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }

  // ASCII-only, because Content-Disposition's plain `filename` is Latin-1.
  const slug = employerName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'company';
  const fname = `pcb2ii-${year}-${slug}-${lang}.pdf`;
  return new Response(Buffer.from(await out.save()), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
