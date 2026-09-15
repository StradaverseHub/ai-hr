import { getTranslations } from 'next-intl/server';

import { listCompanies, listDepartments, listEmployees } from '@/core/read';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { listAllProfileOptions } from '@/core/profile-options';
import type { EmployeePickOption } from '@/lib/employment-selection';
import type { SessionContext } from '@/db/client';

/**
 * 6e122302 — the audience picker's vocabulary, resolved once for both the New and Edit screens.
 *
 * ⚠️ WHY THIS IS ITS OWN FILE. It opens THREE i18n namespaces, and `test/i18n-coverage.test.ts` check C
 * skips any file using more than one — which is precisely how r127 shipped a screen whose every criteria
 * chip rendered a MISSING_MESSAGE while tsc, the suite, `next build` and the route's 200 all stayed green.
 * Isolating the multi-namespace code in one small module keeps BOTH page files single-namespace and
 * therefore fully covered by check C, and leaves exactly one file needing a bespoke guard —
 * `test/notice-board.test.ts` pins every key this file can produce, including the dynamic ones check C
 * could never see.
 *
 * NO NEW TRANSLATION STRINGS ARE MINTED HERE. Both label sets already ship, fully translated in all six
 * locales, and are read where they live: the eight org axes under `admin.profileOptions.category` (which
 * is what ORG_ASSIGNMENT_CRITERIA's own header says `labelKey` indexes) and the employment types under
 * `people.wizard.employmentType`, the same vocabulary the hiring wizard writes them with. A seventh copy
 * would be a seventh thing to keep in step.
 */

/** The four employment types `assignment.employment_type` accepts, in the hiring wizard's order. */
export const EMPLOYMENT_TYPE_VALUES = ['full_time', 'part_time', 'contract', 'intern'] as const;

export type CriteriaVocabulary = {
  companies: { value: string; label: string }[];
  departments: { value: string; label: string }[];
  employmentTypes: { value: string; label: string }[];
  orgCriteria: { key: string; label: string; options: { value: string; label: string }[] }[];
  /**
   * r288 (8521e160) — the OTHER half of the audience step's vocabulary: the people themselves, for
   * "individual" targeting's picker.
   *
   * It lives here for the same reason the criteria do — the New and Edit screens must offer the SAME
   * audience or the two can drift — and reading it once here keeps both page files free of a second
   * `listEmployees` call to keep in step.
   *
   * THREE PLAIN FIELDS, NO SENTENCES. `NoticeForm` is a client island and composes every string it shows
   * on its own side of the boundary (test/server-client-boundary.test.ts pins the class).
   */
  employees: EmployeePickOption[];
};

export async function criteriaVocabulary(s: SessionContext): Promise<CriteriaVocabulary> {
  const tOrg = await getTranslations('admin.profileOptions.category');
  const tEmploymentType = await getTranslations('people.wizard.employmentType');

  const [companies, departments, profileOptions] = await Promise.all([
    listCompanies(s),
    listDepartments(s),
    listAllProfileOptions(s),
  ]);

  /**
   * Scoped to the administrator's own companies, exactly as the two leave screens' identical read is.
   *
   * ⚠️ NOT FILTERED TO ACTIVE EMPLOYMENTS, and that is a decision rather than an omission — the same one
   * r287 recorded on Generate Entitlement. The picker is the SECOND door onto the population the paste box
   * has always reached, and narrowing one door but not the other is how "two ways in, one list out" stops
   * being true. `publishNotice` decides who a notice actually reaches, identically for both doors.
   *
   * `listEmployees` is the UNPAGINATED read on purpose (see its header): a checkbox set that silently drops
   * people past a page boundary is exactly the defect an audience picker cannot afford.
   */
  const employees = await listEmployees(
    s,
    companies.map((c) => c.id),
  );

  return {
    employees: employees.map((e) => ({ id: e.employmentId, name: e.name, employeeCode: e.employeeCode })),
    companies: companies.map((c) => ({ value: c.id, label: c.name })),
    departments: departments.map((d) => ({ value: d.id, label: d.name })),
    employmentTypes: EMPLOYMENT_TYPE_VALUES.map((v) => ({ value: v, label: tEmploymentType(v) })),
    // The eight org axes come from the same profile-option catalogue the leave-type Condition step and the
    // Leave Adjustments screen read, so all three offer the same vocabulary rather than three lists that
    // drift. ProfileOptionRow carries value + label; the resolver matches on the stored VALUE, so that is
    // what the criteria post — showing the label while posting the value is the whole point.
    orgCriteria: ORG_ASSIGNMENT_CRITERIA.map((c) => ({
      key: c.key as string,
      label: tOrg(c.labelKey),
      options: (profileOptions[c.category] ?? [])
        .filter((o) => o.isActive)
        .map((o) => ({ value: o.value, label: o.label })),
    })),
  };
}
