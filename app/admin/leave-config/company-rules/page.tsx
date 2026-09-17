import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { getEncashmentPolicies } from '@/core/leave-encashment';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import Link from 'next/link';
import {
  LeaveConfigMap,
  leaveConfigPageHeader,
  leaveConfigScreenHref,
  leaveConfigScreenTitle,
} from '@/components/leave-config-map';
import { setLeaveEncashmentPolicyAction } from '../../actions';

/**
 * a6fe37fc ROUND 3 — COMPANY RULES (`/admin/leave-config/company-rules`).
 *
 * ⚠️ THIS IS THE ONE GENUINELY NEW DESTINATION IN THE WHOLE REDESIGN (IA §2.0.3). Nine of the ten new
 * screens answer a question one of today's screens already answers. This one does not exist today at
 * all: four settings that belong to a COMPANY or to the TENANT are currently spread across three screens
 * and one step inside every leave type, and the reason they are there is that that is where the code
 * grew — not what they are about. Gathered here, in the order an administrator meets them:
 *
 *   · F4 / F26 — company-wide HALF-DAY FULL DEDUCTION. Today it is drawn inside the Condition step of
 *     EVERY leave type: twenty-five identical copies of one company decision, so an administrator who
 *     changes it on Annual Leave has no way of knowing it also changed on the other twenty-four. Drawn
 *     ONCE here (`app/admin/leave/entitlements/page.tsx` composes it as `halfDaySection` and passes it
 *     into the panel — this page composes the same card from the same action and the same picker).
 *   · F40 — per-company LEAVE ENCASHMENT policy, today on Payroll impact beside a per-LEAVE-TYPE control
 *     that has nothing to do with it (F39, which went onto the leave type itself in Round 2).
 *   · F3 — tenant-wide SHARED LEAVE GROUPS, today at the foot of the Leave types screen, where it reads
 *     as a property of the leave type you happen to have selected. It is not: a group spans several
 *     types, which is why r88 took it out of Benefit Schemes in the first place.
 *   · F38 — per-company REPLACEMENT LEAVE (TOIL) policy: accrual, eligibility, expiry.
 *
 * ⚠️ THE ROUND 5 CUTOVER REACHED THIS SCREEN IN THREE COMMITS, BECAUSE IT ABSORBS THREE SURFACES, AND
 * IT IS COMPLETE. Replacement leave and Payroll Related are redirect stubs pointing here, and the two
 * blocks that used to sit on the Leave types screen (half-day full deduction, shared leave groups) are
 * here rather than there. Every one of the four settings has exactly ONE editor, and it is this page:
 * `LEAVE_REPLACEMENT` and the new `COMPANY_RULES` constant (app/admin/_redirects.ts) both name this
 * address, so a save returns to the screen the change was made on. `introTwoEditors` — the paragraph that
 * told the administrator each setting was still editable on its old screen — was TRUE for exactly three
 * commits and came off with the last of them, along with its key in all six locales: an obsolete
 * reassurance is worse than none, because it teaches the reader the screen is provisional.
 *
 * NOTHING IS STORED TWICE, AND NOTHING EVER WAS. Every control below posts the SAME server action, with
 * the SAME field names, writing the SAME column the old surface wrote. Through Rounds 3–4 that meant two
 * editors over one record — the deliberate price of "something works at every point" — and the cutover
 * closed it: one editor, one record.
 *
 * ⚠️ NO NEW SERVER ACTION AND NO CHANGED SIGNATURE (Round 2's rule 2, still in force). What Round 5
 * changes is only where those actions RETURN: `LEAVE_REPLACEMENT` names this page now, and the
 * half-day / shared-group / encashment constants follow in their own screens' commits. The shared
 * `LeaveConfigPreviewNote` came off here in the same commit and the file was deleted with it — this was
 * its last mount, and a screen the menu points at telling the administrator it is a preview is worse
 * than no note at all.
 *
 * ⚠️ NO MIGRATION, AND NONE IS NEEDED. Four existing columns/tables, read and written exactly as today:
 * `company.leave_half_day_full_deduction`, the encashment policy row, `leave_shared_group`, and the TOIL
 * policy row. If this screen had needed a column it would have stopped and said so.
 *
 * ⚠️ 3fb1a611 (r299) — F38, THE REPLACEMENT LEAVE (TOIL) POLICY, LEFT THIS SCREEN ENTIRELY. It is not
 * re-gated here and it is not hidden: the form, its company picker, its eight eligibility pickers, its banners
 * and its footnote now live on Leave Config › Leave Credit's Rules tab
 * (`app/admin/leave-config/leave-credit/page.tsx`), beside the credits those rules produce. The setting the
 * reporter asked to remove from Company rules (8a494721) STAYS removed from Company rules; what the Leave
 * Credit item built is the process that should take its place, on its own screen. What is left here is the
 * encashment policy, one row per company.
 *
 * SERVER COMPONENT, with no client island left on it: the half-day picker, the shared-group editor, the
 * replacement-eligibility pickers and the company filter all moved to their own screens with their cards.
 * The rule that went with them still applies wherever they are: only serialisable props cross the boundary,
 * never `t` or a closure (r123; test/server-client-boundary.test.ts pins the class).
 */
