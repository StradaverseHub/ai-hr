import 'server-only';

import type { SessionContext } from '@/db/client';
import type { ScheduleClockSettings } from '@/components/schedule-clock-fields';
import { isGroupAdmin } from '@/lib/authz';
import { attendanceClockPolicyGroupHistory, attendanceClockPolicyHistory, overtimePatternWorkspaceCompanies } from '@/packs/attendance/service';

/** The administrator's companies, the group-wide chain and each company's own chain for one Schedule
 * Group (none for a group being created). All Companies is offered to group administrators only. */
export async function scheduleClockCompanies(
  ctx: SessionContext, scopeIds: readonly string[], ruleId?: string,
): Promise<ScheduleClockSettings> {
  const canUseAll = isGroupAdmin(ctx);
  const companies = scopeIds.length
    ? (await overtimePatternWorkspaceCompanies(ctx)).filter(company=>scopeIds.includes(company.id)) : [];
  const strip = <T extends {ordinal:number;effectiveFrom:string;policy:unknown}>(rows:T[]) =>
    rows.map(({ordinal,effectiveFrom,policy})=>({ordinal,effectiveFrom,policy})) as ScheduleClockSettings['group'];
  return {
    canUseAll,
    group: ruleId ? strip(await attendanceClockPolicyGroupHistory(ctx,{ruleId})) : [],
    companies: await Promise.all(companies.map(async company=>({
      id:company.id,
      name:company.name,
      history:ruleId ? strip(await attendanceClockPolicyHistory(ctx,{companyId:company.id,ruleId})) : [],
    }))),
  };
}
