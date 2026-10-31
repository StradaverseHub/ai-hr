import { redirect } from 'next/navigation';

/**
 * Redirect stub (a4e49748). The System Settings nav group makes the bare /admin/settings prefix a
 * plausible address to type, but no page lives here — forward to the group's first screen (Employee ID
 * numbering) instead of a hard 404. This is NOT the optional System Settings landing page (deliberately
 * not built; see the a4e49748 plan). No guard here — the destination page enforces admin access; this
 * stub only redirects (so it is intentionally NOT a function-access column, same as the
 * profile-options stub). Query string is preserved.
 */
export default async function SystemSettingsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') usp.set(k, v);
    else if (Array.isArray(v) && v[0] != null) usp.set(k, v[0]);
  }
  const qs = usp.toString();
  redirect(`/admin/settings/employee-id${qs ? `?${qs}` : ''}`);
}
