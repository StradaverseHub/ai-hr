/**
 * "WHO DOES THIS APPLY TO", AS A FORM — ONE builder, for every screen that asks the question.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────────────────────────────
 * `core/org-criteria.ts` is the one RESOLVER. This is the one PICKER that feeds it. They are two halves of
 * the same contract and both halves have to be shared, because the failure mode of forking the picker is
 * silent in a way that forking the resolver is not: a control whose `name` is not a member of
 * `ORG_CRITERIA_FIELDS` renders perfectly, posts perfectly, and narrows NOBODY. Nothing throws. The screen
 * simply selects more people than the operator asked for.
 *
 * 18103ba4 built this section list inside `app/admin/leave/adjustments/page.tsx`. 93249794 (Generate
 * Entitlement) needs the identical question answered on a second screen, and its own build notes are blunt
 * about the alternative: "Two criteria engines is the duplicate-maintenance complaint reproduced." Copying
 * 70 lines of section definitions would have reproduced it one layer up from the resolver — same defect,
 * different file. So the BODY moved here, unchanged, and both pages call it.
 *
 * The consequence that makes it worth doing: an axis added to `core/org-criteria.ts` is added to BOTH
 * screens by adding it once, HERE. "Finance + Executive" cannot come to mean different people on the
 * Adjustments screen and the Generate screen, because there is only one list.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────────────────
 * JOB TITLE, EMPLOYEE GROUP and EMPLOYEE CLASS — the three 18103ba4's reporter asked for and the schema
 * holds no column, catalogue or import field for. See `core/org-criteria.ts`'s header. `absentNote` says so
 * on screen rather than leaving an operator hunting for a promised field.
 *
 * ── WHY THE LABELS ARRIVE AS FUNCTIONS ────────────────────────────────────────────────────────────────
 * This module is imported by SERVER components only and returns PLAIN DATA. The three translators are
 * passed in rather than resolved here so the caller keeps ownership of its namespaces (the i18n guard's
 * check C reads one namespace per file), and so nothing in this module needs `next-intl/server`. The
 * returned sections are serialisable, which is what lets a server page hand them to a client form without
 * crossing the r123 boundary — a translator CLOSURE must never make that trip, and none does.
 */
import { CONFIRMATION_STATUSES } from './org-criteria';
import { EMPLOYMENT_STATUSES } from './employment-status';
import { ORG_ASSIGNMENT_CRITERIA } from './leave-org-criteria';
import type { ProfileOptionCategory, ProfileOptionRow } from './profile-options';

export type CriteriaOption = { value: string; label: string };

/**
 * One criteria control. `kind` decides what it posts and how the live count reads it back:
 *  - 'multi'  → a ChipMultiSelect, posting 0..n values under `name` (read with getAll)
 *  - 'date'   → an <input type=date>, posting 0..1 values (read with get)
 *  - 'number' → an <input type=number>, likewise
 *
 * ⚠️ `name` IS A CONTRACT, NOT A LABEL. Every one must be a member of `ORG_CRITERIA_FIELDS` /
 * `ORG_CRITERIA_RANGE_FIELDS` in core/org-criteria.ts. `test/leave-adjustment-step-flow.test.ts` pins the
 * two lists against each other, against exactly the silent failure described in this file's header.
 */
export type CriteriaField = { name: string; label: string; kind: 'multi' | 'date' | 'number'; options?: CriteriaOption[] };
export type CriteriaSection = { key: string; title: string; fields: CriteriaField[]; note?: string };

/** The catalogue rows only a server component can read. Every list is already scoped by RLS. */
export type OrgCriteriaCatalogues = {
  companies: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  grades: { id: string; name: string }[];
  positions: { id: string; title: string }[];
  costCenters: { id: string; code: string; name: string }[];
  businessUnits: { id: string; code: string; name: string }[];
  locations: { id: string; code: string; name: string }[];
  profileOptions: Partial<Record<ProfileOptionCategory, ProfileOptionRow[]>>;
};

/** The three translators the sections need, as plain functions. See the header for why they are injected. */
export type OrgCriteriaLabels = {
  /** `admin.leave.adjustmentsCriteria` — the axis names and the section titles. */
  crit: (key: string) => string;
  /** `admin.profileOptions.category` — the eight Organisation Assignment axes, already shipped in six locales. */
  org: (key: string) => string;
  /** `people.wizard.employmentType` — the same vocabulary the hiring wizard writes them with. */
  employmentType: (key: string) => string;
};

/**
 * The reporter's four groups, in their order. Every `name` is a field the shared resolver understands.
 *
 * Moved here VERBATIM from app/admin/leave/adjustments/page.tsx (18103ba4) — the field list, the order, the
 * labels and the comments are unchanged, so the Adjustments screen offers exactly what it offered before
 * and `test/leave-adjustment-step-flow.test.ts` is asserting the same thing about the same names.
 */
