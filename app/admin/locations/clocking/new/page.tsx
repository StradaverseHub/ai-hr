import { requireAdmin } from '@/lib/authz';
import { CLOCKING_NEW_PAGE } from '../../../work-locations/clocking/form-fields';
import { forward } from '../../redirect-stub';

/**
 * 639bf4a5 (r336) — REDIRECT STUB, for the same reasons as ../../page.tsx: the clocking points moved
 * with the site, so this address now forwards to `/admin/work-locations/clocking/new`, guard first.
 *
 * The query string rides along because a refused save lands back on the NEW page carrying `?error=` and
 * every `typed*` value (app/admin/actions.ts, clockingRefused). Dropping it would hand the operator an
 * empty form and no reason.
 */
export default async function NewClockingLocationRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  forward(await searchParams, CLOCKING_NEW_PAGE);
}
