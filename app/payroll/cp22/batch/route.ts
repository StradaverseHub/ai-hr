/**
 * db46d9a2 — every CP22 (Pin. 1/2020) for ONE company and ONE calendar month, as a single fillable PDF:
 * one page per joiner, in the order the Statutory Forms screen lists them, every box still editable.
 *
 * WHAT THIS IS NOT. It is not a filing. Since 1 September 2024 a CP22 must go through the e-CP22 service
 * on MyTax; posted and hand-delivered forms are not accepted. The document produced here is what an
 * operator keys into MyTax, gathered and checked in one place, plus their own signed internal record — the
 * screen says exactly that beside the button, and no label anywhere calls it a submission.
 *
 * SIBLING OF `blank/` AND `[employmentId]/pdf/`, and gated the way the per-joiner route documents:
 * `scopedAdmin` rather than `isAdmin`, because an hr_admin grant on ANY company makes `isAdmin` true and
 * this response carries MANY named people's IC, passport, tax number, home address and salary — the most
 * concentrated payload of that kind the app produces. It fails closed three times over, and a malformed
 * id, a foreign company, an out-of-scope company, a non-Malaysian company and a month with nobody in it
 * are ALL the same bare 404, so the URL cannot be used to enumerate any of them.
 *
 * `batch` is not a UUID, so it cannot collide with the sibling `[employmentId]/pdf` route.
 *
 * NO DOMAIN EVENT, for the reason the per-joiner route gives: rendering a form is a read, and this download
 * is explicitly not a filing. "I filed the CP22" stays a separate, deliberate act that happens in MyTax.
 */
import { scopedAdmin } from '@/lib/scope';
import { cp22MonthCohort, cp22Particulars } from '@/core/reporting';
import { renderCp22Batch, type Cp22PdfData } from '@/lib/cp22-pdf';
import { readCp22Template } from '@/lib/cp22-template';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The SAME shapes app/payroll/statutory-forms/page.tsx validates its two selects against. */
const YEAR = /^\d{4}$/;
const MONTH = /^(0[1-9]|1[0-2])$/;
/**
 * The branch line is operator-typed and lands in a four-row block on every page. The cap is a request-size
 * guard, not a formatting one: the renderer folds and shrinks anything longer so no line is ever lost.
 */
const BRANCH_MAX = 240;

const notFound = () => new Response('Not found', { status: 404 });

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const companyId = q.get('companyId') ?? '';
  const year = q.get('year') ?? '';
  const month = q.get('month') ?? '';
  // Shape first, before any query: a malformed id never reaches the database.
  if (!UUID.test(companyId) || !YEAR.test(year) || !MONTH.test(month)) return notFound();

  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(companyId)) return notFound();

  // Null for a non-Malaysian company and for a company this session cannot see; empty for a month in
  // which nobody started. An empty month is a 404 rather than a zero-page PDF — the screen offers no
  // button in that case, so reaching this line means the URL was hand-edited or bookmarked.
  const cohort = await cp22MonthCohort(s, { companyId, periodKey: `${year}-${month}` });
  if (!cohort || cohort.rows.length === 0) return notFound();

  // ONE field-mapping code path. Calling `cp22Particulars` per row costs N reads, and at the tenant's
  // current size (40 employments across 9 companies) that is nothing next to keeping a second, drifting
  // copy of the mapping that fills 26 boxes from six tables.
  const records: Cp22PdfData[] = [];
  for (const row of cohort.rows) {
    const p = await cp22Particulars(s, { employmentId: row.employmentId });
    // RLS already produced this row, so a null here would mean the employment vanished mid-request. Skip
    // it rather than fail the whole download: the remaining joiners' pages are still correct.
    if (p) records.push(p);
  }
  if (records.length === 0) return notFound();

  const branch = (q.get('lhdnBranch') ?? '').slice(0, BRANCH_MAX).trim();
  const bytes = await renderCp22Batch(readCp22Template(), records, { lhdnBranch: branch || null });

  const slug = records[0].employer.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="cp22-${slug}-${year}-${month}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
