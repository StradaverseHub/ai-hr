import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { PageHeader, pageWideCls } from '@/components/ui';

/**
 * My Attendance › Attendance Overview (feedback 2aef3cd8, r362) — DELIBERATELY BLANK BELOW THE TITLE.
 *
 * ── WHAT THIS SCREEN IS NOW ─────────────────────────────────────────────────────────────────────────
 * A title and nothing else. The reporter asked, in two numbered tasks, for the row to be renamed from
 * "My Records" to "Attendance Overview" and for EVERYTHING under it to be removed, and the approved plan
 * says it in as many words: "Below the title the page is blank." The route, the module layout guard and
 * the `myAttendanceRecords` column in lib/permissions.ts all stay, because the plan's next sentence is
 * that new content arrives here later.
 *
 * ── WHAT r287 PUT HERE, AND THAT IT IS GONE ─────────────────────────────────────────────────────────
 * THE OLD RULE, STATED SO THE REVERSAL IS LEGIBLE: this file was "the employee half of a split", and its
 * header used to argue at length that the one attendance read on the page was keyed on `me.employmentId`
 * from `myEmployment(s)` — the caller's OWN employment — so that the screen was structurally incapable of
 * showing another person's rows. That argument was true and is now MOOT rather than wrong: there is no
 * read at all. `myEmployment`, `attendanceForEmploymentRange`, the seventeen-column day table, the two
 * month arrows, the pager, the intro line and the correction footer were all removed this round.
 *
 * Why the split still mattered, for whoever brings content back: r287 existed because `/attendance` is
 * ONE screen serving both audiences (`scopedSession` — a single row to an employee, every employee in
 * scope to an administrator) and the Administration sidebar group gates `adminOnly` at GROUP level, so
 * MOVING the row into Administration makes the screen invisible to staff rather than admin-only.
 * a324a4b3 rev2 made exactly that move and rev3 undid it; test/sidebar-attendance-group.test.ts exists to
 * stop a third attempt and is still live. So this route is not spare — it is the only employee-reachable
 * address under My Attendance that is free to hold an attendance view.
 *
 * ── THE CONSEQUENCE, RECORDED BECAUSE IT IS A REVERSAL AND NOT AN OVERSIGHT ─────────────────────────
 * This was the ONLY screen anywhere in the employee menu that showed a person their own attendance day by
 * day. Its five siblings under MY_ATTENDANCE_NAV are clock, requests, plan-ot, travel and request-status,
 * none of which renders the record; `/attendance`, daily, individual and breakdown all sit in
 * ATTENDANCE_NAV inside the group-gated Administration section and are invisible to staff. Until
 * something replaces what is below this title, an employee has nowhere in the product to look up their
 * own attendance. The plan states that at the top and the reporter approved it; nothing is deleted from
 * the data and no figure moves, so the view can be restored at any time.
 *
 * ── WHY `scopedSession()` IS STILL CALLED ON A PAGE THAT READS NOTHING ──────────────────────────────
 * Two reasons, and neither is decoration. It is the authentication boundary: `getSession()` inside it is
 * what makes this an authenticated page rather than a public one. And test/function-access.test.ts
 * collects every `page.tsx` whose SOURCE names one of the page guards and fails "no stale routes" for any
 * REGISTERED_ROUTES entry with no such file — the route stays registered, so the call stays. Its company
 * scope is deliberately unused, as it was before: this screen answers no question about other people.
 * `requireModule` is NOT in that pattern and cannot substitute for it (app/admin/toil/page.tsx says the
 * same thing in its own words).
 *
 * No read, no action, no form, no client component. This round creates, deletes and recomputes zero
 * attendance rows and touches no backend, no table and no calculation.
 */
export default async function MyAttendanceRecordsPage() {
  const t = await getTranslations('attendance');
  // The courtesy redirect for a tenant that has not bought the module (ADR-0077 slice 4). Kept even
  // though the page now reads nothing: the row is still in the attendance pack's nav, so a tenant
  // without the module must still be sent away rather than shown an attendance-menu screen.
  await requireModule('attendance');
  await scopedSession();

  // `myRecords.title` reads "Attendance Overview" in all six catalogues as of this round. The KEY was
  // kept and only its value changed — the house pattern written down at lib/permissions.ts for the
  // nav.attendance relabel, because a key may back stored role configuration and renaming it would churn
  // the pack nav row, the permissions row and four test files for no gain.
  return (
    <div className={pageWideCls}>
      <PageHeader title={t('myRecords.title')} />
    </div>
  );
}
