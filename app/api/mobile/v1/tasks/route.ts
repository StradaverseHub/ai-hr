import { listPendingTasks } from '@/core/approvals-inbox';
import { isModuleEnabled } from '@/core/entitlements';
import { TasksResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';
/** The existing approval inbox owns visibility; no caller-supplied tenant, company or person selector. */
export const GET = mobileRoute(TasksResponse, async s => {
  const items = await listPendingTasks(s, undefined, { attendance: isModuleEnabled(s, 'attendance'), claims: isModuleEnabled(s, 'claims') });
  return { total: items.length, items: items.slice(0, 50).map(item => ({ id: item.id, kind: item.kind, subject: item.subjectName })) };
});
