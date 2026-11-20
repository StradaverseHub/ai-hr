import { scopedAdmin } from '@/lib/scope';
import { assertModuleEnabled } from '@/core/entitlements';
import { buildTxnTemplateReference } from '../reference';

export async function GET(request: Request) {
  const { s, scopeIds } = await scopedAdmin();
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    assertModuleEnabled(s, 'payroll');
  } catch {
    return new Response('Forbidden', { status: 403, headers });
  }
  const params = new URL(request.url).searchParams;
  const kind = params.get('kind');
  if (kind !== 'fixed' && kind !== 'individual') {
    return new Response('Invalid payroll template kind', { status: 400, headers });
  }
  const preferredCompanyId = scopeIds.find(id => id === params.get('companyId'));
  const reference = await buildTxnTemplateReference(
    s,
    scopeIds,
    kind === 'fixed' ? { preferredCompanyId } : undefined,
  );
  return Response.json(reference, { headers });
}
