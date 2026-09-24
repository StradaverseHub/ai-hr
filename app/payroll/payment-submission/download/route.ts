/**
 * 20f6c6a8 — ONE DOWNLOAD ROUTE FOR EVERY SUBMISSION FORMAT, dispatched through the registry.
 *
 * A ROUTE HANDLER, NOT A GUARDED PAGE (the sibling `borang-a/file` and `borang-8a/file` are the
 * precedents): a `route.ts` has no screen column in the function-access matrix and needs none. The one
 * guarded PAGE this feature adds is `../page.tsx`, and that one IS registered in lib/permissions.ts.
 *
 * ⚠️ IT DOES NOT BRANCH ON AUTHORITY, AND THAT IS THE WHOLE TEST OF THE SEAM. There is no `if (format.id
 * === …)` and no switch on `authority` below — the route resolves an id against `SUBMISSION_FORMATS`,
 * calls whatever `build` that entry declares, and returns the bytes. Adding the next format is adding an
 * entry to the registry; this file does not reopen. `app/payroll/statutory-forms/[formId]/page.tsx`
 * carries four literal `formId === …` branches and is the thing this design is reacting to.
 *
 * AN UNKNOWN id 404s. `format` comes from the URL, so it is attacker-controlled; `submissionFormat`
 * resolves it against the registry and anything unrecognised gets the same bare 404 as an out-of-scope
 * company, so the parameter cannot be used to enumerate what exists.
 *
 * AN UNAVAILABLE FORMAT CANNOT BE DOWNLOADED, AND NOT BECAUSE THIS FILE REMEMBERS TO CHECK. The
 * descriptor is a discriminated union: when `available` is false there is no `build` property to call, so
 * the narrowing below is what TypeScript requires rather than a courtesy. Hiding a button on the screen
 * would not be enough on its own — a bookmarked URL does not read the screen.
 *
 * EVERY REFUSAL IS BEFORE THE DOWNLOAD, NEVER AFTER IT. Each builder applies its format's own gates
 * (readiness, then the writer's fixed-width refusals, then the writer's self-check on the emitted bytes)
 * and returns a 422 with the operator's own words. Nothing partial is ever handed over.
 *
 * NOTHING IS TRANSMITTED AND NOTHING IS RECORDED. This module generates a file and hands it to the
 * operator; it files nothing with anybody, and it writes no `statutory_report` row and no domain event —
 * see the registry header for why, and for how that differs from the two `/payroll/reports/*` file routes.
 */
import { submissionFormat } from '../registry';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const format = submissionFormat(q.get('format') ?? '');
  // Unknown id, and "declared but not available", answer the same 404: the URL must not distinguish a
  // format that does not exist from one that exists and has no builder yet.
  if (!format || !format.available) return new Response('Not found', { status: 404 });

  const built = await format.build({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    // Passed through WHOLE rather than picked apart here. A format's per-generation inputs are its own
    // business (Borang A reads `epfPeriod`, `code`, `control` and `batch` off this); a route that listed
    // them would have to be edited every time a format gained one.
    query: q,
  });

  if (!built.ok) return new Response(built.message, { status: built.status });

  return new Response(built.bytes, {
    headers: {
      'Content-Type': built.contentType,
      'Content-Disposition': `attachment; filename="${built.filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
