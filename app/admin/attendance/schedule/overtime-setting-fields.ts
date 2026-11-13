import 'server-only';
import { parseScheduleOvertimeSetting, type ScheduleOvertimeSetting } from '@/lib/schedule-overtime-setting';
import type { ScheduleOvertimeSettingScope } from '@/packs/attendance/service';

/** 2f803985 — the Overtime Setting section's posted fields, or null when this submission did not carry
 * the section. The marker is read by VALUE ('1'), never by presence (see rule-actions.ts `allowedShiftIds`). */
export function readScheduleOvertimeSettingFields(fd: FormData): {
  setting: ScheduleOvertimeSetting; scope: ScheduleOvertimeSettingScope; effectiveFrom: string; token: string;
} | null {
  if (fd.get('otSettingEditor') !== '1') return null;
  const scope: ScheduleOvertimeSettingScope = fd.get('otScope') === 'companies'
    ? { kind: 'companies', companyIds: fd.getAll('otCompanyIds').map(String).filter(Boolean) }
    : { kind: 'all' };
  return {
    setting: parseScheduleOvertimeSetting(fd),
    scope,
    effectiveFrom: String(fd.get('otEffectiveFrom') ?? ''),
    token: String(fd.get('otSettingToken') ?? ''),
  };
}
