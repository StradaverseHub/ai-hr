import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { listLeaveTypes, listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listAllProfileOptions } from '@/core/profile-options';
import { buildOrgCriteriaSections } from '@/core/org-criteria-form';
import type { CriteriaSection } from '@/core/org-criteria-form';
import type { SessionContext } from '@/db/client';
// 3fb1a611 (r299 fix pass, D9) — "does this type's every day come from Leave Credit?": the tenant has the paid
// `toil` module (the page's quiet form — an entitlement incident reads as "no", i.e. the findings as before) AND
// the type is the replacement one, asked with the engine's own role-first predicate.
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { leaveTypeIs } from '@/core/leave';
import {
  eligibilityRuleCountsByTemplate,
  entitlementDeleteBlocks,
  isDeletableLineage,
  listEligibilityRules,
  listEntitlementTemplates,
  listGradeGroups,
  MAX_SERVICE_BANDS,
  type EligibilityRuleRow,
  type EntitlementTemplateRow,
  type EntitlementUsageBlock,
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
  newTableReachesNobody,
  RULE_EXPIRY_WARNING_DAYS,
  type HealthLeaveType,
} from '@/lib/leave-config-health';
import { LeaveConfigHealthCard, LeaveConfigHealthNotice } from '@/components/leave/leave-config-health';
// r224 — the Save button, the note under it and the Effective from box, as ONE client island: the label has
// to follow the date the operator has typed, which only the browser knows. See that file's header for what
// the pre-filled date was doing to every ordinary edit.
import {
  EntitlementEffectiveFromField,
  EntitlementSaveModeNote,
  EntitlementSaveModeProvider,
  EntitlementSaveModeSubmit,
} from '@/components/leave/entitlement-save-mode';
import { Card, Field, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { EntitlementBandsEditor, type EditableBand } from '@/components/leave/entitlement-bands-editor';
import { EligibilityRuleForm } from '@/components/leave/eligibility-rule-form';
import { todayInKualaLumpur } from '@/lib/hr-date';
// r299 (3de1453a) — the engine's own predicates, so the Balance Health finding for an earned method on a type
// that is not Annual Leave is decided exactly where the sweep decides it. Server module; plain boolean out.
import { isEarnedAccrualType, isEarnedMethod } from '@/core/leave';
// ee6b7c69 — "which tables and rules are this leave type's", pure and tested on its own.
import { scopeEntitlementTables } from '@/lib/entitlement-tables-scope';
// 9e2a89e9 — "who does this cover", derived ONCE for both Covers columns. The scheme list had this
// rendering inline (raw criteria keys and a count); the tables list needed the same answer, and two
// renderings of one criteria object is how two halves of a screen come to disagree. See that file.
import {
  isEveryoneCriteria,
  summariseOrgCriteria,
  type CriteriaAxisSummary,
} from '@/lib/entitlement-criteria-summary';
// r212 (8ebf77ae) — the leave type's OWN conditions, worded from the SAME criteria vocabulary the rule
// builder below is generated from, so the inherited list and the pickers beside it cannot drift apart.
import { inheritedConditions, type LeaveTypeEligibility } from './leave-type-conditions';
// r212 — the one-click "everyone" rule. A CLIENT island because it must show the reach count before it
// lets anybody save; see its header for why a bare form was the wrong shape for this one write.
import { EveryoneRuleForm } from './everyone-rule-form';
// 4a1abc4a — the Entitlement Table is where day figures are TYPED, so it is the one screen where the
// summary line and the editor cell beside it must agree digit for digit.
import { DAY_DASH, formatDayInput, formatDays } from '@/lib/day-format';
import {
  countEligibilityTargetsAction,
  createEligibilityRuleAction,
  createEntitlementTemplateAction,
  deleteEligibilityRuleAction,
  deleteEntitlementTemplateAction,
  retireEligibilityRuleAction,
  retireEntitlementTemplateAction,
  setLeaveTypeDefaultTemplateAction,
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
 * rendered), and the fourteen reads below, run per panel, would be well over three hundred queries for a
 * screen showing one. (Deliberately not a fixed number here — the list has grown three times since this
 * paragraph was written and said "eleven" throughout.)
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
  /** r212 — `eligibility` rides along too, and it is the whole of item 8ebf77ae's first change. The
   *  reporter asked why eligibility must be configured TWICE; the answer is that the leave type's own
   *  conditions decide WHETHER an employee may take the leave and the rule decides WHICH day table they
   *  get. Showing the first, read-only, on the screen where the second is typed is what stops the same
   *  conditions being keyed in both places. Already projected by `listLeaveTypes`, so no extra query. */
  leaveTypes: (HealthLeaveType & {
    archived: boolean;
    eligibility: LeaveTypeEligibility | null;
    /** `leave_type.probation_eligibility` is its OWN column, not part of the JSONB — merged into the
     *  object above exactly the way both enforcement chokepoints merge it (core/leave.ts 2568 / 5522). */
    probationEligibility: 'confirmed_only' | 'probation_only' | null;
  })[];
  /** EVERY version, not just the running ones — a superseded table is the record a closed year was
   *  reported against, and the three past-date readers still resolve it. The list marks which is running. */
  templates: EntitlementTemplateRow[];
  rules: EligibilityRuleRow[];
  ruleCounts: Map<string, number>;
  /** r210 — WHICH ELIGIBILITY RULES POINT AT EACH TABLE, keyed by template lineage; absent or empty ⇒
   *  none do, and the row offers Delete. This is the blocker the approved plan asks the SCREEN to name
   *  ("an eligibility rule that points at a table has to go before the table itself — the screen will say
   *  so rather than making you guess"), and it is pure configuration to derive.
   *
   *  ⚠️ THE OTHER BLOCKER — entitlement granted while the lineage was in force — IS NOT HERE, and
   *  `entitlementDeleteBlocks` carries the measurement that decided it: pre-computing it cost 1.7s per
   *  render at 50,000 ledger rows and grew linearly, because `leave_ledger`'s RLS calls a recursive
   *  SECURITY DEFINER function per row. It is asked instead inside the delete's own transaction, and its
   *  refusal is what the operator reads. So a row may offer Delete and the delete may still refuse —
   *  with the leave type, the window and the employee count in words, beside the Stop control. */
  templateDeleteBlocks: Map<string, EntitlementUsageBlock>;
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
    profileOptions,
    gradeGroups,
    deleteBlocks,
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
    // ADR-0086 (0fe1ca2e, r331) — a `listLocations` read sat here for the Work Site criteria picker. The
    // axis is retired, so it is gone, and it left the DESTRUCTURE ABOVE in the same edit — see the warning
    // three lines down, which is exactly the failure mode this pair of deletions could have caused.
    listAllProfileOptions(s),
    // The Grade Group axis of Employee Eligibility. ⚠️ A NAME ADDED TO THE DESTRUCTURE ABOVE MUST BE
    // ADDED HERE IN THE SAME POSITION — a mismatch shifts every later variable by one slot and every
    // side of it is an array, so nothing type-errors and every catalogue silently becomes another one.
    listGradeGroups(s),
    // r210 — which tables have an eligibility rule pointing at them, for the whole tenant, in two queries
    // over configuration. It reads NO ledger, on purpose: `entitlementDeleteBlocks` carries the numbers.
    // LAST in both lists, and the only entry here that is not an array — so a slot mismatch involving it
    // type-errors instead of silently swapping two catalogues.
    entitlementDeleteBlocks(s),
  ]);

  // The OFFER is unchanged: the Job Grade criteria field lists the ACTIVE catalogue and nothing else, so
  // no archived grade becomes newly pickable anywhere the shared builder renders.
  const activeGrades = grades.filter((g) => g.archivedAt == null);
  const criteriaSections = buildOrgCriteriaSections(
    { companies, departments, grades: activeGrades, positions, costCenters, businessUnits, profileOptions },
    { crit: tCrit, org: tOrg, employmentType: tEmploymentType },
  );

  // …and the NAMING is what the archived rows are for. Narrowed to grades some group actually holds: those
  // are the only ids the rule form adds to the picker on their behalf, and a name for anything else would
  // be data crossing to a client component for no reader.
  const heldByAGroup = new Set(gradeGroups.flatMap((g) => g.gradeIds));
  const archivedMemberGrades = grades
    .filter((g) => g.archivedAt != null && heldByAGroup.has(g.id))
    .map((g) => ({ id: g.id, name: g.name }));

  const leaveCreditLive = isModuleEnabledOrFalse(s, 'toil');

  return {
    leaveTypes: leaveTypes.map((x) => ({
      id: x.id,
      name: x.name,
      archived: !!x.archivedAt,
      accrualMethod: x.accrualMethod ?? null,
      accrualUnconfigured: x.accrualUnconfigured != null,
      // 3fb1a611 (r299 fix pass) — REQUIRED on HealthLeaveType; `listLeaveTypes` projects `role`, which
      // `leaveTypeIs` asks first. False for every type on a tenant without Leave Credit.
      daysFromLeaveCreditOnly: leaveCreditLive && leaveTypeIs(x, 'replacement'),
      eligibility: (x.eligibility ?? null) as LeaveTypeEligibility | null,
      probationEligibility: (x.probationEligibility ?? null) as 'confirmed_only' | 'probation_only' | null,
      /**
       * 76ffdcf2 — ⚠️ THIS FIELD WAS PROJECTED BY `listLeaveTypes` AND DROPPED HERE, and that one omission
       * made four of the item's promises inert behind a green suite: the Default badge never rendered, the
       * Covers cell called the default table "No benefit scheme names this table" (the exact claim this
       * item exists to delete), `leaveConfigHealthAll` saw `undefined` so the stale blocking findings kept
       * firing, and A SAVED DEFAULT READ BACK AS "No default" ON EVERY RELOAD.
       *
       * The lesson is the one this projection list has already learned three times over (see the
       * `MUST be projected` notes in core/read.ts): an explicit field literal silently drops whatever is
       * added upstream. `HealthLeaveType.defaultEntitlementTemplateLineageId` is therefore REQUIRED, not
       * optional, so the compiler is what catches the next reshape rather than a rendered page.
       */
      defaultEntitlementTemplateLineageId: x.defaultEntitlementTemplateLineageId ?? null,
      // r299 (3de1453a) — REQUIRED on HealthLeaveType for the reason the note above gives. `listLeaveTypes`
      // projects `role`, which `isEarnedAccrualType` asks first.
      earnedMethodNotAnnualLeave: isEarnedMethod(x.accrualMethod) && !isEarnedAccrualType(x),
    })),
    templates,
    rules,
    ruleCounts,
    templateDeleteBlocks: deleteBlocks.templates,
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

/**
 * r270 (65e4073a, build 1) — WHAT REACHES ONE ENTITLEMENT TABLE, and therefore what the flat grid's
 * "Job grade" cell is allowed to say. Four states, and each asserts something different:
 *
 *   scheme    — an in-force benefit scheme names this table. The cell is that scheme's OWN criteria
 *               summary, rendered by the same `coversCell` the tables list already uses. Where the scheme
 *               narrows on something other than job grade, that is what the cell prints: an absent cell
 *               asserts nothing, and a cell that guessed a grade would assert something false.
 *   default   — the table is the leave type's default (76ffdcf2). It reaches everyone no scheme covers,
 *               which is a population, not a grade — so the cell says so instead of printing a grade.
 *   everyone  — the leave type's SINGLE table with no scheme, which the engine applies to everybody with
 *               nothing to choose between (r193 fault 3, read from `soleTableApplies`, never re-derived).
 *   unreached — no scheme, not the default, not a sole table: nobody receives it. The health card says
 *               this in its own words; the grid may not pass over it in silence, because every other
 *               column on the row would then read as days somebody gets.
 */
export type EntitlementGridReach =
  | { kind: 'scheme'; ruleId: string; criteria: Record<string, unknown> | null }
  | { kind: 'default' }
  | { kind: 'everyone' }
  | { kind: 'unreached' }
  /**
   * r271 (6d29e11c) — A VERSION THAT IS NOT IN FORCE ON `today`. It reaches nobody, but it must still be
   * ON the screen: it is the record a closed year was reported against, and its lineage's current version
   * is the only row carrying Delete. When the grid and the tables list were two Cards the list held these;
   * now that they are one table, dropping them would take a stopped table's Delete button off the screen
   * with it.
   */
  | { kind: 'stopped' };

/** One row of the flat grid: ONE service band of ONE entitlement table, seen through ONE thing that
 *  reaches that table. A table reached by two schemes and also named as the default produces three sets
 *  of rows over the same bands, which is the honest reading — those are three different populations. */
export type EntitlementGridRow = {
  /** Stable and unique across the whole grid: version id · reach · band index. */
  key: string;
  /** r271 — the version this row came from, so the merged table can hang that version's own controls
   *  (Edit / Stop / Delete) off its FIRST row without a second derivation deciding the grouping. */
  templateId: string;
  leaveTypeId: string;
  tableName: string;
  reach: EntitlementGridReach;
  /** The Table cell is suffixed wherever this table is the leave type's default, whatever reached the row. */
  isDefaultTable: boolean;
  /** r271 — TRUE on exactly one row per VERSION (not per reach). The renderer draws the grouped cells —
   *  leave type, table name, the in-force window and the row actions — on this row and leaves them blank
   *  below it, so a table with three service steps reads as one entry rather than three. Computed here
   *  because only the derivation knows where a group starts; a renderer counting rows would be a second
   *  opinion about the same grouping. */
  firstOfTable: boolean;
  /** r271 — TRUE on the first band row of each REACH. The Job grade cell is a property of what reaches
   *  the table, not of a service step, so repeating it down three bands is noise; a table named by two
   *  schemes still gets it twice, once at the head of each scheme's band run. */
  firstOfReach: boolean;
  validFrom: string;
  validTo: string | null;
  /** Null where the version stores no service bands at all. The row still exists — a table with no bands
   *  is a configuration fault somebody has to be able to see and delete, not a table that vanishes. */
  fromYears: number | null;
  toYears: number | null;
  days: number | null;
};

/**
 * THE GRID, DERIVED — NOT RECOMPUTED. `65e4073a` build 1 is presentation only: no schema change, no
 * migration, no second matcher, and not one figure recalculated. Every value here is read from what the
 * block already holds: the day tables and their service bands, the in-force schemes pointing at each
 * table, the leave type's default table, and `soleTableApplies` from `lib/leave-config-health.ts`.
 *
 * ⚠️ IN-FORCE VERSIONS ONLY (`running`). A superseded or stopped version is the record a closed year was
 * reported against; printing its days beside a live grade band would state an entitlement nobody has.
 * The tables list below keeps showing those versions, with a dash in its Covers cell, which is where the
 * history belongs.
 *
 * Input order is preserved, deliberately: the caller sorts (leave type, then table) so the grid reads the
 * way the reporter drew it, and the ordering of a row set is not a fact this derivation gets to invent.
 */
export function entitlementGridRows(input: {
  /**
   * r271 — EVERY VERSION THIS MOUNT SHOWS, in the order it should read, not only the ones in force.
   * The grid and the tables list are ONE table now, so this derivation owns every row the screen draws:
   * a stopped version still needs its window, its name and its Delete button.
   */
  templates: readonly {
    id: string;
    lineageId: string;
    leaveTypeId: string;
    name: string;
    validFrom: string;
    validTo: string | null;
    serviceBands: readonly { fromYears: number; toYears: number | null; days: number }[];
  }[];
  /** Version ids in force on the page's own `today`. NOT `validTo == null`: a future-dated supersede
   *  leaves the FUTURE version open while the one deciding pay today is already closed (r270 D2). */
  inForceIds: ReadonlySet<string>;
  rulesByTemplateLineage: ReadonlyMap<string, readonly { id: string; criteria: unknown }[]>;
  defaultLineageByType: ReadonlyMap<string, string>;
  soleTableTypeIds: ReadonlySet<string>;
}): EntitlementGridRow[] {
  const out: EntitlementGridRow[] = [];
  for (const x of input.templates) {
    const inForce = input.inForceIds.has(x.id);
    const schemes = inForce ? (input.rulesByTemplateLineage.get(x.lineageId) ?? []) : [];
    const isDefaultTable = input.defaultLineageByType.get(x.leaveTypeId) === x.lineageId;

    let reaches: EntitlementGridReach[];
    if (!inForce) {
      // A version not in force reaches nobody, and says so once. It does NOT get a scheme row: a scheme
      // names a LINEAGE, and drawing it against a closed version would claim people receive these days.
      reaches = [{ kind: 'stopped' }];
    } else {
      reaches = schemes.map((r) => ({
        kind: 'scheme',
        ruleId: r.id,
        criteria: (r.criteria ?? null) as Record<string, unknown> | null,
      }));
      if (isDefaultTable) reaches.push({ kind: 'default' });
      // Only where nothing else reaches it: "everyone, because it is the only table" and "everyone the
      // schemes miss" are the same people said twice, and `soleTableApplies` is false once a rule exists.
      else if (schemes.length === 0) {
        reaches.push(input.soleTableTypeIds.has(x.leaveTypeId) ? { kind: 'everyone' } : { kind: 'unreached' });
      }
    }

    // A version with NO service bands is a configuration fault — it hands out nothing — and it must stay
    // visible and deletable rather than falling out of a `forEach` over an empty array.
    const bands: readonly ({ fromYears: number; toYears: number | null; days: number } | null)[] =
      x.serviceBands.length > 0 ? x.serviceBands : [null];

    let first = true;
    for (const reach of reaches) {
      let firstOfReach = true;
      bands.forEach((b, i) => {
        out.push({
          key: `${x.id}·${reach.kind === 'scheme' ? reach.ruleId : reach.kind}·${i}`,
          templateId: x.id,
          leaveTypeId: x.leaveTypeId,
          tableName: x.name,
          reach,
          isDefaultTable,
          // Exactly one row per VERSION carries the grouped cells, and it is the first row emitted for
          // that version across ALL of its reaches — not the first of each reach, or a table named by two
          // schemes would draw its Delete button twice.
          firstOfTable: first,
          firstOfReach,
          validFrom: x.validFrom,
          validTo: x.validTo,
          fromYears: b ? b.fromYears : null,
          toYears: b ? b.toYears : null,
          days: b ? b.days : null,
        });
        first = false;
        firstOfReach = false;
      });
    }
  }
  return out;
}

export async function EntitlementTablesBlock({
  data,
  leaveTypeId,
  editTemplate,
  editRule,
  showConfigHealth = true,
  showBenefitSchemes = true,
}: {
  data: EntitlementTablesData;
  /** Absent ⇒ the standalone screen: every leave type, with the Leave type column and the type picker.
   *  Present ⇒ the Entitlement step of that type: its own tables only, and the type filled in for HR. */
  leaveTypeId?: string;
  editTemplate?: string;
  editRule?: string;
  /**
   * r270 (5527ce8f) — DRAW THE LEAVE BALANCE HEALTH SURFACE AT ALL.
   *
   * ⚠️ NEITHER FLAG MAY CARRY THE SUBSTRING `leaveTypeId`. `test/entitlement-tables-embed.test.ts`
   * proves the standalone mount is UNFILTERED by slicing the mount text to its first `/>` and asserting
   * that slice names no `leaveTypeId`, and `test/leave-config-round3.test.ts` asserts the same of the
   * whole page; a flag named after the scope would read to both guards as the filter coming back.
   *
   * Default TRUE, so every existing mount keeps today's behaviour and only the caller that wants the
   * surface gone has to say so. The Entitlement tables tab passes false because
   * `app/admin/leave-config/types/page.tsx` already renders `LeaveConfigHealthCard` at page level and the
   * block was drawing a second, identical copy above the tables the operator opened that tab to read.
   * The page-level copy is the one that is KEPT.
   */
  showConfigHealth?: boolean;
  /**
   * r270 (995387c6) — DRAW THE BENEFIT SCHEMES CARD (the list AND its create/edit form) at all.
   *
   * Same shape and the same naming constraint as `showConfigHealth`. The schemes surface already lives on
   * the leave type's own "What they are entitled to" tab, which is the scoped mount; the unscoped mount
   * was a second copy of the same form writing the same effective-dated lineage. GATED, NOT DELETED: the
   * JSX below is the one definition both mounts share, `test/r266-benefit-scheme-vocabulary.test.ts`
   * requires this file to keep asking for `colSchemeName` / `rulesIntro` / `rulesNamingTip`, and a
   * deletion would take the scoped mount's schemes editor with it.
   */
  showBenefitSchemes?: boolean;
}) {
  const t = await getTranslations('admin.entitlementTemplates');
  // r212 — the marital-status values already shipped in six locales under the leave-type screen's own
  // namespace. Read there rather than re-minted: r127 shipped a screen rendering entirely through
  // MISSING_MESSAGE behind a green 200 by inventing a copy of labels that already existed.
  const tLeave = await getTranslations('admin.leave');
  const {
    leaveTypes,
    ruleCounts,
    templateDeleteBlocks,
    criteriaSections,
    gradeGroups,
    archivedMemberGrades,
    activeGrades,
    today,
  } = data;

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
  /**
   * r270 fix pass — IN FORCE AT `today`, WHICH IS NOT THE SAME AS OPEN.
   *
   * `running` is "the version nothing has superseded yet", and that is the right set for a PICKER and for
   * an Edit link: you edit the open version. It is the wrong set for a grid that tells a reader how many
   * days somebody gets, because the screen's own `datedNote` documents the opposite workflow — giving a
   * table a later date closes the running version ON that date and starts a new one. Between the save and
   * that date BOTH exist, the open one is the FUTURE one, and the grid was printing next year's figures
   * as today's while hiding the version actually deciding pay today.
   *
   * Found by the r270 verify pass: superseding a 14-day table from 2027-01-01 with 30 days made the grid
   * read 30, and the 14-day version in force did not appear at all. The grid carries no date column, so
   * nothing on screen let a reader notice.
   */
  const inForceTemplates = templates.filter(
    (x) => x.validFrom <= today && (x.validTo == null || x.validTo > today),
  );
  // Scoped: every option is this type's, so repeating the type name in each label is noise.
  const templateOptions = running.map((x) => ({
    value: x.lineageId,
    label: scoped ? x.name : `${x.name} · ${typeNameById.get(x.leaveTypeId) ?? ''}`,
  }));

  const editingTemplate = running.find((x) => x.lineageId === editTemplate);
  const editingRule = runningRules.find((x) => x.lineageId === editRule);
  /**
   * r219 (ca7766ab) → r224 — WHICH WRITE AN EDIT IS, AND WHY THIS SERVER COMPONENT NO LONGER ANSWERS IT.
   *
   * The service takes a different write depending on three dates (`entitlementEditMode`,
   * lib/entitlement-edit-mode.ts): a version that has not started is UPDATED, its effective date included;
   * one in force is superseded UNLESS the date is not moving, in which case it too is updated in place.
   *
   * r219 made both captions read the FIRST of those conditions — has this version started — which was an
   * improvement and still wrong, because it is the middle arm that the operator meets every day. A version
   * in force was told its save would close it and start a successor even where the save overwrites it.
   *
   * ⚠️ AND THE DATE BOX WAS THE ACTUAL DEFECT. It pre-filled TODAY for any version already in force, which
   * made `newValidFrom !== openValidFrom` true before the operator touched anything, so every ordinary
   * edit superseded. r224 fills it with the version's OWN date, which is r224's whole fix; the button and
   * the note then have to follow the box rather than the render, so both moved into
   * `components/leave/entitlement-save-mode.tsx` and read `entitlementEditMode` in the browser over the
   * date currently on screen. The two has-it-started booleans this block used to keep are gone with them —
   * a derivation left behind here would be a second opinion about the same save, and the r219 §F guard now
   * asserts their ABSENCE by name, so do not reintroduce one under the old name to "document" it.
   */

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
  /**
   * 76ffdcf2 — leave type id → the entitlement table lineage it falls back to. Read off the leave types
   * this page already loaded (`listLeaveTypes` projects the column), never a second query: the block is
   * mounted once per leave type on the Entitlements screen, and a read here would be one per panel.
   */
  const defaultLineageByType = new Map(
    leaveTypes
      .filter((x) => x.defaultEntitlementTemplateLineageId)
      .map((x) => [x.id, x.defaultEntitlementTemplateLineageId!] as const),
  );
  /**
   * r212 (8ebf77ae) — …AND THE SAME SET AS NAMES, so Step 2 can say "no rule is needed here, and none is
   * missing" instead of leaving "No eligibility rules yet" to be read as a gap.
   *
   * READ from `lib/leave-config-health.ts`, never recomputed: `soleTableApplies` is the r193 fault-3 gate
   * mirrored from the engine, and its two halves are subtle enough that r209 shipped a green light over a
   * leave type the engine granted to nobody by measuring the second half on the wrong set of rules. One
   * derivation, three readers (the health card, the per-table marker, and this line).
   */
  const soleTableTypeNames = (scopedHealth ? [scopedHealth] : allHealth)
    .filter((h) => h.soleTableApplies)
    .map((h) => h.leaveTypeName);

  /**
   * r212 (8ebf77ae) — THE LEAVE TYPE'S OWN CONDITIONS, TO BE SHOWN READ-ONLY ABOVE THE CRITERIA BUILDER.
   *
   * The reporter asked why eligibility must be configured twice. It is not the same decision twice: the
   * leave type's conditions answer MAY THIS EMPLOYEE TAKE IT AT ALL (`isLeaveEligible`, core/leave.ts) and
   * the rule answers WHICH DAY TABLE APPLIES. But both speak the same vocabulary, so an operator who does
   * not know the first is already in force keys it again — and either copy can then silently exclude
   * somebody. Showing it here is the fix; merging the two layers is not, and would cost either the choice
   * of table or the ability to exclude people from a type entirely.
   *
   * SCOPED MOUNT ONLY. The unfiltered screen lists every leave type's rules in one table, so there is no
   * single set of conditions to inherit and a list from one type would be a lie beside another type's rule.
   * The probation column is merged in the way both enforcement chokepoints merge it.
   */
  const scopedEligibility: LeaveTypeEligibility | null =
    scoped && scopedType
      ? {
          ...((scopedType.eligibility ?? {}) as LeaveTypeEligibility),
          ...(scopedType.probationEligibility ? { probation: scopedType.probationEligibility } : {}),
        }
      : null;
  const maritalLabel = (m: string) =>
    m === 'single'
      ? tLeave('eligibilityMaritalSingle')
      : m === 'married'
        ? tLeave('eligibilityMaritalMarried')
        : m === 'divorced'
          ? tLeave('eligibilityMaritalDivorced')
          : m === 'widowed'
            ? tLeave('eligibilityMaritalWidowed')
            : m === 'separated'
              ? tLeave('eligibilityMaritalSeparated')
              : m === 'other'
                ? tLeave('eligibilityMaritalOther')
                : m;
  const inherited = scopedEligibility
    ? inheritedConditions(scopedEligibility, criteriaSections, {
        maritalStatus: t('inheritedMarital'),
        minService: t('inheritedMinService'),
        // The unit is the leave type's own (`minServiceUnit`, absent ⇒ months) and it is NOT the criteria
        // vocabulary's years-of-service band — near neighbours, different axes. See leave-type-conditions.ts.
        minServiceValue: (n, unit) =>
          unit === 'days' ? t('inheritedMinServiceDays', { count: n }) : t('inheritedMinServiceMonths', { count: n }),
        maritalValue: maritalLabel,
      })
    : [];

  /**
   * A lineage's CURRENT version, by row id. Two readers need it and they need it for the same reason: a
   * RETIRED lineage has no version in force, so "in force" would hide the very records whose expiry is
   * the finding — and, since r210, would hide the Delete control on a stopped table that was never used,
   * which is exactly the record an operator wants to clear away.
   *
   * Latest `validFrom` wins, computed rather than taken from input order: a version may be RENAMED, and
   * both lists are ordered by name before date, so "the last row of this lineage" is not the latest one.
   */
  const headOf = <T extends { id: string; lineageId: string; validFrom: string }>(rows: readonly T[]) => {
    const head = new Map<string, T>();
    for (const r of rows) {
      const prev = head.get(r.lineageId);
      if (!prev || r.validFrom >= prev.validFrom) head.set(r.lineageId, r);
    }
    return head;
  };
  const templateHeads = headOf(templates);
  const idsOf = (heads: Map<string, { id: string }>) => new Set([...heads.values()].map((r) => r.id));
  const ruleHeadIds = idsOf(headOf(rules));
  const templateHeadIds = idsOf(templateHeads);
  const expiryWarnEnd = addDaysIso(today, RULE_EXPIRY_WARNING_DAYS);

  /**
   * r210 · WHAT IS HOLDING THIS TABLE, in the operator's words, beside the Stop control that is the way
   * out of it — and it NAMES THE RULES, because naming them is the operator's next step. A row that only
   * said "cannot delete" would have made them guess which of the rules below is the one.
   *
   * ⚠️ THE OTHER REFUSAL — entitlement granted while this lineage was in force — IS NOT RENDERED HERE.
   * Deriving it for every row costs one unindexed `leave_ledger` read per page render whose RLS calls a
   * recursive SECURITY DEFINER function per row (`entitlementDeleteBlocks` carries the measurements), so
   * it is asked inside the delete's own transaction instead. The operator presses Delete and reads the
   * service's own sentence, which says more than a row caption could: the leave type, the window, the
   * employee count, and the caveat that a leave record does not record WHICH table granted it.
   */
  const deleteBlockText = (block: EntitlementUsageBlock | undefined): string | null =>
    !block || isDeletableLineage(block) ? null : t('deleteBlockedByRules', { rules: block.rules.join(', ') });
  /** The row's date box for Stop. `inputCls` is `w-full` and full height — a row control is neither. */
  const rowDateCls =
    'h-8 w-[8.5rem] rounded-md border border-input bg-card px-2 text-xs shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

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

  /**
   * 9e2a89e9 — THE COVERS CELL, one renderer for both columns.
   *
   * Values are named through the picker's own option labels (`criteriaSections`, already loaded once per
   * page and already in six locales), never printed as stored ids: an archived or deleted catalogue row
   * has no option to name it, so it is COUNTED rather than rendered as a UUID in front of an operator.
   * Long lists are capped for the same reason a 66-row grade catalogue is not a table cell.
   */
  const COVERS_VALUE_CAP = 6;
  const coversCell = (criteria: Record<string, unknown> | null | undefined) => {
    if (isEveryoneCriteria(criteria)) return <span className="block">{t('criteriaEveryone')}</span>;
    return summariseOrgCriteria(criteria, criteriaSections).map((a: CriteriaAxisSummary) => {
      const shown = a.values.slice(0, COVERS_VALUE_CAP);
      const hidden = a.values.length - shown.length + a.unresolved;
      return (
        <span key={a.axis} className="block">
          <span className="text-muted-foreground">{a.label}:</span>{' '}
          {a.scalar != null ? a.scalar : shown.join(' · ')}
          {hidden > 0 ? <span className="text-muted-foreground"> {t('coversMore', { count: hidden })}</span> : null}
        </span>
      );
    });
  };
  /**
   * r270 — "WHO DOES THE SCHEME THAT NAMES THIS TABLE COVER", asked FROM THE TABLE'S SIDE.
   *
   * Two surfaces ask exactly that question of a rule: the tables list's Covers cell, and the flat grid's
   * Job grade cell. They are one question, so they get one name. (The schemes list's own Covers column
   * asks the same thing from the SCHEME's side and calls the renderer directly, because there it is not
   * a property of a table at all.)
   *
   * ⚠️ THAT IS THE ONLY REASON THIS ALIAS EXISTS, and it must never be justified by what it does to a
   * test's call count. r270 first shipped it with exactly that justification written here, which was
   * wrong twice over: an indirection that keeps a counter at 2 while a third surface renders a criteria
   * object makes the guard measure something it does not claim to measure. The guard in
   * `test/r269-grade-change-record.test.ts` now counts renderings through BOTH names, so hiding one
   * behind an alias cannot work. Its point is what it always was: ONE renderer of a criteria object in
   * this file, reached from every surface that shows one, and no second inline walk of it.
   */
  const coversOfScheme = (criteria: unknown) => coversCell(criteria as Record<string, unknown>);
  /**
   * Which IN-FORCE schemes name each entitlement table, keyed by template lineage. Built from the rules
   * this mount already holds — the Covers column on the tables list is the SAME fact as the Covers column
   * on the schemes list, read from the table's side, and the table itself deliberately stores no criteria
   * (that would be a second source of truth for who gets what).
   */
  const rulesByTemplateLineage = new Map<string, EligibilityRuleRow[]>();
  for (const r of runningRules) {
    const arr = rulesByTemplateLineage.get(r.templateLineageId);
    if (arr) arr.push(r);
    else rulesByTemplateLineage.set(r.templateLineageId, [r]);
  }

  /**
   * r270 (65e4073a, build 1) — THE FLAT GRID, AND WHY IT IS THE UNFILTERED MOUNT'S ALONE.
   *
   * The reporter wrote their policy as four columns — leave type, job grade, years of service, days — and
   * asked why the system needed a separate layer to express it. It does not: the answer is already on this
   * screen, split across two blocks. Years of service and days are on the entitlement TABLE; job grade is
   * on the benefit SCHEME that names it. The grid puts them side by side and adds nothing to the model.
   *
   * SCOPED MOUNT GETS NOTHING. Inside one leave type's tab the Leave type column is one repeated value and
   * r271 (6d29e11c) — THE GRID IS THE TABLES LIST NOW, ON BOTH MOUNTS.
   *
   * r270 shipped it as a second Card above the list, which put THREE blocks on a tab whose whole complaint
   * was that the facts sat in two, and described every table twice — once with its days, once with its
   * buttons. The approved sketch drew ONE table; this is that table. The leave type tab gets the same
   * layout for the same reason the block is shared at all: two layouts out of one component is the second
   * implementation this area exists to prevent, and `scoped` already hides the Leave type column there.
   *
   * Sorted HERE, not in the derivation: leave type name, then table name, then the version's own date — so
   * a reader finds every Annual Leave row together, the way they drew it. `localeCompare` on a rendered
   * name is a display order, and the derivation has no business inventing one.
   */
  const gridRows = entitlementGridRows({
    templates: [...templates].sort(
      (a, b) =>
        (typeNameById.get(a.leaveTypeId) ?? '').localeCompare(typeNameById.get(b.leaveTypeId) ?? '') ||
        a.name.localeCompare(b.name) ||
        a.validFrom.localeCompare(b.validFrom),
    ),
    inForceIds: new Set(inForceTemplates.map((x) => x.id)),
    rulesByTemplateLineage,
    defaultLineageByType,
    soleTableTypeIds,
  });
  /** The grid's Job grade cell. `scheme` goes through `coversCell` — ONE rendering of one criteria object,
   *  so the grid and the tables list below it cannot describe the same scheme two ways. The other three
   *  states are populations, not grades, and each says which population it is rather than leaving a blank. */
  const gridGradeCell = (reach: EntitlementGridReach) =>
    reach.kind === 'scheme' ? (
      coversOfScheme(reach.criteria)
    ) : reach.kind === 'default' ? (
      // r271 — `coversDefaultTable` ("Anyone no benefit scheme covers — this leave type's default table"),
      // NOT the sketch's "Everyone else". A default table whose leave type has no schemes at all produces
      // exactly ONE row, and "Everyone else" there is else than nobody — a phrase that means nothing on
      // the commonest arrangement on this account. The list's own wording is true in both cases, and a
      // mockup's caveat covers wording; it does not cover saying something meaningless.
      <span className="block">{t('coversDefaultTable')}</span>
    ) : reach.kind === 'everyone' ? (
      <span className="block">{t('criteriaEveryone')}</span>
    ) : reach.kind === 'stopped' ? (
      // r271 — a version not in force reaches nobody, and that is not the same fact as "no scheme names
      // this table". The old list drew a plain dash here for exactly this row; it still does. The amber
      // warning below is for a LIVE table nothing points at, and shouting it at a stopped one is noise.
      <span className="text-muted-foreground">{dash}</span>
    ) : (
      <span className="block font-medium text-amber-700 dark:text-amber-500">{t('gridNoGrade')}</span>
    );

  const dash = DAY_DASH;

  // Scoped drops the Leave type column: every row on screen is the same type, and the step's own heading
  // already says which. The colSpan of the empty-state row follows the column count rather than a literal.
  /** r271 — the merged table's own column count, for the empty-state colspan. Seven unscoped
   *  (leave type · job grade · service · entitlement · table · in force · controls), six scoped, where
   *  every row is one leave type and naming it on each line is noise. */
  const mergedCols = scoped ? 6 : 7;
  /** The version behind a grid row, for the controls the row's group head draws. One map, built once —
   *  looking a template up inside the render loop is the only thing the row does not already carry. */
  const templateById = new Map(templates.map((x) => [x.id, x]));

  return (
    <div className="space-y-6">
      {/* ── r209 · STEP 0: CAN THIS LEAVE TYPE PRODUCE A BALANCE AT ALL? ─────────────────────────────
          Above the tables, because it is the question the tables below cannot answer on their own: six
          correct Medical tables and one eligibility rule that expired on 13 August 2026 read, on this
          screen, as six correct tables. Everything it names was already in the database and shown nowhere.

          r270 (5527ce8f) — THREE STATES, AND THE SUPPRESSED ONE IS TESTED FIRST. Order is load-bearing
          twice over. It is what the flag means (a caller that said "do not draw this" must not get the
          unscoped card as a fall-through), and it closes a live edge case that the two-arm ternary had:
          a `leaveTypeId` matching no row in the loaded data leaves `scopedType` undefined, so `scopedHealth`
          is null and the SCOPED mount fell into the UNSCOPED arm — rendering an empty card reading "No
          active leave types" over one leave type's tables. */}
      {!showConfigHealth ? null : scopedHealth ? (
        <LeaveConfigHealthNotice health={scopedHealth} />
      ) : (
        <LeaveConfigHealthCard rows={allHealth} />
      )}

      {/* ── r270 · 65e4073a BUILD 1 · THE FOUR COLUMNS THE REPORTER DREW ─────────────────────────────
          One row per entitlement table per service band per thing that reaches it, in the order the
          mockup promised: Leave type · Job grade · Years of service · Entitlement · Table. Above the
          tables list because it is the reading, and the list below it is where the same facts are EDITED.

          PRESENTATION ONLY. Every value is read from what this block already loaded; nothing here resolves
          entitlement for anybody, and `core/entitlement-template.ts` is untouched. Hidden when there is
          nothing in force to read: a permanently empty grid is furniture, and the tables list below already
          says "no entitlement tables yet" in its own words. */}
      {/* ── THE ENTITLEMENT TABLES, AS ONE TABLE ────────────────────────────────────────────────
          r271 (6d29e11c). r270 drew this twice: a "who gets how many days" grid above, and the managed
          list below, describing the same versions once with their figures and once with their buttons.
          The approved sketch drew ONE table and the reporter's whole complaint was fragmentation, so a
          third block was the wrong answer to it. One row per service step; the cells that belong to the
          VERSION rather than to a step — leave type, table name, the in-force window, and the controls —
          are drawn once at the head of each group and left blank beneath it. */}
      <Card>
        <SectionHeader
          title={scoped ? t('templatesTitleForType', { type: scopedTypeName }) : t('templatesTitle')}
          count={running.length}
        />
        {/* What this table cannot show, said before it rather than after (r270 D4). */}
        <p className="px-3 pb-2 text-xs text-muted-foreground">{t('gridOverlapNote')}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                {scoped ? null : <th className="px-3 py-2">{t('gridColLeaveType')}</th>}
                <th className="px-3 py-2">{t('gridColGrade')}</th>
                <th className="px-3 py-2">{t('gridColService')}</th>
                <th className="px-3 py-2">{t('gridColEntitlement')}</th>
                <th className="px-3 py-2">{t('gridColTable')}</th>
                <th className="px-3 py-2">{t('colInForce')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {gridRows.length === 0 && (
                <tr>
                  <td colSpan={mergedCols} className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t('templatesNone')}
                  </td>
                </tr>
              )}
              {gridRows.map((r) => {
                const x = templateById.get(r.templateId);
                return (
                  <tr
                    key={r.key}
                    className={r.firstOfTable ? 'border-t-2 border-border align-top' : 'border-t align-top'}
                  >
                    {scoped ? null : (
                      <td className="px-3 py-2">{r.firstOfTable ? (typeNameById.get(r.leaveTypeId) ?? dash) : null}</td>
                    )}
                    <td className="px-3 py-2 text-xs">{r.firstOfReach ? gridGradeCell(r.reach) : null}</td>
                    {/* The same bounds the version stores, and the same "no limit" word its own editor
                        uses for an open-ended top band. A version with no bands says so rather than
                        rendering an empty row that looks like a rendering fault. */}
                    <td className="px-3 py-2 text-xs tabular-nums">
                      {r.fromYears == null ? (
                        <span className="text-muted-foreground">{t('templateNoBands')}</span>
                      ) : (
                        <>
                          {r.fromYears}–{r.toYears == null ? t('bandNoLimit') : r.toYears}
                        </>
                      )}
                    </td>
                    {/* Through the shared day formatter, so this figure and the editor that produced it
                        agree digit for digit — and a half day reads 16.50 rather than rounding away. */}
                    <td className="px-3 py-2 text-xs tabular-nums">{r.days == null ? dash : formatDays(r.days)}</td>
                    <td className="px-3 py-2 text-xs font-medium">
                      {r.firstOfTable ? (
                        <>
                          {r.tableName}
                          {r.isDefaultTable && r.reach.kind !== 'stopped' ? (
                            <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                              {t('defaultTableBadge')}
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.firstOfTable ? (
                        <>
                          {r.validFrom}
                          <span className="block">{r.validTo ?? t('stillRunning')}</span>
                        </>
                      ) : null}
                    </td>
                    {/* r210 — the ways out of a record, where the record is. Drawn once per VERSION, on
                        its first row: Stop and Delete act on the whole table, never on a service step. */}
                    <td className="px-3 py-2">
                      {r.firstOfTable && x ? (
                        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                          {x.validTo == null ? (
                            <Link
                              href={href(`?editTemplate=${encodeURIComponent(x.lineageId)}`)}
                              className="text-sm underline"
                            >
                              {t('edit')}
                            </Link>
                          ) : null}
                          {x.validTo == null ? (
                            <form action={retireEntitlementTemplateAction} className="flex items-center gap-1.5">
                              {returnField}
                              <input type="hidden" name="lineageId" value={x.lineageId} />
                              <input type="hidden" name="name" value={x.name} />
                              <input
                                className={rowDateCls}
                                type="date"
                                name="validTo"
                                defaultValue={today}
                                required
                                aria-label={t('stopFrom')}
                              />
                              <ConfirmSubmit
                                variant="outline"
                                size="sm"
                                title={t('stopTemplate')}
                                subtitle={x.name}
                                description={t('stopTemplateConfirm', { rules: ruleCounts.get(x.lineageId) ?? 0 })}
                              >
                                {t('stop')}
                              </ConfirmSubmit>
                            </form>
                          ) : null}
                          {/* Delete is a LINEAGE action, so it belongs on the lineage's current version and
                              on no other — including when that version is already stopped, which is exactly
                              the never-used record somebody wants to clear away. */}
                          {templateHeadIds.has(x.id) ? (
                            deleteBlockText(templateDeleteBlocks.get(x.lineageId)) ? (
                              <span className="max-w-[18rem] text-xs text-muted-foreground">
                                {deleteBlockText(templateDeleteBlocks.get(x.lineageId))}
                              </span>
                            ) : (
                              <form action={deleteEntitlementTemplateAction}>
                                {returnField}
                                <input type="hidden" name="lineageId" value={x.lineageId} />
                                <input type="hidden" name="name" value={x.name} />
                                <ConfirmSubmit
                                  size="sm"
                                  title={t('deleteTemplate')}
                                  subtitle={x.name}
                                  description={t('deleteTemplateConfirm')}
                                >
                                  {t('delete')}
                                </ConfirmSubmit>
                              </form>
                            )
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="border-t p-4">
          <h3 className="mb-3 text-sm font-medium">
            {editingTemplate ? t('editTemplateTitle') : t('newTemplateTitle')}
          </h3>
          {/* r224 — THE DATE BOX, THE NOTE AND THE SUBMIT SHARE ONE PIECE OF STATE, so they sit under one
              provider even though the form's layout puts them in three different places. Keyed on the
              record being edited for the same reason `EntitlementBandsEditor` below is: reaching this form
              is a client-side navigation, and `useState` reads its initial value once per instance. */}
          <EntitlementSaveModeProvider
            key={editingTemplate?.lineageId ?? 'new'}
            openValidFrom={editingTemplate?.validFrom ?? null}
            today={today}
          >
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
                {/* r224 — THE BOX OPENS ON THE VERSION'S OWN START DATE, WHICH IS THE WHOLE DEFECT.
                    It used to be pre-filled with TODAY for any version already in force, so pressing Save
                    without touching anything moved the date — and a moved date is exactly what asks for a new
                    version. In-place saving was built and unreachable. The field is CONTROLLED now because
                    the submit below labels itself from what is in it. See entitlement-save-mode.tsx. */}
                <EntitlementEffectiveFromField />
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
              {/* r224 — STATED WHERE IT IS ACTED ON, AND CHOSEN BY THE DATE IN THE BOX RATHER THAN BY WHICH
                  version this is. The note used to branch on whether the version had STARTED, so a version in
                  force was promised a supersede even in the case — an unchanged date — where the service
                  overwrites it.
                  Both the note and the button below now read `entitlementEditMode`, the same function the
                  service takes the decision with, over the CURRENT contents of the field above. On the CREATE
                  form nothing is shown: there is no running version to close.
                  ⚠️ r224 also added the warning this renders when an in-force version is overwritten. See the
                  note on `entitlementInPlaceChangesThePast` — three readers answer for a past date, so that
                  save changes what a closed leave year reports. It is allowed and it is said out loud. */}
              {editingTemplate ? <EntitlementSaveModeNote /> : null}
              {/* ── r224 · CREATE-TIME REACH WARNING ──────────────────────────────────────────────────────
                  Said AT THE MOMENT the table is typed, not afterwards. Until now the only notice that a
                  table reaches nobody was the health panel above, which is read once a whole set of tables
                  has already been built — the reporter's nine leave types are exactly that shape.

                  ⚠️ TWO DIFFERENT WARNINGS, because the answer for the FIRST table is the opposite of the
                  answer for the second. A leave type with ONE table in force and no rule hands that table to
                  everybody (the r193 fault-3 fallback, mirrored in `soleTableApplies`), so creating the first
                  table is healthy and is not warned about. Creating a SECOND one ENDS that fallback: from the
                  save, neither table resolves for anyone until a rule points at them. Flattening the two into
                  one sentence would either cry wolf over the commonest healthy shape in the product or stay
                  silent on the change that quietly switches a working leave type off.

                  Scoped mount only — the unfiltered screen cannot know which leave type the picker below is
                  about to name. */}
              {/* 76ffdcf2 — A THIRD ANSWER, and it is the one that makes the other two honest. Both
                  sentences above end "…reaches nobody until a benefit scheme names it", which stopped
                  being the whole truth the moment a leave type could name a DEFAULT table: with one in
                  force, everybody no scheme covers still resolves, and the new table is simply one more
                  table nobody is pointed at yet. Said in its own words rather than by amending a warning
                  whose premise no longer holds. */}
              {!editingTemplate && scoped && scopedHealth && newTableReachesNobody(scopedHealth) ? (
                <p className="text-xs font-medium text-amber-700 dark:text-amber-500">
                  {scopedHealth.defaultTableApplies
                    ? t('createWithDefaultTableNote', {
                        type: scopedTypeName,
                        table: scopedHealth.defaultTableName ?? '',
                      })
                    : scopedHealth.soleTableApplies
                      ? t('createEndsSoleTableWarning', { type: scopedTypeName })
                      : t('createNoRuleWarning', { type: scopedTypeName })}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <EntitlementSaveModeSubmit createLabel={t('createTemplate')} />
                {editingTemplate ? (
                  <Link href={href('?')} className="text-sm underline">
                    {t('cancel')}
                  </Link>
                ) : null}
              </div>
            </form>
          </EntitlementSaveModeProvider>

          {/* r210 — THE STOP FORM THAT STOOD HERE IS ON THE ROW NOW, and is not also left here. Two copies
              of one destructive control drift the first time either is touched, and the copy that lives
              several fields inside an Edit panel is the one nobody finds — which is the complaint this
              item opens with. The row carries the same date field and the same ConfirmSubmit subtitle. */}
        </div>
      </Card>

      {/* ── 76ffdcf2 · THE DEFAULT ENTITLEMENT TABLE: WHO A SCHEME NEVER REACHES ────────────────────
          The reporter read the old screens as saying a benefit scheme decides WHETHER somebody is
          entitled. It never did — but with two or more tables and no matching scheme the engine refused
          to guess, so an unmatched employee genuinely resolved to nothing. This control is the answer,
          and its shape is the safety argument: the fallback is a table a NAMED HUMAN chooses here, so
          "never hand out a table nobody chose" (r193 fault 3) survives intact and no days are invented.
          SCOPED MOUNT ONLY — the default belongs to ONE leave type, and a picker per type on the
          unfiltered screen would be a column of twenty-four saves. The unfiltered list still SHOWS which
          table is a default, on the row it belongs to. */}
      {scoped && scopedType ? (
        <Card>
          <SectionHeader title={t('defaultTableTitle')} />
          <div className="space-y-3 p-4">
            <p className="text-xs text-muted-foreground">{t('defaultTableIntro')}</p>
            <form action={setLeaveTypeDefaultTemplateAction} className="flex flex-wrap items-end gap-3">
              {returnField}
              <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
              <Field label={t('defaultTableTitle')}>
                <select
                  className={inputCls}
                  name="defaultTemplateLineageId"
                  defaultValue={scopedType.defaultEntitlementTemplateLineageId ?? ''}
                  data-testid="default-entitlement-table-select"
                >
                  {/* An EMPTY value is a real instruction — "no default" — and it is today's behaviour
                      for every leave type until somebody chooses otherwise. */}
                  <option value="">{t('defaultTableNone')}</option>
                  {templateOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
                {t('defaultTableSave')}
              </button>
            </form>
            {/* Only the IN-FORCE tables are offered: a default pointing at a stopped table applies to
                nobody, which would be a setting that reads as configured and does nothing. */}
            {templateOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('defaultTableNoTables')}</p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* ── STEP 2: WHO GETS WHICH TABLE ──────────────────────────────────────────────────────────
          r270 (995387c6) — GATED, NOT DELETED, AND DELIBERATELY NOT RE-INDENTED. The whole Card below —
          the schemes list AND the create/edit form under it — is one surface with one definition, and the
          unscoped mount was its second copy. `showBenefitSchemes` is read here and nowhere else, so the
          leave type's own tab keeps every field, button and action it has today.

          The body keeps its original indentation on purpose: re-indenting 275 lines to add one conditional
          would bury the actual change in a whitespace diff, and three guards in two files read literal
          substrings out of this Card (`t('colSchemeName')`, `t('rulesIntro')`, `t('rulesNamingTip')`). */}
      {showBenefitSchemes ? (
      <Card>
        <SectionHeader title={t('rulesTitle')} count={runningRules.length} />
        {/* 6aee1d91 — ONE VOCABULARY. This section IS what the employee's profile calls their Benefit
            Scheme (core/entitlement-scheme-view.ts names the winning rule here), so it is named that way
            here too and says so in one line. The mechanism underneath is untouched: a "scheme" is an
            entitlement_eligibility_rule row, matched and ranked exactly as before. */}
        <p className="border-b px-4 pb-3 text-xs text-muted-foreground">{t('rulesIntro')}</p>
        {/* r212 (8ebf77ae) — "NO ELIGIBILITY RULES YET" IS THE RIGHT ANSWER FOR A TYPE WITH ONE TABLE, and
            until now this card said it in the same words it uses for a type that is genuinely half-built.
            The reporter's Hospitalization Leave has one table, no rule, and works; the engine applies the
            sole table because there is nothing to choose between (r193 fault 3). Said here, beside the
            empty list, because that is where the absence is read. */}
        {soleTableTypeNames.length > 0 ? (
          <p className="border-b px-4 pb-3 text-xs text-muted-foreground">
            {t('soleTableNoRuleNeeded', { types: soleTableTypeNames.join(', ') })}
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                {/* 6aee1d91 — its own header, not the tables list's `colName`: the approved picture reads
                    Scheme name / Entitlement table / Covers / In force. */}
                <th className="px-3 py-2">{t('colSchemeName')}</th>
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
                /**
                 * r210 — THE TABLE THIS RULE POINTS AT HAS BEEN STOPPED, WHICH IS NOT THE SAME AS "NONE".
                 *
                 * Stopping a table deliberately leaves the rules pointing at it alone (see
                 * `retireEntitlementTemplate`): from that date they resolve no table in force and simply
                 * stop matching. Until r210 this cell printed a bare dash for that, which reads as a rule
                 * with nothing configured rather than as a rule that has just been cut off — the very
                 * shape r209 found on production. Named, so the consequence of a stop is visible on the
                 * rule it happened to and not only inside the confirmation dialog that caused it.
                 */
                const stoppedTarget = target ? null : templateHeads.get(x.templateLineageId);
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
                    <td className="px-3 py-2">
                      {target?.name ??
                        (stoppedTarget ? (
                          <span className="text-xs font-medium text-amber-700 dark:text-amber-500">
                            {t('ruleTargetStopped', { table: stoppedTarget.name })}
                          </span>
                        ) : (
                          dash
                        ))}
                    </td>
                    {/* An EMPTY criteria object is a real value that means EVERYONE — never a blank cell.
                        9e2a89e9 — through the SHARED summariser now: this cell used to print raw criteria
                        keys and a count (`gradeIds: 4`), which is readable to whoever wrote the code and
                        to nobody else. Same renderer as the tables list's Covers column. */}
                    <td className="px-3 py-2 text-xs">
                      {coversCell(x.criteria as Record<string, unknown>)}
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
                    {/* Same three row actions as a table's, for the same reason — see the note there. */}
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                        {x.validTo == null ? (
                          <Link href={href(`?editRule=${encodeURIComponent(x.lineageId)}`)} className="text-sm underline">
                            {t('edit')}
                          </Link>
                        ) : null}
                        {x.validTo == null ? (
                          <form action={retireEligibilityRuleAction} className="flex items-center gap-1.5">
                            {returnField}
                            <input type="hidden" name="lineageId" value={x.lineageId} />
                            <input type="hidden" name="name" value={x.name} />
                            <input
                              className={rowDateCls}
                              type="date"
                              name="validTo"
                              defaultValue={today}
                              required
                              aria-label={t('stopFrom')}
                            />
                            <ConfirmSubmit
                              variant="outline"
                              size="sm"
                              title={t('stopRule')}
                              subtitle={x.name}
                              description={t('stopRuleConfirm')}
                            >
                              {t('stop')}
                            </ConfirmSubmit>
                          </form>
                        ) : null}
                        {/* NOTHING POINTS AT A RULE, so a rule row carries no pre-computed blocker at
                            all — the only refusal it can meet is the granted one, which the delete
                            itself raises in words. See `deleteBlockText`. */}
                        {ruleHeadIds.has(x.id) ? (
                          <form action={deleteEligibilityRuleAction}>
                            {returnField}
                            <input type="hidden" name="lineageId" value={x.lineageId} />
                            <input type="hidden" name="name" value={x.name} />
                            <ConfirmSubmit
                              size="sm"
                              title={t('deleteRule')}
                              subtitle={x.name}
                              description={t('deleteRuleConfirm')}
                            >
                              {t('delete')}
                            </ConfirmSubmit>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="border-t p-4">
          {/* ── r212 (8ebf77ae) · WHAT THE LEAVE TYPE ALREADY DECIDES, READ-ONLY ──────────────────────
              The reporter's question, answered where it is asked: these conditions gate the OFFER and the
              APPLICATION, they already apply to every rule below, and repeating them here is the
              double-keying they complained about. Every label and value is derived from `criteriaSections`
              — the SAME vocabulary the pickers below are generated from — so the two lists cannot drift.
              Scoped mount only; see `scopedEligibility`. */}
          {scoped && scopedType ? (
            <div className="mb-4 rounded-md border border-border bg-muted/30 p-3">
              <p className="text-sm font-medium">{t('inheritedTitle')}</p>
              {inherited.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">{t('inheritedNone')}</p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">{t('inheritedNote')}</p>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    {inherited.map((row) => (
                      <div key={row.key} className="text-xs">
                        <dt className="inline font-medium text-foreground">{row.label}: </dt>
                        <dd className="inline text-muted-foreground">{row.values.join(', ')}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </div>
          ) : null}

          <h3 className="mb-3 text-sm font-medium">{editingRule ? t('editRuleTitle') : t('newRuleTitle')}</h3>
          {templateOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('rulesNeedTemplate')}</p>
          ) : (
            <>
              {/* ── r212 (8ebf77ae) · THE ONE-CLICK RULE SHAPE ────────────────────────────────────────
                  "Everyone this leave type is available to" — `createEligibilityRule` with criteria {}.
                  A CLIENT component, not a bare form, and the reason is the reach count: this is the one
                  shape in the product that always means EVERYBODY, and two headers in this codebase say the
                  screen must show that number before it lets anybody save (`countEligibilityTargetsAction`,
                  `EligibilityRuleForm`). See everyone-rule-form.tsx.
                  Offered only while CREATING: an edit already has criteria on screen to clear. */}
              {!editingRule ? (
                <EveryoneRuleForm
                  action={createEligibilityRuleAction}
                  countAction={countEligibilityTargetsAction}
                  templates={templateOptions}
                  today={today}
                  embeddedLeaveTypeId={leaveTypeId}
                />
              ) : null}

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
                /* r224 — the CREATE label only. While editing, the form labels its own submit from
                   `entitlementEditMode` over the date currently in its box; see entitlement-save-mode.tsx.
                   Passing a label computed here would be a second opinion about which write the save is,
                   resolved at render time against a date the operator can change afterwards. */
                submitLabel={t('createRule')}
                /* The running version's own start date, so the form can resolve the mode. */
                openValidFrom={editingRule?.validFrom ?? null}
                initial={
                  editingRule
                    ? {
                        lineageId: editingRule.lineageId,
                        name: editingRule.name,
                        templateLineageId: editingRule.templateLineageId,
                        // ⚠️ r224 — THE RULE'S OWN DATE, ALWAYS. This used to be `today` for a rule already
                        // in force, and pressing Save without touching the box therefore moved the date and
                        // superseded the rule. Correcting an eligibility rule in place was unreachable for
                        // exactly the same reason it was unreachable on the table above it.
                        validFrom: editingRule.validFrom,
                        criteria: editingRule.criteria as Record<string, string[] | string>,
                      }
                    : undefined
                }
              />
              {/* Stop moved to the row (see the note under the tables above). Cancel stays: it belonged to
                  the editor, not to the stop form it happened to be nested in, and without it there is no
                  way back out of an edit on this half of the screen. */}
              {editingRule ? (
                <div className="mt-4 border-t pt-4">
                  <Link href={href('?')} className="text-sm underline">
                    {t('cancel')}
                  </Link>
                </div>
              ) : null}
            </>
          )}
          {/* 6aee1d91 — the profile shows ONE name only when every leave type's winning scheme carries the
              same name (`benefitSchemeView`: ruleNames set of size 1); otherwise it says "does not resolve
              to a single scheme" and lists each type. That is by design, and this is where the operator
              can act on it, so it is said here rather than discovered on the profile. */}
          <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">{t('rulesNamingTip')}</p>
        </div>
      </Card>
      ) : null}
    </div>
  );
}
