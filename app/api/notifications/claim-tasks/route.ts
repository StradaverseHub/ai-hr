import { pendingBellClaimPreview } from '@/core/approvals-inbox';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { AuthRequiredError } from '@/lib/auth-errors';
import { companyContextForPage } from '@/lib/scope';
import { getSession } from '@/lib/session';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' };

export async function GET() {
  try {
    const session = await getSession();
    if (!isModuleEnabledOrFalse(session, 'claims')) {
      return Response.json({ items: [], total: 0 }, { headers });
    }
    const { scopeIds } = await companyContextForPage(session);
    return Response.json(await pendingBellClaimPreview(session, scopeIds), { headers });
  } catch (error) {
    return error instanceof AuthRequiredError
      ? Response.json({ error: 'authentication' }, { status: 401, headers })
      : Response.json({ error: 'unavailable' }, { status: 503, headers });
  }
}
