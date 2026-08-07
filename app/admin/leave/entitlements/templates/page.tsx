import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listLocations } from '@/core/location';
import { listAllProfileOptions } from '@/core/profile-options';
import { buildOrgCriteriaSections } from '@/core/org-criteria-form';
import {
  eligibilityRuleCountsByTemplate,
  listEligibilityRules,
  listEntitlementTemplates,
  MAX_SERVICE_BANDS,
} from '@/packs/leave/service';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { EntitlementBandsEditor, type EditableBand } from '@/components/leave/entitlement-bands-editor';
import { EligibilityRuleForm } from '@/components/leave/eligibility-rule-form';
import { todayInKualaLumpur } from '@/lib/hr-date';
// 4a1abc4a — the Entitlement Table is where day figures are TYPED, so it is the one screen where the
// summary line and the editor cell beside it must agree digit for digit.
import { DAY_DASH, formatDayInput, formatDays } from '@/lib/day-format';
import {
  countEligibilityTargetsAction,
  createEligibilityRuleAction,
  createEntitlementTemplateAction,
  retireEligibilityRuleAction,
  retireEntitlementTemplateAction,
  updateEligibilityRuleAction,
  updateEntitlementTemplateAction,
} from './actions';

/**
 * 6e9a126e RELEASE TWO — ENTITLEMENT TABLES + EMPLOYEE ELIGIBILITY. The reporter's two steps, one screen.
 *
 *     Leave Type  →  Entitlement Template  →  Employee Eligibility
 *
 * Step 1: a named day table with the operator's OWN service ranges, replacing the hardcoded <2y / 2-5y /
 * 5y+ bands and the 292 private copies of the same table inside 41 Benefit Schemes.
 * Step 2: who gets which table, through the SHARED criteria vocabulary (`core/org-criteria.ts`) that the
 * Notice Board and Leave Adjustments already narrow by — not a third matcher.
 *
 * ⚠️ WHY IT LANDS IN RELEASE TWO AND NOT RELEASE ONE. Release one built the storage and the resolver and
 * deliberately shipped NO editor: HR would have typed a table, watched it save, and seen no figure move,
 * because no engine read it. This release re-points every granting engine, the projection kernel and the
 * three past-date readers at that layer — so the tables typed here now decide days, and the screen has
 * meaning the moment it appears.
 *
 * ⚠️ NOTHING OLD IS REMOVED, AND THIS SCREEN DOES NOT PRETEND OTHERWISE. Benefit Schemes and the company /
 * grade entitlement rules are still live and still resolve; a template SUPERSEDES them for the employees a
 * rule matches, and everyone else is unaffected. The clearing is release three and the reporter's own
 * decision. The `intro` copy says exactly that rather than implying a migration has happened.
 *
 * SERVER COMPONENT. Everything interactive is in the two client components, which receive only
 * serialisable props — r123 took a production tab down by handing a translator closure across that
 * boundary and `test/server-client-boundary.test.ts` pins the class. The server actions are the exception
 * the framework allows (the `countEmployeesInScopeAction` precedent on the Entitlements page).
 */
