import { redirect } from 'next/navigation';
import { AuthRequiredError } from '@/lib/auth-errors';
import { isOperator, requireAdmin, requireModule } from '@/lib/authz';
import { isDemoDeployment } from '@/lib/demo-mode';
import { getSession } from '@/lib/session';

/** The retired Claim Forms screen remains an authorized bookmark on the Claims access column. */
export async function GET() {
  try {
    // Route handlers bypass the root and Claims layouts. Keep their decisions in the same order.
    const session = await getSession();
    if (isOperator(session) && !isDemoDeployment()) redirect('/operator');
    await requireModule('claims');
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthRequiredError) redirect('/login');
    throw error;
  }

  return new Response(null, {
    status: 308,
    headers: { Location: '/admin/claims', 'Cache-Control': 'private, no-store' },
  });
}
