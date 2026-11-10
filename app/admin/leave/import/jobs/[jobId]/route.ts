import {requireAdmin} from '@/lib/authz';
import {readLeaveImportJob} from '@/core/leave-import-job';
import {capacityAwareRead} from '@/lib/database-degraded';

export const GET = capacityAwareRead(async function GET(_request: Request, {params}: {params: Promise<{jobId: string}>}) {
  const session = await requireAdmin();
  const job = await readLeaveImportJob(session, (await params).jobId);
  if (!job) return Response.json({error: 'Import unavailable.'}, {status: 404, headers: {'Cache-Control': 'private, no-store'}});
  return Response.json({job}, {headers: {'Cache-Control': 'private, no-store'}});
});
