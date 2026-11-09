import { redirect } from 'next/navigation';
import { AuthRequiredError } from '@/lib/auth-errors';
import { isOperator, requireModule } from '@/lib/authz';
import { isDemoDeployment } from '@/lib/demo-mode';
import { getSession } from '@/lib/session';

/** The old Rewards Configuration address still forwards to the Plans workspace. */
export async function GET(request: Request) {
  try {
    // Route handlers bypass the root and Rewards layouts.
    const session = await getSession();
    if (isOperator(session) && !isDemoDeployment()) redirect('/operator');
    await requireModule('rewards', session);
  } catch (error) {
    if (error instanceof AuthRequiredError) redirect('/login');
    throw error;
  }

  const search = new URL(request.url).searchParams;
  // The former page accepted only scalar searchParams, which exclude repeated keys.
  const scalar = (key: string) => {
    const values = search.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  };
  const query = new URLSearchParams();
  const version = scalar('version');
  const year = scalar('year');
  if (version !== undefined) query.set('version', version);
  if (year !== undefined) query.set('year', year);
  const message = search.has('error') ? scalar('error') : scalar('sharedError');
  if (message !== undefined) query.set('error', message);

  return new Response(null, {
    status: 307,
    headers: {
      Location: '/admin/rewards/plans' + (query.size ? '?' + query.toString() : ''),
      'Cache-Control': 'private, no-store',
    },
  });
}

export const HEAD = GET;
