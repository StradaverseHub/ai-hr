import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import { listLeaveHistoryImportRuns } from '@/core/leave-history-import';
import { listLeaveBfImportRuns } from '@/core/leave-bf-import';
import { leaveDataImportType } from '@/lib/leave-data-import';
import { LeaveDataImport } from './leave-data-import';
export default async function LeaveDataImportPage({ searchParams }: { searchParams: Promise<{ type?: string | string[] }> }) {
  const s = await requireAdmin();
  const header = await leaveConfigPageHeader('leaveDataImport');
  const [historyRuns, bfRuns] = await Promise.all([listLeaveHistoryImportRuns(s), listLeaveBfImportRuns(s)]);
  return <div className="space-y-6"><PageHeader title={header.title} description={header.description} /><LeaveConfigMap current="leaveDataImport" /><LeaveDataImport initialType={leaveDataImportType((await searchParams).type)} historyRuns={historyRuns} bfRuns={bfRuns} /></div>;
}
