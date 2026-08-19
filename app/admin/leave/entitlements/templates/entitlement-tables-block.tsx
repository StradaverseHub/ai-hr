import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { listLeaveTypes, listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listLocations } from '@/core/location';
import { listAllProfileOptions } from '@/core/profile-options';
import { buildOrgCriteriaSections } from '@/core/org-criteria-form';
import type { CriteriaSection } from '@/core/org-criteria-form';
import type { SessionContext } from '@/db/client';
import {
  eligibilityRuleCountsByTemplate,
  listEligibilityRules,
  listEntitlementTemplates,
  listGradeGroups,
  MAX_SERVICE_BANDS,
  type EligibilityRuleRow,
  type EntitlementTemplateRow,
} from '@/packs/leave/service';
// The grade-group ⇄ job-grade arithmetic, shared with the client rule form so "whole group" cannot come to
// mean two different things on the two halves of this screen.
import { partiallyCoveredGradeGroups, type GradeGroupOption } from '@/lib/grade-group-coverage';
// r209 — the pure "why can this leave type not produce a balance" derivation, and its two renderers. The
// block is where the tables and rules the findings are ABOUT already live, so the notice sits beside them.
import {
  addDaysIso,
  leaveConfigHealthAll,
  leaveTypeConfigHealth,
  RULE_EXPIRY_WARNING_DAYS,
  type HealthLeaveType,
} from '@/lib/leave-config-health';
import { LeaveConfigHealthCard, LeaveConfigHealthNotice } from '@/components/leave/leave-config-health';
import { Card, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { EntitlementBandsEditor, type EditableBand } from '@/components/leave/entitlement-bands-editor';
import { EligibilityRuleForm } from '@/components/leave/eligibility-rule-form';
import { todayInKualaLumpur } from '@/lib/hr-date';
// ee6b7c69 — "which tables and rules are this leave type's", pure and tested on its own.
import { scopeEntitlementTables } from '@/lib/entitlement-tables-scope';
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
 * ee6b7c69 — THE ENTITLEMENT TABLES, DEFINED ONCE AND MOUNTED TWICE.
 *
 * This block is the whole of what used to BE app/admin/leave/entitlements/templates/page.tsx: the named
 * day tables with their create/edit form (the reporter's step 1), and the employee eligibility rules with
 * theirs (step 2). It now has two mount points and exactly one definition:
 *
 *   - `/admin/leave/entitlements/templates` renders it UNFILTERED — every leave type side by side, which
 *     is the screen the header link still leads to and the one release two shipped.
 *   - the Entitlement STEP of each leave type on `/admin/leave/entitlements` renders it filtered to that
 *     panel's own type, which is what ee6b7c69 asked for: entitlement is set where entitlement is
 *     configured, instead of behind an "Open Entitlement tables" link to a second screen.
 *
 * ONE DEFINITION IS THE POINT. Two copies of a create form writing the same effective-dated lineage would
 * drift the first time either was touched, and the drift would be invisible — both would still save.
 *
 * ⚠️ READS HAPPEN ONCE PER PAGE, NOT ONCE PER MOUNT. `loadEntitlementTablesData` is called ONCE by each
 * host page and its result is sliced in memory by `leaveTypeId`. The Entitlements page composes a panel
 * for all 24 leave types up front (they are props of a client workspace, so every one of them is
 * rendered), and eleven queries per panel would be 264 queries for a screen showing one.
 *
 * ⚠️ SERVER COMPONENT. Only `EntitlementBandsEditor` and `EligibilityRuleForm` cross the client boundary,
 * exactly as they did on the standalone page, and both take only serialisable props —
 * `test/server-client-boundary.test.ts` pins the class after r123 took a production tab down with a
 * translator closure. The server actions are the exception the framework allows.
 */

/** Everything both mounts read, loaded once per page. */
export type EntitlementTablesData = {
  /** ARCHIVED TYPES INCLUDED, and the two uses of this list are deliberately different. Naming a type must
   *  work for every template on screen — an archived type still owns the tables it owned, and the embedded
   *  mount is composed for archived panels too, so a name resolved off an active-only list would render
   *  blank there. OFFERING a type in the create picker must not: a new table for an archived type is not a
   *  thing to invite. The picker filters; the name map does not. */
  /** r209 — `accrualMethod` / `accrualUnconfigured` ride along because the health check needs them and this
   *  read already has them. `leave_type.accrual_unconfigured` has been stamped since 2026-08-04 and was read
   *  by NO surface until r209 — that is the defect, not a missing column. */
  leaveTypes: (HealthLeaveType & { archived: boolean })[];
  /** EVERY version, not just the running ones — a superseded table is the record a closed year was
   *  reported against, and the three past-date readers still resolve it. The list marks which is running. */
  templates: EntitlementTemplateRow[];
  rules: EligibilityRuleRow[];
  ruleCounts: Map<string, number>;
  criteriaSections: CriteriaSection[];
  /** ARCHIVED GROUPS INCLUDED, deliberately — `listGradeGroups` returns them with an `archived` flag and
   *  this list is used for two different jobs. The rule form OFFERS them (a saved rule may well have been
   *  built from a group that was archived afterwards, and hiding it would make the rule's own coverage
   *  unexplainable), and the drift check reads their membership. Nothing here creates or edits a group —
   *  that lives on Settings → System Labels → Organisation, beside Job Grades. */
  gradeGroups: GradeGroupOption[];
  /** THE GROUP MEMBERS THE ACTIVE GRADE CATALOGUE NO LONGER OFFERS — name and id, for LABELLING only.
   *
   *  Archiving a job grade does not remove it from the groups that hold it (`grade_group_member` survives;
   *  only a DELETE cascades, and the delete guard refuses while a group holds it). So a group can expand to
   *  a grade `listJobGrades` will not return, and the rule form has to put that id in the Job Grade picker's
   *  options or `ChipMultiSelect` would drop it from the expansion silently — see the form's own note.
   *  Without these names it went in NAKED: the picker showed a bare UUID an operator could tick. This list
   *  adds no option; it only gives the ones already there a name to render. */
  archivedMemberGrades: { id: string; name: string }[];
  /** r209 — the ACTIVE job-grade catalogue, which is the population "a Job Grade belongs to no entitlement
   *  table" is measured against. Read here rather than in the health module because the module is pure. */
  activeGrades: { id: string; name: string }[];
  today: string;
};

/**
 * The twelve reads behind both mounts, plus the criteria vocabulary the rule form renders.
 *
 * Called ONCE per page render. The three label namespaces are read where they already live rather than
 * re-minted: r127 shipped a screen whose chips all rendered through MISSING_MESSAGE behind a green 200 by
 * inventing a seventh copy of labels that already existed in six locales.
 */
export async function loadEntitlementTablesData(s: SessionContext): Promise<EntitlementTablesData> {
  const tOrg = await getTranslations('admin.profileOptions.category');
  const tEmploymentType = await getTranslations('people.wizard.employmentType');
  const tCrit = await getTranslations('admin.leave.adjustmentsCriteria');
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
    gradeGroups,
  ] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listEntitlementTemplates(s),
    listEligibilityRules(s),
    eligibilityRuleCountsByTemplate(s, { asOf: today }),
    listDepartments(s),
    // ARCHIVED GRADES INCLUDED — and the two uses are split apart after the await, exactly as `leaveTypes`
    // splits offering from naming. What the criteria builder OFFERS must stay active-only; what a grade
    // group's expansion can be NAMED from cannot, because a group may hold an archived grade.
    listJobGrades(s, { includeArchived: true }),
    listPositions(s),
    listCostCenters(s),
    listBusinessUnits(s),
    companyIds.length ? listLocations(s, companyIds) : Promise.resolve([]),
    listAllProfileOptions(s),
    // The Grade Group axis of Employee Eligibility. ⚠️ A NAME ADDED TO THE DESTRUCTURE ABOVE MUST BE
    // ADDED HERE IN THE SAME POSITION — a mismatch shifts every later variable by one slot and every
    // side of it is an array, so nothing type-errors and every catalogue silently becomes another one.
    listGradeGroups(s),
  ]);

  // The OFFER is unchanged: the Job Grade criteria field lists the ACTIVE catalogue and nothing else, so
  // no archived grade becomes newly pickable anywhere the shared builder renders.
  const activeGrades = grades.filter((g) => g.archivedAt == null);
  const criteriaSections = buildOrgCriteriaSections(
    { companies, departments, grades: activeGrades, positions, costCenters, businessUnits, locations, profileOptions },
    { crit: tCrit, org: tOrg, employmentType: tEmploymentType },
  );

  // …and the NAMING is what the archived rows are for. Narrowed to grades some group actually holds: those
  // are the only ids the rule form adds to the picker on their behalf, and a name for anything else would
  // be data crossing to a client component for no reader.
  const heldByAGroup = new Set(gradeGroups.flatMap((g) => g.gradeIds));
  const archivedMemberGrades = grades
    .filter((g) => g.archivedAt != null && heldByAGroup.has(g.id))
    .map((g) => ({ id: g.id, name: g.name }));

  return {
    leaveTypes: leaveTypes.map((x) => ({
      id: x.id,
      name: x.name,
      archived: !!x.archivedAt,
      accrualMethod: x.accrualMethod ?? null,
      accrualUnconfigured: x.accrualUnconfigured != null,
    })),
    templates,
    rules,
    ruleCounts,
    criteriaSections,
    // Only the three fields the two consumers need — a `GradeGroupOption` is plain serialisable data, and
    // the rule form is a CLIENT component, so nothing beyond id / name / membership may cross to it.
    gradeGroups: gradeGroups.map((g) => ({ id: g.id, name: g.name, gradeIds: g.gradeIds })),
    archivedMemberGrades,
    activeGrades: activeGrades.map((g) => ({ id: g.id, name: g.name })),
    today,
  };
}

