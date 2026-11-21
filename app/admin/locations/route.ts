import { redirect } from 'next/navigation';
import { AuthRequiredError } from '@/lib/auth-errors';
import { isOperator, requireAdmin } from '@/lib/authz';
import { isDemoDeployment } from '@/lib/demo-mode';
import { getSession } from '@/lib/session';
import { CLOCKING_LIST } from '../work-locations/clocking/form-fields';
import { locationsRedirectTarget } from './redirect-stub';

/** The old Attendance Locations bookmark keeps its guarded, temporary redirect. */
export async function GET(request: Request) {
  try {
    // The handler bypasses the root layout, so preserve its login and operator decisions here.
    const session = await getSession();
    if (isOperator(session) && !isDemoDeployment()) redirect('/operator');
    await requireAdmin(session);
  } catch (error) {
    if (error instanceof AuthRequiredError) redirect('/login');
    throw error;
  }

  return new Response(null, {
    status: 307,
    headers: {
      Location: locationsRedirectTarget(new URL(request.url).searchParams, CLOCKING_LIST),
      'Cache-Control': 'private, no-store',
    },
  });
}
