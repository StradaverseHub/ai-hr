import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { UUID_RE, clockingEditPage } from '../../../work-locations/clocking/form-fields';
import { forward } from '../../redirect-stub';

/**
 * 639bf4a5 (r336) — REDIRECT STUB, guard first, query forwarded (see ../../page.tsx).
 *
 * `[id]` IS AN UNTRUSTED URL SEGMENT AND IT IS SHAPE-CHECKED BEFORE IT IS INTERPOLATED INTO A PATH.
 * The destination (app/admin/work-locations/clocking/[id]/page.tsx) checks it too, against the same
 * UUID_RE and for the same reason — but a stub that forwarded junk would be building a redirect target
 * out of a url value, which is the one shape app/admin/actions.ts refuses everywhere else. Junk is
 * notFound() here exactly as it is there, so the two pages cannot disagree about what the address means.
 */
export default async function EditClockingLocationRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  forward(await searchParams, clockingEditPage(id));
}
