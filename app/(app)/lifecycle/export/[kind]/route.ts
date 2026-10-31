import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { exportLifecycleCsv, type ExportKind } from '@/packs/lifecycle/service';

const KINDS = new Set<string>(['onboarding', 'offboarding', 'requisitions', 'assets', 'asset-requests']);
const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Manager-only CSV. The service enforces the level; a requester gets the same refusal as anywhere else. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!KINDS.has(kind)) return new Response('Not found', { status: 404 });
  const s = await getSession();
  const u = new URL(req.url);
  const from = u.searchParams.get('from'); const to = u.searchParams.get('to');
  try {
    const csv = await exportLifecycleCsv(s, kind as ExportKind, { from: isDate(from) ? from : undefined, to: isDate(to) ? to : undefined });
    return new Response(csv, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="lifecycle-${kind}.csv"`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
    });
  } catch {
    return new Response('Forbidden', { status: 403 });
  }
}