export function buildOrgCriteriaSections(c: OrgCriteriaCatalogues, t: OrgCriteriaLabels): CriteriaSection[] {
  const active = (category: ProfileOptionCategory): CriteriaOption[] =>
    (c.profileOptions[category] ?? []).filter((o) => o.isActive).map((o) => ({ value: o.value, label: o.label }));
  // The eight org axes come from the same profile-option catalogue the leave-type Condition step reads, so
  // every screen offers the same vocabulary rather than lists that drift. The eligibility engine matches on
  // the stored VALUE, so that is what the criteria post — showing the label while posting the value is the
  // whole point.
  const org = (key: string): CriteriaField => {
    const spec = ORG_ASSIGNMENT_CRITERIA.find((x) => x.key === key)!;
    return { name: spec.key, kind: 'multi', label: t.org(spec.labelKey), options: active(spec.category) };
  };

  return [
    {
      key: 'company',
      title: t.crit('sectionCompany'),
      fields: [
        { name: 'companyIds', label: t.crit('company'), kind: 'multi', options: c.companies.map((x) => ({ value: x.id, label: x.name })) },
        { name: 'businessUnitIds', label: t.crit('businessUnit'), kind: 'multi', options: c.businessUnits.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })) },
        org('orgDivision'),
        { name: 'departmentIds', label: t.crit('department'), kind: 'multi', options: c.departments.map((d) => ({ value: d.id, label: d.name })) },
        org('orgSection'),
        org('orgTeam'),
        org('orgBranch'),
        { name: 'locationIds', label: t.crit('location'), kind: 'multi', options: c.locations.map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` })) },
        // Region / Line / Base were narrowing options BEFORE 18103ba4 and are not on that reporter's list.
        // Dropping them to match a mock exactly would be a silent removal of working behaviour, so they
        // stay, in the group they belong to.
        org('orgRegion'),
        org('orgLine'),
        org('orgBase'),
      ],
    },
    {
      key: 'employment',
      title: t.crit('sectionEmployment'),
      fields: [
        { name: 'employmentTypes', label: t.crit('employmentType'), kind: 'multi', options: ['full_time', 'part_time', 'contract', 'intern'].map((v) => ({ value: v, label: t.employmentType(v) })) },
        // DERIVED, as at the effective date — core/employment-status.ts, via its SQL twin. Not a stored
        // column, which is why it can be resolved for a backdated action at all.
        { name: 'employmentStatuses', label: t.crit('employeeStatus'), kind: 'multi', options: EMPLOYMENT_STATUSES.map((v) => ({ value: v, label: t.crit(`status_${v}`) })) },
        { name: 'gradeIds', label: t.crit('jobGrade'), kind: 'multi', options: c.grades.map((g) => ({ value: g.id, label: g.name })) },
        { name: 'positionIds', label: t.crit('position'), kind: 'multi', options: c.positions.map((p) => ({ value: p.id, label: p.title })) },
        { name: 'costCenterIds', label: t.crit('costCentre'), kind: 'multi', options: c.costCenters.map((x) => ({ value: x.id, label: `${x.code} — ${x.name}` })) },
      ],
    },
    {
      key: 'employee',
      title: t.crit('sectionEmployee'),
      fields: [
        org('employmentCategory'),
        // PDPA s.40 sensitive demographics, read from `person`. Asked for by name — see the header of
        // core/org-criteria.ts for why that mattered before they were implemented.
        { name: 'genders', label: t.crit('gender'), kind: 'multi', options: [
          { value: 'male', label: t.crit('genderMale') },
          { value: 'female', label: t.crit('genderFemale') },
          { value: 'undisclosed', label: t.crit('genderUndisclosed') },
        ] },
        { name: 'nationalities', label: t.crit('nationality'), kind: 'multi', options: active('nationality') },
        { name: 'religions', label: t.crit('religion'), kind: 'multi', options: active('religion') },
        { name: 'races', label: t.crit('race'), kind: 'multi', options: active('race') },
      ],
      note: t.crit('absentNote'),
    },
    {
      key: 'service',
      title: t.crit('sectionService'),
      fields: [
        { name: 'hiredFrom', label: t.crit('hiredFrom'), kind: 'date' },
        { name: 'hiredTo', label: t.crit('hiredTo'), kind: 'date' },
        // DERIVED from the hire date AS AT the effective date, never stored — see yearsOfServiceSql.
        { name: 'minYearsOfService', label: t.crit('minYears'), kind: 'number' },
        { name: 'maxYearsOfService', label: t.crit('maxYears'), kind: 'number' },
        // ONE axis for both "Confirmation Status" AND "Probation Status": they are the same predicate, and
        // two controls for one rule is how they start disagreeing.
        { name: 'confirmationStatuses', label: t.crit('confirmationStatus'), kind: 'multi', options: CONFIRMATION_STATUSES.map((v) => ({ value: v, label: v === 'confirmed' ? t.crit('confirmed') : t.crit('onProbation') })) },
      ],
    },
  ];
}
