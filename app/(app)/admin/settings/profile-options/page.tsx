import { redirect } from 'next/navigation';

/**
 * Legacy redirect stub (fbdeee87). Profile Options was relocated into the System Labels surface as a tab
 * (Administration → System Labels → Profile Options). This preserves old bookmarks/deep-links, forwarding
 * to the new canonical route. No guard here — the destination page enforces admin access; this stub only
 * redirects (so it is intentionally NOT a function-access column). Query string is preserved.
 */
export default async function ProfileOptionsRedirect({
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
  redirect(`/admin/settings/system-labels/profile-options${qs ? `?${qs}` : ''}`);
}
