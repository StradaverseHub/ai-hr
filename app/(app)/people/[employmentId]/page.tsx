import { redirect } from 'next/navigation';

/**
 * Legacy redirect stub for old /people/[id] deep-links → the read-only /personnel/[id] profile.
 * Query params (e.g. ?from=org) flow through so context-aware back links keep working.
 */
export default async function PeopleDetailRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { employmentId } = await params;
  const sp = await searchParams;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') usp.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => usp.append(k, x));
  }
  const qs = usp.toString();
  redirect(qs ? `/personnel/${employmentId}?${qs}` : `/personnel/${employmentId}`);
}
