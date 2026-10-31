/**
 * r413 (item 79f3f64d, step 2) — the event-selection screen's Continue: one chosen person → that form's
 * own preview.
 *
 * A route handler and not client navigation, so Continue works as a plain GET form (no script) and the
 * destination is the CATALOG's (`event.previewPath`), never a path the request supplies. It produces
 * nothing and reads no person: the preview it redirects to runs its own gate (scopedAdmin, the company
 * scope, RLS) on the id. A form id this admin's scope does not reach, or an entry that is not a form about
 * one person, is a bare 404. Nobody chosen → back to the screen, the company and search kept, with the
 * refusal said in words — no blank form is produced.
 */
import { redirect } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import { listStatutoryCatalog } from '@/core/reporting';
import { UUID, eventLinkOf, eventPreviewHref, eventReturnHref } from '../shared';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const formId = q.get('form') ?? '';
  const { s, scopeIds } = await scopedAdmin();
  const catalog = await listStatutoryCatalog(s, scopeIds);
  const link = eventLinkOf(catalog.links, formId);
  if (!link) return new Response('Not found', { status: 404 });

  const employmentId = q.get('employmentId') ?? '';
  if (!UUID.test(employmentId)) {
    const companyId = q.get('companyId') ?? '';
    redirect(
      eventReturnHref({
        formId,
        companyId: scopeIds.includes(companyId) ? companyId : undefined,
        q: (q.get('q') ?? '').slice(0, 100) || undefined,
        refusal: 'none_selected',
      }),
    );
  }
  redirect(eventPreviewHref(link.event.previewPath, employmentId));
}