export default async function EntitlementTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; editTemplate?: string; editRule?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.entitlementTemplates');
  // The criteria vocabulary's three label namespaces, read where they already live rather than re-minted.
  // r127 shipped a screen whose chips all rendered through MISSING_MESSAGE behind a green 200 by inventing
  // a seventh copy of labels that already existed in six locales.
  const tOrg = await getTranslations('admin.profileOptions.category');
  const tEmploymentType = await getTranslations('people.wizard.employmentType');
  const tCrit = await getTranslations('admin.leave.adjustmentsCriteria');
  const sp = await searchParams;
  const today = todayInKualaLumpur();

  const companies = await listCompanies(s);
  const companyIds = companies.map((c) => c.id);
  const [
    leaveTypes,
    templates,
    rules,
    ruleCounts,
    departments,
    grades,
    positions,
    costCenters,
    businessUnits,
    locations,
    profileOptions,
  ] = await Promise.all([
    listLeaveTypes(s, { includeArchived: false }),
    // EVERY version, not just the running ones: a superseded table is the record of what a closed year was
    // reported against, and the three past-date readers still resolve it. The list marks which is running.
    listEntitlementTemplates(s),
    listEligibilityRules(s),
    eligibilityRuleCountsByTemplate(s, { asOf: today }),
    listDepartments(s),
    listJobGrades(s),
    listPositions(s),
    listCostCenters(s),
    listBusinessUnits(s),
    companyIds.length ? listLocations(s, companyIds) : Promise.resolve([]),
    listAllProfileOptions(s),
  ]);

  const criteriaSections = buildOrgCriteriaSections(
    { companies, departments, grades, positions, costCenters, businessUnits, locations, profileOptions },
    { crit: tCrit, org: tOrg, employmentType: tEmploymentType },
  );

  const typeNameById = new Map(leaveTypes.map((x) => [x.id, x.name]));
  const running = templates.filter((x) => x.validTo == null);
  const runningRules = rules.filter((x) => x.validTo == null);
  const templateOptions = running.map((x) => ({
    value: x.lineageId,
    label: `${x.name} · ${typeNameById.get(x.leaveTypeId) ?? ''}`,
  }));

  const editingTemplate = running.find((x) => x.lineageId === sp.editTemplate);
  const editingRule = runningRules.find((x) => x.lineageId === sp.editRule);

  /** The stored JSONB back into the editor's string cells. An absent optional column stays BLANK, never 0
   *  — a blank box and a typed 0 are different facts everywhere else in this file, and `formatDayInput`
   *  is built around exactly that distinction (4a1abc4a). The three DAY columns open at 2dp so the box
   *  already shows what the on-blur tidier would produce; the YEAR columns are untouched — they count
   *  years of service, and "0.00 years" would say something about that column that is not true. */
  const toEditable = (bands: { fromYears: number; toYears: number | null; days: number; carryForwardDays?: number | null; maxBalanceDays?: number | null }[]): EditableBand[] =>
    bands.map((b) => ({
      fromYears: String(b.fromYears ?? 0),
      toYears: b.toYears == null ? '' : String(b.toYears),
      days: formatDayInput(b.days ?? 0),
      carryForwardDays: formatDayInput(b.carryForwardDays),
      maxBalanceDays: formatDayInput(b.maxBalanceDays),
    }));

  const dash = DAY_DASH;
  /** One band rendered for the read-only list. `t.raw` is not needed here — no braces, plain values.
   *  4a1abc4a: the three day figures print through the shared formatter, so the summary a reader scans
   *  ("0–2: 12.00 (+5.00)") matches the editor they open to change it. The year bounds stay bare. */
  const bandText = (b: { fromYears: number; toYears: number | null; days: number; carryForwardDays?: number | null; maxBalanceDays?: number | null }) =>
    `${b.fromYears}–${b.toYears == null ? t('bandNoLimit') : b.toYears}: ${formatDays(b.days)}` +
    (b.carryForwardDays != null ? ` (+${formatDays(b.carryForwardDays)})` : '') +
    (b.maxBalanceDays != null ? ` ≤${formatDays(b.maxBalanceDays)}` : '');

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={sp.error} />

      <Card>
        <div className="space-y-2 p-4 text-sm">
          <p className="text-muted-foreground">{t('intro')}</p>
          <p className="text-muted-foreground">{t('coexistNote')}</p>
          <p className="text-muted-foreground">{t('datedNote')}</p>
          <Link href="/admin/leave/entitlements" className="inline-block text-sm underline">
            {t('backToEntitlements')}
          </Link>
        </div>
      </Card>

      {/* ── STEP 1: THE NAMED DAY TABLES ────────────────────────────────────────────────────────── */}
      <Card>
        <SectionHeader title={t('templatesTitle')} count={running.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('colName')}</th>
                <th className="px-3 py-2">{t('colLeaveType')}</th>
                <th className="px-3 py-2">{t('colBands')}</th>
                <th className="px-3 py-2">{t('colInForce')}</th>
                <th className="px-3 py-2">{t('colRules')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t('templatesNone')}
                  </td>
                </tr>
              )}
              {templates.map((x) => (
                <tr key={x.id} className="border-t align-top">
                  <td className="px-3 py-2 font-medium">{x.name}</td>
                  <td className="px-3 py-2">{typeNameById.get(x.leaveTypeId) ?? dash}</td>
                  <td className="px-3 py-2 text-xs">
                    {x.serviceBands.map((b, i) => (
                      <span key={i} className="block">
                        {bandText(b)}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {x.validFrom}
                    <span className="block">{x.validTo ?? t('stillRunning')}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{x.validTo == null ? (ruleCounts.get(x.lineageId) ?? 0) : dash}</td>
                  <td className="px-3 py-2 text-right">
                    {x.validTo == null ? (
                      <Link href={`?editTemplate=${encodeURIComponent(x.lineageId)}`} className="text-sm underline">
                        {t('edit')}
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t p-4">
          <h3 className="mb-3 text-sm font-medium">
            {editingTemplate ? t('editTemplateTitle') : t('newTemplateTitle')}
          </h3>
          <form
            action={editingTemplate ? updateEntitlementTemplateAction : createEntitlementTemplateAction}
            className="space-y-4"
          >
            {editingTemplate ? <input type="hidden" name="lineageId" value={editingTemplate.lineageId} /> : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('templateName')}>
                <input className={inputCls} name="name" defaultValue={editingTemplate?.name ?? ''} required />
              </Field>
              <Field label={t('templateLeaveType')}>
                {/* Not editable on an existing lineage: a rule pointing at "the Executive ANNUAL table"
                    that quietly started handing out SICK days is not an edit anybody would spot. */}
                {editingTemplate ? (
                  <input
                    className={inputCls}
                    value={typeNameById.get(editingTemplate.leaveTypeId) ?? ''}
                    readOnly
                    aria-label={t('templateLeaveType')}
                  />
                ) : (
                  <select className={inputCls} name="leaveTypeId" required defaultValue="">
                    <option value="">{t('pickLeaveType')}</option>
                    {leaveTypes.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('effectiveFrom')}>
                <input className={inputCls} type="date" name="validFrom" defaultValue={today} required />
              </Field>
            </div>
            <EntitlementBandsEditor
              initial={editingTemplate ? toEditable(editingTemplate.serviceBands) : []}
              maxBands={MAX_SERVICE_BANDS}
            />
            {/* Stated where it is acted on: an edit does not overwrite, it closes the running version and
                starts a successor. Three readers answer for a past date and only versions can serve them. */}
            <p className="text-xs text-muted-foreground">{t('supersedeNote')}</p>
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className={btnPrimary}>
                {editingTemplate ? t('saveNewVersion') : t('createTemplate')}
              </button>
              {editingTemplate ? (
                <Link href="?" className="text-sm underline">
                  {t('cancel')}
                </Link>
              ) : null}
            </div>
          </form>

          {editingTemplate ? (
            <form action={retireEntitlementTemplateAction} className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
              <input type="hidden" name="lineageId" value={editingTemplate.lineageId} />
              <input type="hidden" name="name" value={editingTemplate.name} />
              <Field label={t('stopFrom')}>
                <input className={inputCls} type="date" name="validTo" defaultValue={today} required />
              </Field>
              <ConfirmSubmit
                variant="outline"
                title={t('stopTemplate')}
                subtitle={editingTemplate.name}
                description={t('stopTemplateConfirm', { rules: ruleCounts.get(editingTemplate.lineageId) ?? 0 })}
              >
                {t('stopTemplate')}
              </ConfirmSubmit>
            </form>
          ) : null}
        </div>
      </Card>

      {/* ── STEP 2: WHO GETS WHICH TABLE ────────────────────────────────────────────────────────── */}
      <Card>
        <SectionHeader title={t('rulesTitle')} count={runningRules.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('colName')}</th>
                <th className="px-3 py-2">{t('colTemplate')}</th>
                <th className="px-3 py-2">{t('colCriteria')}</th>
                <th className="px-3 py-2">{t('colInForce')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t('rulesNone')}
                  </td>
                </tr>
              )}
              {rules.map((x) => {
                const target = running.find((tpl) => tpl.lineageId === x.templateLineageId);
                const axes = Object.entries(x.criteria as Record<string, unknown>).filter(
                  ([, v]) => (Array.isArray(v) ? v.length > 0 : v != null && v !== ''),
                );
                return (
                  <tr key={x.id} className="border-t align-top">
                    <td className="px-3 py-2 font-medium">{x.name}</td>
                    <td className="px-3 py-2">{target?.name ?? dash}</td>
                    {/* An EMPTY criteria object is a real value that means EVERYONE — never a blank cell. */}
                    <td className="px-3 py-2 text-xs">
                      {axes.length === 0
                        ? t('criteriaEveryone')
                        : axes.map(([k, v]) => (
                            <span key={k} className="block">
                              {k}: {Array.isArray(v) ? v.length : String(v)}
                            </span>
                          ))}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {x.validFrom}
                      <span className="block">{x.validTo ?? t('stillRunning')}</span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {x.validTo == null ? (
                        <Link href={`?editRule=${encodeURIComponent(x.lineageId)}`} className="text-sm underline">
                          {t('edit')}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="border-t p-4">
          <h3 className="mb-3 text-sm font-medium">{editingRule ? t('editRuleTitle') : t('newRuleTitle')}</h3>
          {templateOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('rulesNeedTemplate')}</p>
          ) : (
            <>
              <EligibilityRuleForm
                key={editingRule?.lineageId ?? 'new'}
                action={editingRule ? updateEligibilityRuleAction : createEligibilityRuleAction}
                countAction={countEligibilityTargetsAction}
                templates={templateOptions}
                criteriaSections={criteriaSections}
                today={today}
                submitLabel={editingRule ? t('saveNewVersion') : t('createRule')}
                initial={
                  editingRule
                    ? {
                        lineageId: editingRule.lineageId,
                        name: editingRule.name,
                        templateLineageId: editingRule.templateLineageId,
                        validFrom: today,
                        criteria: editingRule.criteria as Record<string, string[] | string>,
                      }
                    : undefined
                }
              />
              {editingRule ? (
                <form action={retireEligibilityRuleAction} className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
                  <input type="hidden" name="lineageId" value={editingRule.lineageId} />
                  <input type="hidden" name="name" value={editingRule.name} />
                  <Field label={t('stopFrom')}>
                    <input className={inputCls} type="date" name="validTo" defaultValue={today} required />
                  </Field>
                  <ConfirmSubmit
                    variant="outline"
                    title={t('stopRule')}
                    subtitle={editingRule.name}
                    description={t('stopRuleConfirm')}
                  >
                    {t('stopRule')}
                  </ConfirmSubmit>
                  <Link href="?" className="text-sm underline">
                    {t('cancel')}
                  </Link>
                </form>
              ) : null}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
