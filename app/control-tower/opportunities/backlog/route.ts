import { requireAdmin } from '@/lib/authz';

/** AI Centre restructure (4 Nov 2026): the build-list export moved with the build list to Administration › Build list
 * (/control-tower/agents/build-list/export). This old address forwards there with its window, after the same guard, so a
 * saved link keeps working; the new route applies the same group-only read owner. It reads nothing. */
export async function GET(request: Request) {
  await requireAdmin();
  const days = new URL(request.url).searchParams.get('days');
  const target = new URL('/control-tower/agents/build-list/export', request.url);
  if (days) target.searchParams.set('days', days);
  return Response.redirect(target, 308);
}
