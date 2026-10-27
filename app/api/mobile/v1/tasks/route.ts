import { listPendingTasks } from '@/core/approvals-inbox';
import { isModuleEnabled } from '@/core/entitlements';
import { TasksResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';
/** The existing approval inbox owns visibility; no caller-supplied tenant, company or person selector. */
export const GET = mobileRoute(TasksResponse, async s => {
  // Performance and Rewards work is not in the published v1 kind enum either, so those sources are not read.
  const tasks = await listPendingTasks(s, undefined, { attendance: isModuleEnabled(s, 'attendance'), claims: isModuleEnabled(s, 'claims'), performance: false, rewards: false },{noticeAcknowledgements:false});
  // Existing v1 clients validate a closed task-kind enum. Keep that published
  // vocabulary until a versioned mobile contract supports replacement leave.
  const items = tasks.flatMap(item => item.kind === 'replacementLeave' ? [] : [{ id: item.id, kind: item.kind, subject: item.subjectName }]);
  return { total: items.length, items: items.slice(0, 50) };
});
