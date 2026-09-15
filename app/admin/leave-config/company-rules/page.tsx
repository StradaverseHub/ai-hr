import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { ALL_COMPANIES, resolveCompanyFilter } from '@/lib/company-filter';
import { listCompanies, listDepartments, listEmployees, listJobGrades } from '@/core/read';
import { listPositions } from '@/core/admin';
import { listAllProfileOptions } from '@/core/profile-options';
import { getEncashmentPolicies } from '@/core/leave-encashment';
import { listToilPolicies } from '@/packs/leave/service';
import { REPLACEMENT_ELIGIBILITY_CRITERIA } from '@/core/replacement-eligibility';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { CompanyFilterSelect } from '@/components/company-filter-select';
import { ReplacementEligibilityPicker } from '@/components/replacement-eligibility-picker';
import Link from 'next/link';
import {
  LeaveConfigMap,
  leaveConfigPageHeader,
  leaveConfigScreenHref,
  leaveConfigScreenTitle,
} from '@/components/leave-config-map';
import { setLeaveEncashmentPolicyAction, setToilPolicyAction } from '../../actions';

/** Not exported: Next refuses unknown exports from a page module. The company picker's hrefs are built
 *  here on the server, so the choice rides in the address bar and the page stays a server render. */
const PAGE = '/admin/leave-config/company-rules';

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
 * SERVER COMPONENT. The three client islands — `HalfDayCompanyPicker`, `LeaveSharedGroupConfig`,
 * `ReplacementEligibilityPicker`, plus `CompanyFilterSelect` — receive ONLY serialisable props: option
 * arrays, pre-built hrefs and plain already-translated strings. No `t` and no closure crosses the
 * boundary. r123 took a production tab down doing exactly that with the half-day picker, which is why
 * that wrapper component exists at all; test/server-client-boundary.test.ts pins the class.
 */
