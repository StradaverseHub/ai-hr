/**
 * Organisation-Assignment leave criteria (feedback: Enhance Leave Criteria Configuration).
 *
 * The eight catalogue-backed Organisation Assignment fields that a leave type's Condition · Criteria step can
 * restrict "who qualifies" by, ALONGSIDE the existing gender / marital / min-service / probation rules. Each
 * of the eight is a plain text column ON `employment` (org_division / org_branch / org_region / org_line /
 * org_section / org_team / org_base + employment_category — db/schema.ts) that stores a profile_option `value`
 * string, and each maps 1:1 to a profile_option category (division / branch / region / line / section / team /
 * base / category — see EMPLOYMENT_PROFILE_CATEGORIES + CATEGORY_EMPLOYMENT_COLUMN in core/profile-options.ts).
 *
 * ONE descriptor drives all three surfaces so adding/removing a field is a single line, never hand-wired
 * picker + summary row + gate in three places:
 *   - the two eligibility gates (assertEligible / isLeaveEligible in core/leave.ts) iterate it;
 *   - the Criteria form (one ChipMultiSelect per entry) + the read-only criteria table iterate it;
 *   - the action layer + cleanEligibility iterate it.
 *
 * Because all eight share ONE source (an employment text column) and ONE semantic (string equality against a
 * profile_option value), a FLAT map is valid here — the mixed-source problem that would arise for the DEFERRED
 * typed fields (Business Unit / Department / Position / Employment Type on the effective-dated `assignment`
 * table, and the UUID Job Grade) does NOT apply to this tranche, which is why those five are out of scope.
 *
 * This module is intentionally DB-free (only a type-only import) so the client `LeaveTypePanel` can import it
 * for the picker + summary without pulling in any server-only DB code.
 */
import type { ProfileOptionCategory } from './profile-options';

/**
 * One org-assignment criterion. `key` is BOTH the eligibility JSONB key and the `employment` column name
 * (Drizzle field) — they are identical by construction (the stored value is compared to `employment[key]`),
 * so a single field carries both roles. `category` feeds the picker its live active values from the shared
 * profile_option catalogue; `labelKey` is the i18n key (under `admin.profileOptions.category`, already shipped
 * in all six locales) reused for the criterion's label — no new translation strings are minted.
 */
export type OrgAssignmentCriterion = {
  key:
    | 'orgDivision'
    | 'orgBranch'
    | 'orgRegion'
    | 'orgLine'
    | 'orgSection'
    | 'orgTeam'
    | 'orgBase'
    | 'employmentCategory';
  category: ProfileOptionCategory;
  labelKey: string;
};

export const ORG_ASSIGNMENT_CRITERIA = [
  { key: 'orgDivision', category: 'division', labelKey: 'division' },
  { key: 'orgBranch', category: 'branch', labelKey: 'branch' },
  { key: 'orgRegion', category: 'region', labelKey: 'region' },
  { key: 'orgLine', category: 'line', labelKey: 'line' },
  { key: 'orgSection', category: 'section', labelKey: 'section' },
  { key: 'orgTeam', category: 'team', labelKey: 'team' },
  { key: 'orgBase', category: 'base', labelKey: 'base' },
  { key: 'employmentCategory', category: 'category', labelKey: 'category' },
] as const satisfies readonly OrgAssignmentCriterion[];

/** The eight eligibility keys (= employment column names) this tranche adds. */
export type OrgAssignmentCriterionKey = (typeof ORG_ASSIGNMENT_CRITERIA)[number]['key'];
