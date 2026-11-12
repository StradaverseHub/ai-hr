import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { attendanceRuleOvertimeSnapshot } from '@/core/attendance-rule';
import { getAttendanceRule } from '@/packs/attendance/service';
import { ErrorBanner, btnPrimary } from '@/components/ui';
import { ScheduleOvertimeDraftFields } from '@/components/schedule-overtime-draft-fields';
import { AttendanceSettingsActionForm, AttendanceSettingsSaveButton } from '@/components/attendance-settings-action-form';
import { renderScheduleOvertimeBands } from '../../../attendance-policy/rules/rule-form';
import { saveScheduleGroupOvertimeAction } from '../../schedule/actions';
import { scheduleGroupEditPath } from '../../../attendance-policy/schedule-panel';

/**
 * 2f803985 — OVERTIME PATTERNS › 1. GENERAL SETTINGS FOR A LEGACY (SCHEDULE GROUP) PATTERN.
 *
 * The Schedule Group's overtime bands (rates, rounding, early overtime) moved here from the group's Overtime
 * tab with the SAME editor (renderScheduleOvertimeBands), the SAME stale-ladder guard and the SAME writer
 * (saveScheduleGroupOvertimeAction → updateAttendanceRuleSection 'overtimeFull'). The attendance_rule owner
 * stays the only writer, so the 0551 snapshot trigger keeps recording each saved ladder as a new legacy
 * version, and no calculation changes. The pattern owner (packs/attendance/overtime-patterns.ts) still refuses
 * legacy edits through its own writer. Authority is the rule owner's: an administrator (RLS app.is_admin()),
 * the same as Schedule Group editing; this page already requires one.
 */
export async function LegacyOvertimeBands({ s, ruleId, patternId, error, savedReceipt }: {
  s: SessionContext; ruleId: string | null; patternId: string; error?: string; savedReceipt?: string;
}) {
  const t = await getTranslations('overtimePatterns');
  const tr = await getTranslations('admin.attendanceRule');
  const rule = ruleId ? await getAttendanceRule(s, ruleId) : null;
  if (!rule) return <p role="status" className="rounded-lg border border-border p-4 text-sm">{t('legacyGroupGone')}</p>;
  const identity = attendanceRuleOvertimeSnapshot(rule.otRows, rule.applyToEarlyOt);
  return <section aria-labelledby="ot-legacy-general" className="space-y-4 rounded-xl border border-border bg-card p-5" data-overtime-legacy-bands="">
    <div className="space-y-1">
      <h2 id="ot-legacy-general" className="font-semibold">{t('legacyGeneralSettings')}</h2>
      <p className="text-sm text-muted-foreground">{t('legacyGroup', { name: rule.label?.trim() ? `${rule.label.trim()} — ${rule.name}` : rule.name })}{' · '}
        <Link href={scheduleGroupEditPath(rule.id)} className="text-primary hover:underline">{t('legacyOpenGroup')}</Link></p>
      <p className="text-sm text-muted-foreground">{t('legacyMovedHelp')}</p>
    </div>
    <ErrorBanner message={error} />
    <AttendanceSettingsActionForm submitAction={saveScheduleGroupOvertimeAction} data-attendance-save-scope=""
      data-attendance-saved-receipt={savedReceipt} className="space-y-4">
      <input type="hidden" name="ruleId" value={rule.id} />
      <input type="hidden" name="returnPattern" value={patternId} />
      <ScheduleOvertimeDraftFields identity={identity} savedReceipt={savedReceipt}>
        <input type="hidden" name="otBandSnapshot" data-attendance-guard-meta value={identity} />
        <input type="hidden" name="overtimeFullEditor" value="1" />
        {await renderScheduleOvertimeBands(rule)}
      </ScheduleOvertimeDraftFields>
      <AttendanceSettingsSaveButton className={btnPrimary}>{tr('save')}</AttendanceSettingsSaveButton>
    </AttendanceSettingsActionForm>
  </section>;
}