/** The stored JSONB back into the editor's string cells. An absent optional column stays BLANK, never 0
 *  — a blank box and a typed 0 are different facts everywhere else in this file, and `formatDayInput`
 *  is built around exactly that distinction (4a1abc4a). The three DAY columns open at 2dp so the box
 *  already shows what the on-blur tidier would produce; the YEAR columns are untouched — they count
 *  years of service, and "0.00 years" would say something about that column that is not true. */
const toEditable = (
  bands: { fromYears: number; toYears: number | null; days: number; carryForwardDays?: number | null; maxBalanceDays?: number | null }[],
): EditableBand[] =>
  bands.map((b) => ({
    fromYears: String(b.fromYears ?? 0),
    toYears: b.toYears == null ? '' : String(b.toYears),
    days: formatDayInput(b.days ?? 0),
    carryForwardDays: formatDayInput(b.carryForwardDays),
    maxBalanceDays: formatDayInput(b.maxBalanceDays),
  }));

export async function EntitlementTablesBlock({
  data,
  leaveTypeId,
  editTemplate,
  editRule,
}: {
  data: EntitlementTablesData;
  /** Absent ⇒ the standalone screen: every leave type, with the Leave type column and the type picker.
   *  Present ⇒ the Entitlement step of that type: its own tables only, and the type filled in for HR. */
  leaveTypeId?: string;
  editTemplate?: string;
  editRule?: string;
}) {
  const t = await getTranslations('admin.entitlementTemplates');
  const { leaveTypes, ruleCounts, criteriaSections, gradeGroups, archivedMemberGrades, activeGrades, today } =
    data;

  const scoped = leaveTypeId != null;
  const typeNameById = new Map(leaveTypes.map((x) => [x.id, x.name]));
  const scopedTypeName = scoped ? (typeNameById.get(leaveTypeId!) ?? '') : '';

  // ── The slice this mount shows ────────────────────────────────────────────────────────────────────
  // Filtered IN MEMORY off the one page-level read (see loadEntitlementTablesData's note), through the
  // shared pure scoper — which is where the "a rule has no leave type of its own" reasoning lives, and
  // where it is tested.
  const { templates, rules } = scopeEntitlementTables(data, leaveTypeId);

  const running = templates.filter((x) => x.validTo == null);
  const runningRules = rules.filter((x) => x.validTo == null);
  // Scoped: every option is this type's, so repeating the type name in each label is noise.
  const templateOptions = running.map((x) => ({
    value: x.lineageId,
    label: scoped ? x.name : `${x.name} · ${typeNameById.get(x.leaveTypeId) ?? ''}`,
  }));

  const editingTemplate = running.find((x) => x.lineageId === editTemplate);
  const editingRule = runningRules.find((x) => x.lineageId === editRule);

  /**
   * r209 — THE HEALTH OF WHAT IS ON SCREEN, computed from the slice already in hand.
   *
   * Scoped mount ⇒ ONE type's findings, rendered above its own tables. Unfiltered mount ⇒ the whole
   * traffic-light listing, which is what makes the standalone screen the place all 24 types can be judged
   * side by side rather than one Edit click at a time. Both derive from `lib/leave-config-health.ts`, so
   * "no eligibility rule points at this table" cannot come to mean two things on two screens.
   *
   * NO EXTRA QUERY. `templates`, `rules`, `activeGrades` and the leave types' earning-method columns are
   * all in `data`, which each host page loads exactly once.
   */
  const scopedType = scoped ? leaveTypes.find((x) => x.id === leaveTypeId) : undefined;
  const scopedHealth = scopedType
    ? leaveTypeConfigHealth({ leaveType: scopedType, templates, rules, grades: activeGrades, today })
    : null;
  const allHealth = scoped
    ? []
    : leaveConfigHealthAll({ leaveTypes, templates, rules, grades: activeGrades, today });
  /**
   * The leave types whose SINGLE table applies to everyone with no rule (r193 fault 3). Needed BY TYPE, not
   * as one boolean: the unfiltered mount shows every type's tables in one list, so a single flag would
   * either warn on a healthy Hospitalization row or stay silent on a broken Medical one. Built from
   * whichever health set this mount computed — the same derivation, so the table's marker and the card
   * above it can never disagree about which zero is a fault.
   */
  const soleTableTypeIds = new Set(
    (scopedHealth ? [scopedHealth] : allHealth).filter((h) => h.soleTableApplies).map((h) => h.leaveTypeId),
  );

  /** A rule lineage's CURRENT version — a retired lineage has no version in force, so "in force" would hide
   *  the very rules whose expiry is the finding. Latest `validFrom` wins; `rules` arrives ascending. */
  const ruleHeadIds = new Set(
    [...new Map(rules.map((r) => [r.lineageId, r.id])).values()],
  );
  const expiryWarnEnd = addDaysIso(today, RULE_EXPIRY_WARNING_DAYS);

  /**
   * ⚠️ THE `#type-<id>` ANCHOR IS NOT DECORATION WHEN EMBEDDED. `LeaveTypeWorkspace` seeds its selection
   * from `items[0]` and only then applies the hash (leave-type-workspace.tsx line 81 / its hash effect), so
   * a HARD load of `/admin/leave/entitlements?editTemplate=…` with no anchor lands on the FIRST leave type
   * alphabetically while the edit form below it is showing another type's table. Soft navigation happens to
   * survive without it — the workspace is not remounted — which is exactly the kind of difference that gets
   * a missing anchor shipped. Every Edit / Cancel link this block emits carries it.
   */
  const href = (query: string) => (scoped ? `${query}#type-${leaveTypeId}` : query);
  /** The embedded mount posts this so the save returns to the step it was typed in, not to the standalone
   *  screen. Absent on the standalone mount, where the actions keep their own return. */
  const returnField = scoped ? <input type="hidden" name="embeddedLeaveTypeId" value={leaveTypeId} /> : null;

  const dash = DAY_DASH;
  /** One band rendered for the read-only list. `t.raw` is not needed here — no braces, plain values.
   *  4a1abc4a: the three day figures print through the shared formatter, so the summary a reader scans
   *  ("0–2: 12.00 (+5.00)") matches the editor they open to change it. The year bounds stay bare. */
  const bandText = (b: { fromYears: number; toYears: number | null; days: number; carryForwardDays?: number | null; maxBalanceDays?: number | null }) =>
    `${b.fromYears}–${b.toYears == null ? t('bandNoLimit') : b.toYears}: ${formatDays(b.days)}` +
    (b.carryForwardDays != null ? ` (+${formatDays(b.carryForwardDays)})` : '') +
    (b.maxBalanceDays != null ? ` ≤${formatDays(b.maxBalanceDays)}` : '');

  // Scoped drops the Leave type column: every row on screen is the same type, and the step's own heading
  // already says which. The colSpan of the empty-state row follows the column count rather than a literal.
  const templateCols = scoped ? 5 : 6;

  return (
    <div className="space-y-6">
      {/* ── r209 · STEP 0: CAN THIS LEAVE TYPE PRODUCE A BALANCE AT ALL? ─────────────────────────────
          Above the tables, because it is the question the tables below cannot answer on their own: six
          correct Medical tables and one eligibility rule that expired on 13 August 2026 read, on this
          screen, as six correct tables. Everything it names was already in the database and shown nowhere. */}
      {scopedHealth ? <LeaveConfigHealthNotice health={scopedHealth} /> : <LeaveConfigHealthCard rows={allHealth} />}

      {/* ── STEP 1: THE NAMED DAY TABLES ────────────────────────────────────────────────────────── */}
      <Card>
        <SectionHeader
          title={scoped ? t('templatesTitleForType', { type: scopedTypeName }) : t('templatesTitle')}
          count={running.length}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('colName')}</th>
                {scoped ? null : <th className="px-3 py-2">{t('colLeaveType')}</th>}
                <th className="px-3 py-2">{t('colBands')}</th>
                <th className="px-3 py-2">{t('colInForce')}</th>
                <th className="px-3 py-2">{t('colRules')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 && (
                <tr>
                  <td colSpan={templateCols} className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t('templatesNone')}
                  </td>
                </tr>
              )}
              {templates.map((x) => (
                <tr key={x.id} className="border-t align-top">
                  <td className="px-3 py-2 font-medium">{x.name}</td>
                  {scoped ? null : <td className="px-3 py-2">{typeNameById.get(x.leaveTypeId) ?? dash}</td>}
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
                  {/* r209 — A ZERO HERE IS THE WHOLE DEFECT AND IT USED TO RENDER AS A ZERO. Five of the
                      six Medical tables on the reporter's account have never had a rule; the count said
                      "0" and nothing said that 0 means nobody can ever receive this table. It is now
                      said in words, except where the leave type's SINGLE table applies to everyone with
                      no rule needed (r193 fault 3) — calling that broken would make the warning noise. */}
                  <td className="px-3 py-2 text-xs">
                    {x.validTo == null ? (ruleCounts.get(x.lineageId) ?? 0) : dash}
                    {x.validTo == null &&
                    (ruleCounts.get(x.lineageId) ?? 0) === 0 &&
                    !soleTableTypeIds.has(x.leaveTypeId) ? (
                      <span className="mt-0.5 block font-medium text-amber-700 dark:text-amber-500">
                        {t('ruleNonePointsHere')}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {x.validTo == null ? (
                      <Link href={href(`?editTemplate=${encodeURIComponent(x.lineageId)}`)} className="text-sm underline">
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
            {returnField}
            {editingTemplate ? <input type="hidden" name="lineageId" value={editingTemplate.lineageId} /> : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('templateName')}>
                <input className={inputCls} name="name" defaultValue={editingTemplate?.name ?? ''} required />
              </Field>
              <Field label={t('templateLeaveType')}>
                {/* Not editable on an existing lineage: a rule pointing at "the Executive ANNUAL table"
                    that quietly started handing out SICK days is not an edit anybody would spot.
                    ee6b7c69 — and not CHOOSABLE on the embedded mount either: the step already knows which
                    type HR is on, so the id is posted hidden and the name shown read-only. Asking somebody
                    standing inside Annual Leave which leave type they mean is a question with one right
                    answer and one way to get it wrong. */}
                {editingTemplate ? (
                  <input
                    className={inputCls}
                    value={typeNameById.get(editingTemplate.leaveTypeId) ?? ''}
                    readOnly
                    aria-label={t('templateLeaveType')}
                  />
                ) : scoped ? (
                  <>
                    <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
                    <input className={inputCls} value={scopedTypeName} readOnly aria-label={t('templateLeaveType')} />
                  </>
                ) : (
                  <select className={inputCls} name="leaveTypeId" required defaultValue="">
                    <option value="">{t('pickLeaveType')}</option>
                    {leaveTypes
                      .filter((x) => !x.archived)
                      .map((x) => (
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
            {/* ⚠️ THE `key` IS THE FIX FOR A DATA-LOSS DEFECT, NOT A LIST-RENDERING HABIT (4a1abc4a).
                `EntitlementBandsEditor` seeds its rows with `useState(initial)`, and useState reads its
                argument ONLY on the first mount. The Edit control above is a next/link `Link`, so reaching
                this form is a CLIENT-SIDE navigation: React re-renders the same component instance, the new
                `initial` is discarded, and the blank new-table row stays on screen over a saved template.
                Saving from there posted days 0 with a green toast — an 18-day table became 0. Keying on the
                template being edited makes a different target a different instance, so it remounts and
                re-reads `initial`; 'new' keeps the create form its own instance. Loading the URL directly
                always worked (a fresh mount), which is why this survived a page-level check. `EligibilityRuleForm`
                below has carried the same key since it was written — the two forms had drifted apart, and
                only the one without it could lose a table.
                ⚠️ ee6b7c69 — EMBEDDING MAKES THIS KEY MATTER MORE, NOT LESS. The Entitlement step is
                conditionally mounted (`activeStep === 'entitlement'`), so changing type or step remounts the
                editor and re-seeds it correctly, while clicking Edit while already standing on the step does
                not. Without the key the failure would be intermittent instead of reproducible. */}
            <EntitlementBandsEditor
              key={editingTemplate?.lineageId ?? 'new'}
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
                <Link href={href('?')} className="text-sm underline">
                  {t('cancel')}
                </Link>
              ) : null}
            </div>
          </form>

          {editingTemplate ? (
            <form action={retireEntitlementTemplateAction} className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
              {returnField}
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
                /**
                 * THE DRIFT CHECK THE APPROVED PLAN REQUIRES, AS A LIST OF THE RULES IT HAPPENED TO.
                 *
                 * A rule built from a Grade Group stores that group's grades, not the group — see
                 * lib/grade-group-coverage.ts. If a grade joins the group afterwards the rule keeps
                 * covering the old set, and nothing about the rule says so: it saves, resolves and
                 * matches employees exactly as before, just fewer of them than its author would expect.
                 * The same shape also arises from picking grades one at a time across a group boundary.
                 *
                 * Named here, on every rule it applies to, rather than left to be discovered on the
                 * Approval Template screen as an unexplained greyed-out row — that refusal
                 * (core/leave-approval-template.ts) is computed from this exact condition, so the two
                 * screens are describing one fact in two places rather than two rules that can disagree.
                 */
                const drifted = partiallyCoveredGradeGroups(
                  Array.isArray((x.criteria as Record<string, unknown>).gradeIds)
                    ? ((x.criteria as Record<string, unknown>).gradeIds as string[])
                    : [],
                  gradeGroups,
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
                      {drifted.length > 0 ? (
                        <span className="mt-1 block font-medium text-foreground">
                          {t('ruleGradeGroupPartial', { groups: drifted.map((g) => g.name).join(', ') })}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {x.validFrom}
                      <span className="block">{x.validTo ?? t('stillRunning')}</span>
                      {/* r209 — AN END DATE IN THE PAST IS NOT A DATE, IT IS A FAULT. The tenant's only
                          eligibility rule carried valid_to 2026-08-13 and this cell printed it as an
                          ordinary date; from the 14th nobody resolved to any entitlement table and no
                          screen said so for six days. Only the lineage's CURRENT version is judged — an
                          older superseded version ending is exactly how versioning works and is not news. */}
                      {ruleHeadIds.has(x.id) && x.validTo != null && x.validTo <= today ? (
                        <span className="mt-0.5 block font-medium text-red-700 dark:text-red-400">
                          {t('ruleExpiredBadge')}
                        </span>
                      ) : null}
                      {ruleHeadIds.has(x.id) && x.validTo != null && x.validTo > today && x.validTo <= expiryWarnEnd ? (
                        <span className="mt-0.5 block font-medium text-amber-700 dark:text-amber-500">
                          {t('ruleExpiringBadge')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {x.validTo == null ? (
                        <Link href={href(`?editRule=${encodeURIComponent(x.lineageId)}`)} className="text-sm underline">
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
                gradeGroups={gradeGroups}
                archivedMemberGrades={archivedMemberGrades}
                today={today}
                embeddedLeaveTypeId={leaveTypeId}
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
                  {returnField}
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
                  <Link href={href('?')} className="text-sm underline">
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
