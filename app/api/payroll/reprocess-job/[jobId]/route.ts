/**
 * Reprocess job-status endpoint (feedback 9bc442bc, reporter expected_function: "a job-status endpoint
 * for the UI to poll or receive push updates"). Admin-only; returns the queued reprocess job's current
 * status + result/error so the UI can poll it. Read-only.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { getReprocessJob } from '@/core/payroll';

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  const { jobId } = await ctx.params;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(jobId)) return new Response('A valid jobId (uuid) is required', { status: 400 });
  const job = await getReprocessJob(s, jobId);
  if (!job) return new Response('Not found', { status: 404 });
  return Response.json(job);
}
