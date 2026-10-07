/**
 * 8ca344bf — the Borang 8A itself, as a PDF: the drawn schedule, paginated, with the header repeated and a
 * "Jumlah muka surat ini" on every sheet.
 *
 * A ROUTE HANDLER, NOT A GUARDED PAGE — deliberately, and the r191 CP22 downloads are the precedent
 * (app/payroll/cp22/[employmentId]/pdf|text). A `route.ts` has no screen column in the function-access
 * matrix and needs none; only `page.tsx` files are enumerated there. The one guarded PAGE this feature
 * adds is `../preview`, and that one IS registered (lib/permissions.ts).
 *
 * EVERY DECISION LIVES IN `../shared.ts`. Scope, period validation, generation, the readiness gate and the
 * typed-status merge are shared with the review screen and with the text route beside this one, so the
 * document that downloads cannot differ from the document that was reviewed.
 *
 * NO DOMAIN EVENT. Rendering a form is a READ, and this download is explicitly not a filing — the same
 * deliberate skip the EA, payslip and CP22 routes make. "Record generation" on the [formId] screen remains
 * the one deliberate act that writes an artefact.
 */
import { renderBorang8APdf, borang8AFilename } from '@/lib/borang-8a-pdf';
import { NO_CONTRIBUTIONS, describeGaps, loadBorang8A } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadBorang8A({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) {
    // A bad company, a bad period and a form this jurisdiction does not have are ONE answer, so the URL
    // cannot enumerate any of them. The two operational refusals say what is wrong, because they are
    // things the operator can fix and they are reached from a screen that already told them so.
    if (loaded.reason === 'not-found') return new Response('Not found', { status: 404 });
    if (loaded.reason === 'no-batch') {
      return new Response('No payroll run for this month — run payroll first.', { status: 422 });
    }
    // r372 (item f022dd70) — TWO MORE REFUSALS, BOTH ABOUT THE PAYROLL-CYCLE SELECTION ON THE LINK.
    // r408: the review screen DOES send run parameters now (it carries the criteria step's selection), and
    // its Continue gate refuses an empty selection before any link is drawn — so these answer a hand-edited
    // or stale link. A route is not a screen, and such a link must not fall through to "somebody is
    // missing a number".
    if (loaded.reason === 'selection-empty') {
      return new Response('No payroll run for this month matches the payroll cycles you selected.', {
        status: 422,
      });
    }
    if (loaded.reason === 'bad-selection') return new Response(loaded.message, { status: 422 });
    if (loaded.reason === 'no-contributions') return new Response(NO_CONTRIBUTIONS, { status: 422 });
    // Both kinds of gap, named, THROUGH THE ONE HELPER (r372). An employer-level gap (no SOCSO employer
    // code) gaps every page at once and is fixed in one place; a per-employee gap is fixed on that
    // person's record, and the reason is the pack's own — this route does not guess which one it was.
    return new Response(`Cannot produce Borang 8A: ${describeGaps(loaded)}.`, { status: 422 });
  }

  const pdf = await renderBorang8APdf(loaded.form);
  // r408 (item e74af58c) — THE PREVIEW IS THIS ROUTE, ASKED TO SHOW RATHER THAN SAVE. The in-app viewer
  // frames `?…&disposition=inline`: the same loader, the same gate, the same renderer, the same bytes —
  // only the header differs, so the form on screen IS the file Download saves. Any other value saves.
  const disposition = q.get('disposition') === 'inline' ? 'inline' : 'attachment';
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${borang8AFilename(loaded.form, 'pdf')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
