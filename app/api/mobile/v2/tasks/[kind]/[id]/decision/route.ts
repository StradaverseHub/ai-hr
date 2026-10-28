/**
 * POST /api/mobile/v2/tasks/{kind}/{id}/decision {requestId, decision, reason?, dates?, expected} — M08. The same
 * admission as the detail, then the kind's canonical decider (decideLeave / decideLeaveDates /
 * decideLeaveCancellation / decideAttendanceCorrection / decideClaim — D12) inside the mobile command receipt, with
 * the expected step/stage/status. The decider's employment is the caller's own, never the body's. A moved step/stage
 * is `stale_step`; a claim no longer pending is `already_decided`.
 */
import { decideTaskV2 } from '@/core/mobile-approvals';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { taskOf } from '@/lib/mobile-api/task-routes';
import { TaskDecisionCommand, TaskDecisionResult } from '@/lib/mobile-api/v2/tasks';

export const POST = mobileRoute(TaskDecisionResult, async (s, req) => {
  const { kind, id } = taskOf(req);
  const command = TaskDecisionCommand.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  const c = command.data;
  // The echoed `expected` must be this kind's shape; `dates` names leave dates to approve, nothing else.
  const shape = 'stepIndex' in c.expected ? 'leave' : 'stageIndex' in c.expected ? 'attendance' : 'claim';
  if (shape !== (kind === 'leaveCancellation' ? 'leave' : kind)) throw new MobileBadRequest('Expected state does not match the task kind');
  if (c.dates && (kind !== 'leave' || c.decision !== 'approve')) throw new MobileBadRequest('Dates apply to a leave approval only');
  return decideTaskV2(s, kind, id, c);
});
