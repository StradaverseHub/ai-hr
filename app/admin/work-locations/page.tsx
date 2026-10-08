import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listLocations } from '@/core/location';
import { CLOCKING_LIST, UUID_RE } from './clocking/form-fields';

/**
 * r428 (83c0d3c8 contest) — "WORK LOCATIONS" RETIRED AS A MENU ROW AND AS A SCREEN OF ITS OWN; THE
 * ADDRESS SURVIVES AS A GUARDED REDIRECT STUB, the `app/admin/locations/redirect-stub.ts` idiom.
 *
 * Everything this page used to render — the company-based work-location listing — now lives as the
 * "Work locations" section of a company's own view on Attendance › Locations (`./clocking/page.tsx` step
 * 2). There is no longer a tenant-wide listing to forward to: forwarding anywhere useful means naming a
 * COMPANY, and the one thing this old address might still carry that says which one is `?focus=`, a work
 * location's own id.
 *
 * `requireAdmin()` FIRST, same as every other stub in this family: a non-administrator following an old
 * bookmark is refused here rather than told where the screen went. The route therefore stays registered
 * on the unchanged `locations` screenKey in lib/permissions.ts — nothing about what this address GRANTS
 * changes, only what it renders.
 *
 * `?focus=<id>` IS RESOLVED TO ITS COMPANY, under the SAME scope rule the old listing drew
 * (`listCompanies(s, { adminOnly: true })` — a company-scoped admin can only resolve a location inside a
 * company they administer; a location outside that scope, or a malformed/unknown id, simply fails to
 * resolve and the operator lands on step 1, the company list, which is never wrong — only less precise).
 * Every other query parameter (`saved`, `error`, the `typed*` echoes no screen here ever posts) rides
 * through unchanged, because a stale bookmark should land as close to what it meant as the new shape
 * allows, not merely avoid a 404.
 */
export default async function WorkLocationsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const rawFocus = typeof sp.focus === 'string' ? sp.focus : undefined;

  let companyId: string | undefined;
  if (rawFocus && UUID_RE.test(rawFocus)) {
    const companies = await listCompanies(s, { adminOnly: true });
    const locations = await listLocations(s, companies.map((c) => c.id), { includeArchived: true });
    companyId = locations.find((l) => l.id === rawFocus)?.companyId;
  }

  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') usp.set(k, v);
    else if (Array.isArray(v) && v[0] != null) usp.set(k, v[0]);
  }
  if (companyId) usp.set('company', companyId);
  const qs = usp.toString();
  redirect(`${CLOCKING_LIST}${qs ? `?${qs}` : ''}`);
}
