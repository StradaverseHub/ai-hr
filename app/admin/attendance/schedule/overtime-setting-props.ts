import 'server-only';
import type { SessionContext } from '@/db/client';
import type { ScheduleOvertimeSettingIslandProps } from '@/components/schedule-overtime-setting';
import { defaultScheduleOvertimeSetting } from '@/lib/schedule-overtime-setting';
import { scheduleGroupOvertimeSetting } from '@/packs/attendance/service';

/** 2f803985 — the Overtime Setting section's data for Add (ruleId null) and Edit/View Schedule. One
 * owner read with set-based statements; no per-company query, whatever "All companies" covers. */
export async function scheduleOvertimeSettingProps(
  s: SessionContext, ruleId: string | null, editing: boolean,
): Promise<ScheduleOvertimeSettingIslandProps> {
  const view = await scheduleGroupOvertimeSetting(s, { ruleId });
  const everywhere = view.patterns.find(row => view.companies.every(company => row.companyIds.includes(company.id)));
  return {
    editing,
    initial: view.saved?.setting ?? defaultScheduleOvertimeSetting(everywhere?.versionId ?? null),
    companies: view.companies,
    patterns: view.patterns.map(({ versionId, name, code, companyIds }) => ({ versionId, name, code, companyIds })),
    minimumDate: view.minimumDate,
    token: view.token,
    saved: view.saved ? { effectiveFrom: view.saved.effectiveFrom, differingCount: view.saved.differingCompanyIds.length,
      unsupportedRounding: view.saved.unsupportedRounding } : null,
  };
}
