import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listAttendanceRules } from '@/core/attendance-rule';
import { Card, PageHeader } from '@/components/ui';
import { SCHEDULE, scheduleGroupEditPath } from '../../../attendance-policy/schedule-panel';
import { ScheduleGroupSections } from '../group-sections';
import { RULE_ID_RE, resolveSection } from '../sections';

/** 7500c083 supersedes the old reading-width cap. Schedule configuration uses the available width;
 * section-specific saves and the page's existing navigation/confirmation contracts remain intact. */

/**
 * VIEW SCHEDULE — one Schedule Group, read-only, on a page of its own (feedback 665de026, r331).
 *
 * THE ITEM IN ONE LINE. Attendance › Schedule carried EVERY Schedule Group's settings on one tabbed page,
 * with Add and Edit opening over the top of it. The reporter called it crowded and asked for a list plus a
 * page per group, titled in their own words: Add Schedule · View Schedule · Edit Schedule.
 *
 * THE SHAPE IS COPIED, NOT INVENTED. app/(app)/admin/attendance/schedule-assignment reached exactly this shape
 * the hard way: r263 shipped an inline edit panel over the list, the reporter contested it, and r265 made
 * it list + `[employmentId]` detail. This is the same correction applied to the sibling screen, so the two
 * Attendance sub-screens are navigated the same way rather than two ways.
 *
 * WHAT IS ON IT is ./group-sections.tsx with `mode="view"` — ONE file describes what a Schedule Group is,
 * and this page and ../[ruleId]/edit differ only in that word. Two files would have been two descriptions
 * of one record, diverging the first time a section changed, with nothing failing.
 *
 * `[ruleId]` IS AN UNTRUSTED URL SEGMENT: its shape is checked before any query (../sections.ts
 * RULE_ID_RE), and junk, an unknown id and a group the viewer cannot see all render the same sentence with
 * the back link. Never notFound(), never a 500.
 *
 * requireAdmin(), like the list and every other row of the Attendance settings menu it hangs under. The
 * menu is not what protects it (test/attendance-menu-relocation.test.ts). Registered in lib/permissions.ts
 * on the `attendancePolicy` column in the SAME commit as this file — test/function-access.test.ts fails in
 * BOTH directions, so neither half may land alone.
 */
export default async function ViewScheduleGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ ruleId: string }>;
  searchParams: Promise<{ error?: string; section?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.scheduleConfig');
  const { ruleId } = await params;
  const sp = await searchParams;

  // Read by VALUE against what exists for this viewer, exactly as `?tab=` and `?group=` always were.
  const rules = RULE_ID_RE.test(ruleId) ? await listAttendanceRules(s) : [];
  const rule = rules.find((r) => r.id === ruleId) ?? null;

  if (!rule) {
    return (
      <div className="w-full min-w-0 space-y-6">
        <AttendanceSettingsNavigation />
      <PageHeader title={t('viewTitle')} back={{ href: SCHEDULE, label: t('backToList') }} />
        <Card>
          <p className="p-4 text-sm text-muted-foreground">{t('groupGone')}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 space-y-6">
      <PageHeader
        title={t('viewTitle')}
        description={rule.name}
        back={{ href: SCHEDULE, label: t('backToList') }}
        actions={
          <Link href={scheduleGroupEditPath(rule.id)} className="text-sm text-primary hover:underline">
            {t('groupLink')}
          </Link>
        }
      />
      <ScheduleGroupSections
        s={s}
        rule={rule}
        rules={rules}
        mode="view"
        error={sp.error}
        section={resolveSection(sp.section)}
      />
    </div>
  );
}
