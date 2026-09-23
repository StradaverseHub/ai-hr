import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listAttendanceRules } from '@/core/attendance-rule';
import { Card, PageHeader } from '@/components/ui';
import { SCHEDULE, scheduleGroupViewPath } from '../../../../attendance-policy/schedule-panel';
import { ScheduleGroupSections } from '../../group-sections';
import { RULE_ID_RE, resolveSection } from '../../sections';

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
/* ⚠️ A STRING LITERAL, NOT A CONSTANT. test/attendance-screens-layout.test.ts reads className VALUES out
 * of the source, and its own header records the limit: "a className composed through cn() or a variable
 * escapes a source check like this one". Writing this as `className={FORM_COLUMN}` made all three pages
 * silently uncovered — the guard passed by seeing no className at all. Measured, not assumed: the three
 * cases failed with "expected 0 to be greater than 0" until the literal went back inline. */

/**
 * EDIT SCHEDULE — one Schedule Group, editable, on a page of its own (feedback 665de026, r331).
 *
 * Its sibling ../page.tsx (View Schedule) carries the reasoning for the shape; this file is that page with
 * `mode="edit"` and the four Saves that implies. What is worth writing down here is what happens AFTER one
 * of them:
 *
 * ── A SAVE KEEPS YOU WHERE YOU ARE, WITH A CONFIRMATION ────────────────────────────────────────────────
 * The reporter's own words, and the whole of the second half of this item. Before it, every save on this
 * feature threw the operator somewhere else: the rule editor to the LIST, the two tab writers to
 * `?tab=…&group=…` on a screen that no longer has tabs. All four now return HERE, to the section they were
 * made from, through `okScheduleGroup` / `failScheduleGroup` (app/admin/_redirects.ts) — okCompany's
 * contract from r329, which exists precisely so this URL is built in ONE place.
 *
 * `?section=` IS READ BY VALUE against the closed key list, exactly as `?tab=` was, and it decides which
 * section shows a refusal. It rides as a SECOND `&` parameter and NEVER in front of the query key: a path
 * already carrying `?section=` handed to `fail()`/`ok()` produces `…?section=general?toast=Saved`, the
 * parameter read as "general?toast=Saved" and the toast never parsed. That defect shipped twice on this
 * screen (r287 → r301, on `?tab=`).
 *
 * `?typedWeek=` is the working-week section's "nothing you entered is lost" echo — seven characters from a
 * four-letter alphabet, read by SHAPE and dropped otherwise. See ../../actions.ts `weekParam`.
 *
 * ── NO SCREEN-WIDE SAVE, AND IT IS A DECISION, NOT AN OMISSION ─────────────────────────────────────────
 * docs/audits/665de026-schedule-save-classification.md classified all nine forms on this feature before
 * any of them moved: five are RECORD LIFECYCLE, three irreversibly, and the rule editor stamps
 * `deductions_effective_from` to TODAY on switch-on. A tab-wide Save implies a tab-wide Discard, and a
 * Discard beside that switch would appear to undo a toggle while moving the date deductions start from.
 * `components/tab-save-scope.tsx` is deliberately not mounted.
 *
 * requireAdmin(), and registered in lib/permissions.ts on the `attendancePolicy` column in the SAME commit
 * as this file — test/function-access.test.ts fails in BOTH directions.
 */
export default async function EditScheduleGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ ruleId: string }>;
  searchParams: Promise<{ error?: string; section?: string; typedWeek?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.scheduleConfig');
  const { ruleId } = await params;
  const sp = await searchParams;

  const rules = RULE_ID_RE.test(ruleId) ? await listAttendanceRules(s) : [];
  const rule = rules.find((r) => r.id === ruleId) ?? null;

  if (!rule) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title={t('editTitle')} back={{ href: SCHEDULE, label: t('backToList') }} />
        <Card>
          <p className="p-4 text-sm text-muted-foreground">{t('groupGone')}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('editTitle')}
        description={rule.name}
        /* BACK RETURNS TO THE LIST — the reporter's words. It writes nothing, which is why the four Saves
           can each be a plain button: there is exactly one way out of this page that discards nothing and
           exactly one that discards everything unsaved, and they are not the same control. */
        back={{ href: SCHEDULE, label: t('backToList') }}
        actions={
          <Link href={scheduleGroupViewPath(rule.id)} className="text-sm text-primary hover:underline">
            {t('viewThis')}
          </Link>
        }
      />
      <ScheduleGroupSections
        s={s}
        rule={rule}
        rules={rules}
        mode="edit"
        error={sp.error}
        section={resolveSection(sp.section)}
        typedWeek={sp.typedWeek}
      />
    </div>
  );
}