export default async function LeaveConfigCompanyRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const tPage = await getTranslations('admin.leaveConfigCompanyRules');
  const { error } = await searchParams;

  /**
   * 3fb1a611 (r299) — THE REPLACEMENT LEAVE SECTION, ITS COMPANY PICKER AND ITS `accrualLive` GATE ARE GONE
   * FROM THIS PAGE, not re-gated. Two notes stood here and both are kept in substance where they now apply:
   *
   *  · 1cf5b37c / r281 (8a494721) — "a notice above a live form is not a gate". The section was gated on the
   *    `toil` entitlement so an account without the add-on was not shown configuration it could never use.
   *    The Leave Credit screen is gated the same way, and setToilPolicy checks the entitlement in the service
   *    again (it had been removed by 1cf5b37c).
   *  · 20e759a0 — `?company=` narrowed ONLY the replacement-leave section (180 controls across nine
   *    companies). It moved with that section to the Rules tab; the encashment list below was always one row
   *    per company and never used it.
   *
   * ⚠️ AND THE SETTLEMENT SWEEPS ARE STILL NOT BEHIND A CONFIGURATION GATE: they are on Leave Credit's Credits
   * tab, which opens in a read-only wind-down view when the module lapses with credits outstanding.
   */
  const companies = await listCompanies(s);
  const encashmentPolicies = await getEncashmentPolicies(s);
  const encashmentByCompany = new Map(encashmentPolicies.map((p) => [p.companyId, p]));

  const whoQualifiesTarget = await leaveConfigScreenTitle('leaveTypes');
  const payrollTitle = await leaveConfigScreenTitle('payrollImpact');

  return (
    <div className="space-y-6">
      <PageHeader
        // 10b59703 — the heading is the submenu ROW's label, like every Leave Config page; here the row
        // and the old screen title happen to be the same words. Content unchanged.
        title={(await leaveConfigPageHeader('companyRules')).title}
        description={tPage('pageDescription')}
      />
      {/* The area map. `current="companyRules"` — and at the Round 5 cutover this id GAINED its map
          entry, one line, which is what carrying the id from Round 3 bought: an addition rather than a
          rename of a screen the customer had already learned. */}
      <LeaveConfigMap current="companyRules" />

      <ErrorBanner message={error} />

      <Card>
        <div className="space-y-2 p-4 text-sm">
          <p className="text-muted-foreground">{tPage('intro')}</p>
          {/* 10b59703 / r270 (995387c6) — this page only POINTS at eligibility and never hosts it; the target
              is resolved through the map so this page and the submenu cannot disagree about where it is.
              test/r266-leave-config-rows.test.ts pins it. */}
          <p className="text-muted-foreground">
            {tPage('whoQualifies')}{' '}
            <Link href={leaveConfigScreenHref('leaveTypes')} className="font-medium text-primary hover:underline">
              {whoQualifiesTarget} →
            </Link>
          </p>
        </div>
      </Card>

      {/* r281 (a73d1e14) — THE HALF-DAY FULL DEDUCTION CARD STOOD HERE and is DELIBERATELY GONE, not
          copied: it is the whole of the Special Setting row now. ONE EDITOR, still. */}

      {/* ── F40 · Leave encashment policy ──────────────────────────────────────────────────────────────
          ADR-0069: one row per company. Eligible leave (Annual only) and the rounding rule are fixed text
          per the request, not editable controls. `data-tour="leave-encashment"` is the anchor the old
          Payroll impact card carries; carrying it means Round 5 repoints a route string rather than
          leaving a tour step that silently finds nothing. */}
      <Card data-tour="leave-encashment">
        {/* The heading is the string the MENU used to show for the screen this section absorbs. The
            `payrollImpact` id outlived its map entry for this: an administrator who knew the setting as
            "Payroll impact" finds the same words here. */}
        <SectionHeader title={payrollTitle} count={companies.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('encashmentHelp')}</p>
        <ul className="divide-y divide-border">
          {companies.map((c) => {
            const pol = encashmentByCompany.get(c.id);
            return (
              <li key={c.id} className="px-4 py-3">
                <form action={setLeaveEncashmentPolicyAction} className="flex flex-wrap items-center gap-4">
                  {/* Self-contained: the company id plus BOTH switches, every time. Both are read by
                      presence (`fd.get('x') === 'on'`), so a form that dropped one would not fail to save
                      — it would save the missing box as OFF. */}
                  <input type="hidden" name="companyId" value={c.id} />
                  <span className="min-w-[10rem] flex-1 truncate text-sm font-medium text-foreground">
                    {c.name}
                  </span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" name="enabled" defaultChecked={pol?.enabled ?? false} className="size-3.5" />
                    {t('encashmentEnabled')}
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" name="autoFreeze" defaultChecked={pol?.autoFreeze ?? true} className="size-3.5" />
                    {t('encashmentAutoFreeze')}
                  </label>
                  <Button type="submit" size="sm" variant="secondary">
                    {t('encashmentSave')}
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
        <div className="grid gap-1 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <p>{t('encashmentEligibleTypesFixed')}</p>
          <p>{t('encashmentRoundingFixed')}</p>
        </div>
      </Card>

      {/* r281 (cdd7500b) — THE SHARED LEAVE GROUPS CARD STOOD HERE and is DELIBERATELY GONE, not
          copied. The reporter asked for it on the Leave types screen, because a shared group is about
          leave types — and they are right about that. The reason it was taken OFF that screen was never
          that it belonged elsewhere in principle: it was that it sat INSIDE the per-leave-type workspace,
          beside Add Leave Type, where it read as a property of whichever type happened to be selected,
          while a group spans several. That reasoning is not reversed here, it is honoured: the card is
          mounted at PAGE level on the Leave types screen, above the per-type workspace and outside it, so
          it still reads as what it is. The whole argument is written down at the new site.
          The three actions moved with it unchanged and their return address moved with them, so a save
          lands on the screen the change was made on rather than on this one. */}

      {/* ── F38 · Replacement leave (TOIL) policy — 3fb1a611 (r299): MOVED to Leave Config › Leave Credit's
          Rules tab, with its company picker, banners and footnote. Not re-gated here: the setting the
          reporter asked to remove from Company rules (8a494721) stays removed from Company rules. */}
    </div>
  );
}