export default async function LeaveConfigCompanyRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; warning?: string; saved?: string; company?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const tr = await getTranslations('admin.replacementLeave');
  const tPage = await getTranslations('admin.leaveConfigCompanyRules');
  const { error, warning, saved, company } = await searchParams;

  // 1cf5b37c — TWO QUESTIONS, NOT ONE, and this page carries the distinction verbatim rather than
  // re-deriving it. `accrualLive` is whether replacement leave actually BANKS days for this tenant (the
  // `toil` entitlement, enforced inside core/toil.ts on every accrual path). Whether an admin may EDIT
  // these settings is always yes: saving writes configuration and cannot cause an accrual.
  const accrualLive = isModuleEnabledOrFalse(s, 'toil');

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const visibleIds = visible.map((c) => c.id);

  // 20e759a0 — `?company=`. `all` keeps the stacked view; a known id narrows to that one; anything else
  // (absent, junk, a bookmark held after the company was archived) falls back to the first visible
  // company. It narrows the REPLACEMENT LEAVE section only: with nine companies that section alone is
  // 180 controls, which is the complaint 20e759a0 answered. The encashment list is one row per company
  // and stays whole.
  //
  // WHY A QUERY PARAMETER AND NOT THE `company_scope` COOKIE: `getScopeIds` is GLOBAL. Narrowing this
  // page by writing that cookie would silently re-scope Roster, Payroll and every other screen. The
  // cookie stays the OUTER bound (`visible` is companies ∩ scopeIds) and the dropdown picks one inside it.
  const selected = resolveCompanyFilter(company, visibleIds);
  const shown = selected === ALL_COMPANIES ? visible : visible.filter((c) => c.id === selected);
  const shownIds = shown.map((c) => c.id);

  // r281 (a73d1e14) — THE `adminOnly` COMPANY READ LEFT THIS PAGE WITH THE HALF-DAY CARD, and the note
  // that explained it went with it rather than being deleted. The narrow WRITE scope is a property of
  // that control — the company UPDATE policy is admin-for-company, so offering a wider list would let an
  // administrator tick a company whose row the write then refuses — so the reasoning is written down
  // beside the control, on the Special Setting screen. Nothing left on this page reads a company list
  // narrower than the page's own.
  // r281 (cdd7500b) — THE SHARED-GROUP READ AND THE ACTIVE LEAVE-TYPE LIST LEFT WITH THE CARD. The
  // Leave types screen already reads every leave type for its own workspace, so the list is narrowed to
  // the active ones there rather than read a second time — "active leave types" derived twice is the
  // drift this repo keeps paying for.
  const [encashmentPolicies, policies] = await Promise.all([
    getEncashmentPolicies(s),
    listToilPolicies(s, shownIds),
  ]);
  const encashmentByCompany = new Map(encashmentPolicies.map((p) => [p.companyId, p]));
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));

  // The eight replacement-eligibility pickers' option lists. Loaded ONCE for the whole page rather than
  // per company card: the catalogues are tenant-wide (grades, profile options) or already company-filtered
  // by the scope above, and a group with six companies would otherwise run the same six reads six times.
  const [departments, positions, grades, employees, profileOptions] = await Promise.all([
    listDepartments(s, { companyIds: shownIds }),
    listPositions(s, { companyIds: shownIds }),
    listJobGrades(s),
    listEmployees(s, shownIds),
    listAllProfileOptions(s, { activeOnly: true }),
  ]);

  // Employment type is the one dimension with NO master table — it is a four-value enum column on the
  // effective-dated assignment row (db/schema.ts employmentTypeEnum), so its options are a literal list
  // rather than a catalogue read. Labels are keyed statically (not `tr(\`empType_${v}\`)`) so the i18n
  // coverage scan can see them.
  const employmentTypeOptions = [
    { id: 'full_time', name: tr('empTypeFullTime') },
    { id: 'part_time', name: tr('empTypePartTime') },
    { id: 'contract', name: tr('empTypeContract') },
    { id: 'intern', name: tr('empTypeIntern') },
  ];

  const eligibilityOptions: Record<string, { id: string; name: string }[]> = {
    // `visible`, NOT `shown`, and deliberately so (20e759a0). This criterion answers "who may SUBMIT a
    // replacement-leave request", which is a different question from "which company am I configuring".
    // Narrowing it with the page filter would quietly delete the ability to name another in-scope company
    // as eligible — and would silently drop that company from the criterion on the next save.
    companyIds: visible.map((c) => ({ id: c.id, name: c.name })),
    employmentTypes: employmentTypeOptions,
    departmentIds: departments.map((d) => ({ id: d.id, name: d.name })),
    divisions: (profileOptions.division ?? []).map((o) => ({ id: o.value, name: o.label })),
    positionIds: positions.map((p) => ({ id: p.id, name: p.title })),
    gradeIds: grades.map((g) => ({ id: g.id, name: g.name || g.code })),
    employmentCategories: (profileOptions.category ?? []).map((o) => ({ id: o.value, name: o.label })),
    employmentIds: employees.map((e) => ({ id: e.employmentId, name: e.name })),
  };

  // The descriptor is resolved to plain {key,label} data HERE, on the server: it keeps drizzle/db-schema
  // out of the client bundle, and it keeps core/replacement-eligibility (a leave-pack boundary module)
  // out of components/, which the ADR-0080 ratchet would otherwise flag as drift.
  const criteria = REPLACEMENT_ELIGIBILITY_CRITERIA.map((c) => ({ key: c.key, label: tr(c.labelKey) }));
  const pickerLabels = {
    all: tr('pickerAll'),
    search: tr('pickerSearch'),
    selectAll: tr('pickerSelectAll'),
    clearAll: tr('pickerClearAll'),
    // `.raw`, NOT `tr(...)`, and this is load-bearing. The placeholder must survive to the client, which
    // substitutes the live count as the selection changes — there is no number to resolve here. next-intl
    // REFUSES to format a message whose ICU variable was not supplied: `tr('pickerSelectedCount')` throws
    // FORMATTING_ERROR at render. Caught by render-verify, not by tsc, the build or the suite.
    selectedCountTemplate: tr.raw('pickerSelectedCount') as string,
  };

  // Every href is built here, on the server, so the choice lands in the address bar and a copied link
  // opens on the same company. Switching company deliberately DROPS `saved`/`warning`/`error`: those
  // banners describe the save you just made to the company you are leaving.
  const companyHref = (v: string) => `${PAGE}?company=${encodeURIComponent(v)}`;
  // Resolved ONCE, here: the per-company cards below are rendered from a synchronous `.map`, and the
  // heading is the SAME string the map shows for the screen this section absorbs (IA §2.0 — Replacement
  // leave's address becomes a stub pointing at THIS page).
  /**
   * r270 (995387c6) — THE CAPTION IS THE MAP'S OWN NAME FOR THE TARGET, not a second spelling of it.
   *
   * The pointer below used to be captioned from this page's own `whoQualifiesLink` ("Open Entitlement
   * tables") because that is where it went. Moving the href without moving the caption would have left a
   * control that says one thing and does another — precisely the class of defect this round exists to
   * remove, arriving by the fix's own door. Reading the label from `leaveConfigScreenTitle` is the same
   * argument the href already follows (`leaveConfigScreenHref`): one map, so the page, the caption and
   * the submenu cannot disagree about where a screen is or what it is called. The Replacement leave and
   * Payroll impact pointers on this page are captioned the same way, so this is the page's own idiom.
   */
  const whoQualifiesTarget = await leaveConfigScreenTitle('leaveTypes');
  const replacementTitle = await leaveConfigScreenTitle('replacementLeave');
  const payrollTitle = await leaveConfigScreenTitle('payrollImpact');
  const companyOptions = [
    { value: ALL_COMPANIES, label: tr('companyFilterAll'), href: companyHref(ALL_COMPANIES) },
    ...visible.map((c) => ({ value: c.id, label: c.name, href: companyHref(c.id) })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        // 10b59703 — the heading is the submenu ROW's label, like every Leave Config page; here the row
        // and the old screen title happen to be the same words. Content unchanged.
        title={(await leaveConfigPageHeader('companyRules')).title}
        description={tPage('pageDescription')}
        actions={
          visible.length > 0 ? (
            <CompanyFilterSelect
              id="company-rules-company-filter"
              label={tr('companyFilterLabel')}
              value={selected ?? ALL_COMPANIES}
              options={companyOptions}
            />
          ) : undefined
        }
      />
      {/* The area map. `current="companyRules"` — and at the Round 5 cutover this id GAINED its map
          entry, one line, which is what carrying the id from Round 3 bought: an addition rather than a
          rename of a screen the customer had already learned. */}
      <LeaveConfigMap current="companyRules" />

      <ErrorBanner message={error} />
      {/* ⚠️ THESE THREE BANNERS ARE LIVE AS OF THE ROUND 5 CUTOVER, AND THAT IS THE WHOLE POINT OF
          HAVING SHIPPED THEM DARK. `setToilPolicyAction` returns through the `LEAVE_REPLACEMENT` module
          constant, which was repointed at THIS page in the same commit that emptied the old Replacement
          leave screen, so `?saved=` / `?warning=` / `?error=` now arrive here.

          `warning=` is the Phase-B #14 premium-equivalent BANKING-RISK warning. It was produced on every
          qualifying save for months and silently dropped, because the screen it landed on never read the
          param. Shipping the screen that ABSORBS Replacement leave without the banner would have set that
          up to happen a second time at exactly this cutover — which is why they were built here, unread,
          a round early, and why re-reading this page with each of the three params is part of the
          cutover's own verification rather than a nicety. */}
      {saved !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {tr('savedBanner')}
        </div>
      )}
      {warning && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {warning}
        </div>
      )}

      <Card>
        <div className="space-y-2 p-4 text-sm">
          <p className="text-muted-foreground">{tPage('intro')}</p>
          {/* 10b59703 — the reporter's tree put eligibility rules under Company rules. They stay under
              Entitlements (a benefit scheme names one entitlement table of one leave type; splitting the
              two across pages is the "who qualifies is answered in three places" defect IA §1.2(e) just
              removed), and this page says so with a plain pointer, resolved through the map.

              r270 (995387c6) — THE POINTER MOVED WITH THE SECTION IT POINTS AT. It named the Entitlement
              tables tab, which until this round mounted the Benefit schemes card as well; that duplicate
              copy is gone and the schemes now live only inside each leave type's Entitlements tab on
              Leave types. The pointer's PROPERTY is unchanged — "who receives which entitlement table is
              set under Entitlements, and here is the way in" — so the target moves rather than the
              sentence. Still resolved through the map, so this page and the submenu cannot disagree about
              where the screen is. `test/r266-leave-config-rows.test.ts` pins it and was UPDATED, not
              deleted: the property it guards is that this page only POINTS at eligibility and never hosts
              it, which this change narrows rather than weakens. */}
          <p className="text-muted-foreground">
            {tPage('whoQualifies')}{' '}
            <Link href={leaveConfigScreenHref('leaveTypes')} className="font-medium text-primary hover:underline">
              {whoQualifiesTarget} →
            </Link>
          </p>
        </div>
      </Card>

      {/* r281 (a73d1e14) — THE HALF-DAY FULL DEDUCTION CARD STOOD HERE and is DELIBERATELY GONE, not
          copied: the reporter asked for it under a heading of its own that a second setting of the same
          kind can later join, so it is the whole of the Special Setting row now (the last row of the
          fly-out). ONE EDITOR, still — leaving a copy here would be two screens writing one column, which
          is the duplication this page was built to end rather than to start. Its server action's return
          address moved with it in the same commit, so a save lands on the screen the change was made on
          rather than on this one. */}

      {/* ── F40 · Leave encashment policy ──────────────────────────────────────────────────────────────
          ADR-0069: one row per company. Eligible leave (Annual only) and the rounding rule are fixed text
          per the request, not editable controls. `data-tour="leave-encashment"` is the anchor the old
          Payroll impact card carries; carrying it means Round 5 repoints a route string rather than
          leaving a tour step that silently finds nothing. */}
      <Card data-tour="leave-encashment">
        {/* The heading is the string the MENU used to show for the screen this section absorbs, exactly
            as the Replacement leave section above uses `leaveConfigScreenTitle('replacementLeave')`. The
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

      {/* ── F38 · Replacement leave (TOIL) policy ──────────────────────────────────────────────────────
          Per company, one card each, narrowed by the header's company picker. WHAT DELIBERATELY DID NOT
          COME WITH IT: the running balance LEDGER and the two settlement sweeps stay on /admin/toil.
          Those sweeps are NOT entitlement-gated — a tenant whose `toil` module lapses still owes its
          employees the days they already banked, and for a First-Schedule-eligible employee that debt is
          statutory. Configuration and settlement are gated differently on purpose, so they live on
          different screens; pulling the sweeps behind a configuration screen would quietly re-gate them. */}
      {!accrualLive && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {tr('moduleOff')}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('noCompanies')}</p>
      ) : (
        shown.map((c) => {
          const p = byCompany.get(c.id);
          if (!p) return null;
          const elig = p.requestEligibility ?? {};
          const defaultSelected: Record<string, string[]> = Object.fromEntries(
            REPLACEMENT_ELIGIBILITY_CRITERIA.map((k) => [k.key, elig[k.key] ?? []]),
          );
          return (
            <Card key={c.id}>
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {replacementTitle} · {c.name}
                </h2>
                <span
                  className={
                    p.enabled
                      ? 'rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                      : 'rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
                  }
                >
                  {p.enabled ? tr('on') : tr('off')}
                </span>
              </div>
              <form action={setToilPolicyAction} className="space-y-5 p-4">
                {/* ⚠️ EVERY FIELD BELOW IS POSTED ON EVERY SAVE, and that is the whole contract of this
                    form. `setToilPolicy` reads each key with a DEFAULT (`fd.get('expiryDays') ?? 90`,
                    `fd.get('enabled') === 'on'`), so a field dropped from this form does not fail to save
                    — it silently writes the default over whatever the company had. This form is the
                    absolute-set kind, not the tri-state kind: there is no marker to omit and therefore no
                    marker to protect it. */}
                <input type="hidden" name="companyId" value={c.id} />

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="enabled" defaultChecked={p.enabled} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('enabledLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('enabledHint')}</span>
                  </span>
                </label>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={tr('accrualBasis')}>
                    <select name="accrualBasis" defaultValue={p.accrualBasis} className={inputCls}>
                      <option value="hours_worked">{tr('basisHoursWorked')}</option>
                      <option value="premium_equivalent">{tr('basisPremiumEquivalent')}</option>
                    </select>
                  </Field>
                  <Field label={tr('onExpiry')}>
                    <select name="onExpiry" defaultValue={p.onExpiry} className={inputCls}>
                      <option value="convert_to_pay">{tr('expiryConvertToPay')}</option>
                      <option value="lapse">{tr('expiryLapse')}</option>
                    </select>
                  </Field>
                </div>

                {/* The expiry period: a NUMBER plus a UNIT. BOTH counts are posted every time and stored
                    in their own columns, so switching the unit and switching back does not lose the other
                    count. core/toil.ts `resolveExpiry` is the only thing that reads the trio. */}
                <div>
                  <SectionHeader title={tr('expiryTitle')} />
                  <div className="grid grid-cols-1 gap-3 px-0 pt-3 sm:grid-cols-3">
                    <Field label={tr('expiryUnit')}>
                      <select name="expiryUnit" defaultValue={p.expiryUnit} className={inputCls}>
                        <option value="days">{tr('expiryUnitDays')}</option>
                        <option value="months">{tr('expiryUnitMonths')}</option>
                      </select>
                    </Field>
                    <Field label={tr('expiryDays')}>
                      <input type="number" name="expiryDays" min={1} max={730} required defaultValue={p.expiryDays} className={inputCls} />
                    </Field>
                    <Field label={tr('expiryMonths')}>
                      <input type="number" name="expiryMonths" min={1} max={24} required defaultValue={p.expiryMonths} className={inputCls} />
                    </Field>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">{tr('expiryHint')}</p>
                </div>

                {/* Replacement Leave From — RECORDED ONLY, AND THE PAGE SAYS SO. Nothing validates against
                    this setting: no attendance, timesheet or overtime figure is checked against it. Saying
                    so on screen is the difference between a recorded intention and a promise the system
                    does not keep. */}
                <div>
                  <Field label={tr('leaveFrom')}>
                    <select name="replacementLeaveFrom" defaultValue={p.replacementLeaveFrom} className={inputCls}>
                      <option value="working_hours">{tr('leaveFromWorkingHours')}</option>
                      <option value="overtime">{tr('leaveFromOvertime')}</option>
                      <option value="working_hours_and_overtime">{tr('leaveFromBoth')}</option>
                    </select>
                  </Field>
                  <p className="mt-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {tr('leaveFromRecordedOnly')}
                  </p>
                </div>

                <label className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-500/25 dark:bg-amber-500/5">
                  <input
                    type="checkbox"
                    name="allowFirstScheduleEligible"
                    defaultChecked={p.allowFirstScheduleEligible}
                    className="mt-0.5 h-4 w-4 accent-amber-600 disabled:opacity-60"
                  />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('allowEligibleLabel')}</span>
                    <span className="block text-xs text-amber-700/90 dark:text-amber-300/80">{tr('allowEligibleHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="autoAccrueOnApproval" defaultChecked={p.autoAccrueOnApproval} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('autoAccrueLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('autoAccrueHint')}</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <input type="checkbox" name="carryForwardAtYearEnd" defaultChecked={p.carryForwardAtYearEnd} className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60" />
                  <span>
                    <span className="text-sm font-medium text-foreground">{tr('carryForwardLabel')}</span>
                    <span className="block text-xs text-muted-foreground">{tr('carryForwardHint')}</span>
                  </span>
                </label>

                {/* Employee-submitted requests + who may submit. The switch is enforced in the SERVICE
                    (assertEmployeeMaySubmit), not here: hiding the button is a courtesy, refusing the
                    submission is the control. */}
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <label className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      name="employeeRequestEnabled"
                      defaultChecked={p.employeeRequestEnabled}
                      className="mt-0.5 h-4 w-4 accent-primary disabled:opacity-60"
                    />
                    <span>
                      <span className="text-sm font-medium text-foreground">{tr('employeeRequestLabel')}</span>
                      <span className="block text-xs text-muted-foreground">{tr('employeeRequestHint')}</span>
                    </span>
                  </label>
                  <div>
                    <p className="text-sm font-medium text-foreground">{tr('eligibilityTitle')}</p>
                    <p className="mb-3 mt-0.5 text-xs text-muted-foreground">{tr('eligibilityHint')}</p>
                    <ReplacementEligibilityPicker
                      criteria={criteria}
                      options={eligibilityOptions}
                      defaultSelected={defaultSelected}
                      labels={pickerLabels}
                    />
                  </div>
                </div>

                <button className={btnPrimary}>{tr('save')}</button>
              </form>
            </Card>
          );
        })
      )}

      <p className="px-1 text-xs text-muted-foreground">{tr('footnote')}</p>
    </div>
  );
}
