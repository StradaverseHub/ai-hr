/**
 * GET /api/mobile/v2/tasks/{kind}/{id} — M08. One task the caller is CURRENTLY assigned (isCurrentAssignedApproval),
 * with the facts the web inbox shows and the step/stage the decision must echo. Anything else is `not_assigned` —
 * the same answer for another tenant's, another company's or a guessed id — except the caller's own request
 * (`self_approval`, D4) or a readable row no longer pending (`already_decided`). core/mobile-approvals.ts composes.
 */
import { taskDetailV2 } from '@/core/mobile-approvals';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileLocale } from '@/lib/mobile-api/request';
import { taskOf } from '@/lib/mobile-api/task-routes';
import { TaskDetailResult } from '@/lib/mobile-api/v2/tasks';

export const GET = mobileRoute(TaskDetailResult, async (s, req) => {
  const { kind, id } = taskOf(req);
  return taskDetailV2(s, kind, id, mobileLocale(req));
});
