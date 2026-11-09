import 'server-only';

import type { SessionContext } from '@/db/client';
import type { ScheduleClockCompany } from '@/components/schedule-clock-fields';
import { attendanceClockPolicyHistory, overtimePatternWorkspaceCompanies } from '@/packs/attendance/service';

export async function scheduleClockCompanies(
  ctx: SessionContext, scopeIds: readonly string[], ruleId?: string,
): Promise<ScheduleClockCompany[]> {
  if (!scopeIds.length) return [];
  const companies = (await overtimePatternWorkspaceCompanies(ctx)).filter(company=>scopeIds.includes(company.id));
  return Promise.all(companies.map(async company=>({
    id:company.id,
    name:company.name,
    history:ruleId ? (await attendanceClockPolicyHistory(ctx,{companyId:company.id,ruleId}))
      .map(({ordinal,effectiveFrom,reason,policy})=>({ordinal,effectiveFrom,reason,policy})) : [],
  })));
}
