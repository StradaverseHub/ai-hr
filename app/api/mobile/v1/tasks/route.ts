import { listPendingTasks } from '@/core/approvals-inbox';
import { isModuleEnabled } from '@/core/entitlements';
import { TasksResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';
/** The existing approval inbox owns visibility; no caller-supplied tenant, company or person selector. */
export const GET = mobileRoute(TasksResponse, async s => {
  // V1 is the retained approval-only UUID/kind contract. The new web Notice acknowledgement journey
  // does not silently expand this native API; a native Notice flow is outside the approved Home scope.
  const items = await listPendingTasks(s, undefined, { attendance: isModuleEnabled(s, 'attendance'), claims: isModuleEnabled(s, 'claims') },{noticeAcknowledgements:false});
  return { total: items.length, items: items.slice(0, 50).map(item => ({ id: item.id, kind: item.kind, subject: item.subjectName })) };
});
