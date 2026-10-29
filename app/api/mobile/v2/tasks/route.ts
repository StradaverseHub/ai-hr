/**
 * GET /api/mobile/v2/tasks?cursor&limit — M08. Every task awaiting the caller's decision, from the web inbox's own
 * owner (listPendingTasks), replacement leave and notice acknowledgements included, in the inbox's order. Kinds the
 * app decides natively carry `nativeDecision: true`; every other kind carries its web path (D2).
 */
import { tasksPageV2 } from '@/core/mobile-approvals';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { mobileLocale } from '@/lib/mobile-api/request';
import { pageRequest } from '@/lib/mobile-api/v2/common';
import { TASKS_CURSOR, TasksCursor, TasksPageV2 } from '@/lib/mobile-api/v2/tasks';

export const GET = mobileRoute(TasksPageV2, async (s, req) => tasksPageV2(s, pageRequest(new URL(req.url), TASKS_CURSOR, TasksCursor), mobileLocale(req)));
