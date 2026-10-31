import { redirect } from 'next/navigation';

/**
 * Legacy redirect stub. The "People" module was renamed to "Personnel" and split into a read-only
 * employee directory (/personnel) and an admin-only management surface (/admin/personnel). This
 * preserves old bookmarks/deep-links: the everyday directory is the safe default for any visitor.
 */
export default async function PeopleRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') usp.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => usp.append(k, x));
  }
  const qs = usp.toString();
  redirect(qs ? `/personnel?${qs}` : '/personnel');
}
