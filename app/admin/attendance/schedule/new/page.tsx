import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listAttendanceRules } from '@/core/attendance-rule';
import { listShiftsForTenant } from '@/core/roster';
import { PageHeader } from '@/components/ui';
import { SCHEDULE } from '../../../attendance-policy/schedule-panel';
import { RuleForm } from '../../../attendance-policy/rules/rule-form';
import { ruleShiftChoices } from '../../../attendance-policy/rules/shift-choices';

/**
 * 665de026 — A READING COLUMN, NOT EDGE TO EDGE, and it is the same decision r301 made one level down.
 *
 * rules/rule-form.tsx capped ITSELF at `mx-auto max-w-3xl` for as long as it drew its own page chrome,
 * and test/attendance-screens-layout.test.ts pinned that ("a form spread across a very wide screen is
 * harder to fill in, not easier"). The cap moved UP here with the chrome, so the whole screen is one
 * column instead of a 3xl form sitting inside a full-width page beside wider sections. 5xl rather than
 * the old 3xl because this page carries more than the form did: the seven-day working-week row and the
 * overtime ladder both want the extra room, and the ladder is the table r301's note said the cap existed
 * to protect.
 */
const FORM_COLUMN = 'mx-auto max-w-5xl space-y-6';

/**
 * ADD SCHEDULE — a new Schedule Group, on a page of its own (feedback 665de026, r331).
 *
 * "Add New Schedule opens its own page, titled Add Schedule", in the reporter's words. Until this round it
 * opened as a panel over the list (`?editGroup=new`, r301) and before that as its own route
 * (/admin/attendance-policy/rules/new, 88e94371) — which is now a redirect to here, so the old bookmarks
 * keep working.
 *
 * ── WHY THIS PAGE HAS ONE SECTION AND THE OTHER TWO HAVE SEVEN ─────────────────────────────────────────
 * THE OTHER SIX SECTIONS HAVE NOTHING TO ATTACH TO YET, and that is a fact about the data rather than a
 * decision about the layout. The grace periods, the per-band rounding and the working week are all columns
 * on an `attendance_rule` ROW; until the row exists there is nothing for them to be settings OF.
 * `createAttendanceRule` writes the group with its defaults — including the "declares no week" week that
 * every group starts with (07ebd04d) — and the operator's next stop is the group's own Edit Schedule page,
 * which is exactly where `createAttendanceRuleAction` sends them, with a confirmation. One hop, and every
 * section is then on one screen.
 *
 * Drawing seven sections here and holding six of them in hidden fields until the row existed would be a
 * second write path over one table, and it is the shape that produced the data-loss trap recorded at the
 * top of ../actions.ts.
 *
 * ── THE FORM IS rules/rule-form.tsx, UNCHANGED APART FROM ITS CHROME ───────────────────────────────────
 * The overtime-band editor, the continuous-ladder validation, the service-stamped deduction date and the
 * "Shifts allowed" marker contract all stay in one file with one writer. What this round took off it is
 * the `PageHeader` it used to draw for itself, which had been rendering a second `<h1>` inside r301's
 * panel and a back link pointing at a redirect stub.
 *
 * requireAdmin(), and registered in lib/permissions.ts on the `attendancePolicy` column in the SAME commit
 * as this file — test/function-access.test.ts fails in BOTH directions.
 */
export default async function AddScheduleGroupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.scheduleConfig');
  const tr = await getTranslations('admin.attendanceRule');
  const sp = await searchParams;

  const [rules, shifts] = await Promise.all([listAttendanceRules(s), listShiftsForTenant(s)]);

  return (
    <div className={FORM_COLUMN}>
      <PageHeader
        title={t('addTitle')}
        description={t('addSubtitle')}
        back={{ href: SCHEDULE, label: t('backToList') }}
      />
      {/* `rule` null ⇒ the Add form: nothing is ticked, but each "Shifts allowed" row still says which
          group the shift would be taken FROM, because that is the fact an administrator needs before they
          tick it (ruleShiftChoices, 870b79e2). */}
      <RuleForm
        rule={null}
        shifts={ruleShiftChoices(shifts, rules, null)}
        error={sp.error}
        cancel={{ href: SCHEDULE, label: tr('cancel') }}
      />
    </div>
  );
}
