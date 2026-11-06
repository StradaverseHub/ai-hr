import { AuthRequiredError } from '@/lib/auth-errors';
import { isAdmin } from '@/lib/authz';
import { getSession } from '@/lib/session';
import { shapeApprovalHistoryItems } from '@/lib/approval-history';
import { listApprovalHistory } from '@/core/read';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' };

export async function GET() {
  try {
    const session = await getSession();
    if (!isAdmin(session) && !session.roles?.includes('manager')) {
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    }
    const rows = await listApprovalHistory(session, {
      from: new Date(Date.now() - 90 * 86400000).toISOString(),
      limit: 10,
    });
    return Response.json(shapeApprovalHistoryItems(rows), { headers });
  } catch (error) {
    return error instanceof AuthRequiredError
      ? Response.json({ error: 'authentication' }, { status: 401, headers })
      : Response.json({ error: 'unavailable' }, { status: 503, headers });
  }
}
