/**
 * r304 (board 85875e4b "Edit Function") · APPROVAL WORKFLOW — THE TEMPLATE EDIT DRAWER, RENDERED.
 *
 * PIN FIRST. This case was written and committed BEFORE the drawer existed, against the inline form, so the
 * markup of the four row actions the plan promises are untouched (Duplicate, Set as default / Unset default,
 * Deactivate / Activate, Delete behind ConfirmSubmit) is the markup main shipped, not the markup this round
 * produced.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import {
  ApprovalTemplateManager,
  type TemplateManagerLabels,
  type TemplateRow,
} from '../app/admin/leave-approval/template-manager';

const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

afterEach(() => cleanup());

const la = (loc: Locale) => (CATALOGUES[loc] as unknown as { leaveApproval: Record<string, string> }).leaveApproval;

/** The label bag exactly as app/admin/leave-config/approval-chains/page.tsx builds it, read from a catalogue. */
function labelsFor(loc: Locale): TemplateManagerLabels {
  const m = la(loc);
  const same = [
    'requireMultiStep', 'templatesTitle', 'templatesHint', 'addTemplate', 'editTemplate', 'duplicateTemplate',
    'deleteTemplate', 'deleteTemplateConfirm', 'deactivateTemplate', 'activateTemplate', 'templateName',
    'templateNamePlaceholder', 'templateDescription', 'statusActive', 'statusInactive', 'tenantDefault',
    'tenantDefaultHint', 'setTenantDefault', 'unsetTenantDefault', 'assignmentsTitle', 'assignmentsHint', 'assign',
    'assignTemplate', 'selectTemplate', 'selectCompanies', 'selectLeaveTypes', 'selectEligibilityRules', 'selectAll',
    'deselectAll', 'panelNoneMeansAll', 'panelPickAtLeastOne', 'noEligibilityRules', 'ruleNotAssignable',
    'legacyGradeScope', 'ruleScopeUnknown', 'conditions', 'addCondition', 'conditionOperator', 'conditionValue',
    'opGreaterThan', 'opLessThan', 'opBetween', 'leaveDuration', 'valueDays', 'noTemplates', 'noAssignments',
    'unassign', 'unassignConfirm', 'rolesGatedNote', 'save', 'cancel', 'chain', 'empty', 'manager', 'departmentHead',
    'businessUnitHead', 'hr', 'hrManager', 'payroll', 'customRole', 'managerManager', 'specificEmployee', 'add',
    'moveUp', 'moveDown', 'remove', 'dragToReorder', 'badgeDynamic', 'badgeFixed', 'flowStart', 'flowEnd', 'addLevel',
    'fixedWarning', 'fixedApproverEnded', 'fixedApproverMissing', 'modeTitle', 'modeSequential',
    'modeSequentialHint', 'modeAnyOne', 'modeAnyOneHint', 'addAlternate', 'orLabel', 'badgeAnyOne',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of same) {
    expect(m[k], `${loc}.leaveApproval.${k}`).toBeTruthy();
    out[k] = m[k];
  }
  return {
    ...(out as Omit<TemplateManagerLabels, 'templateCol' | 'leaveTypeCol' | 'companyCol' | 'levelTemplate' | 'hints' | 'employeeSearch'>),
    templateCol: m.templateCol,
    leaveTypeCol: m.leaveType,
    companyCol: m.company,
    levelTemplate: m.levelN,
    hints: {
      direct_manager: m.hintDirectManager,
      manager_manager: m.hintManagerManager,
      department_head: m.hintDepartmentHead,
      business_unit_head: m.hintBusinessUnitHead,
      hr_admin: m.hintHr,
      hr_manager: m.hintHrManager,
      payroll: m.hintPayroll,
      custom_role: m.hintCustomRole,
      specific_employee: m.hintSpecificEmployee,
    },
    employeeSearch: {
      placeholder: m.previewSearchPlaceholder,
      ariaLabel: m.previewSearchAria,
      resultsLabel: m.previewSearchResults,
      noMatches: m.previewSearchNoMatches,
      clear: m.previewSearchClear,
    },
  };
}

const STANDARD: TemplateRow = {
  id: 'tpl-standard',
  name: 'Standard Leave Approval',
  description: 'Manager then HR',
  levels: [
    { kind: 'direct_manager', employmentId: null, alternates: [] },
    { kind: 'hr_admin', employmentId: null, alternates: [] },
  ],
  isTenantDefault: true,
  active: true,
  assignedCount: 2,
};
const SENIOR: TemplateRow = {
  id: 'tpl-senior',
  name: 'Senior Staff',
  description: null,
  levels: [{ kind: 'department_head', employmentId: null, alternates: [] }],
  isTenantDefault: false,
  active: true,
  assignedCount: 0,
};
const ARCHIVED: TemplateRow = {
  id: 'tpl-archived',
  name: 'Old Flow',
  description: null,
  levels: [{ kind: 'hr_admin', employmentId: null, alternates: [] }],
  isTenantDefault: false,
  active: false,
  assignedCount: 0,
};
const TEMPLATES = [STANDARD, SENIOR, ARCHIVED];

const noop = vi.fn(async () => undefined);

function mount(loc: Locale, over: Partial<React.ComponentProps<typeof ApprovalTemplateManager>> = {}) {
  const errors: string[] = [];
  const view = render(
    <NextIntlClientProvider
      locale={loc}
      messages={CATALOGUES[loc]}
      onError={(e) => errors.push(String((e as Error).message ?? e))}
    >
      <ApprovalTemplateManager
        templates={TEMPLATES}
        labels={labelsFor(loc)}
        actions={{
          saveTemplate: noop as never,
          duplicateTemplate: noop,
          setActive: noop,
          deleteTemplate: noop,
          setDefault: noop,
        }}
        {...over}
      />
    </NextIntlClientProvider>,
  );
  return { view, errors };
}

/** Every template row (the <li> holding the name). */
const rowOf = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLLIElement;

/** The row's action FORMS — everything the plan says works exactly as today — with Radix's generated ids
 *  normalised (they depend on mount order, not on the product). */
function rowActionsMarkup(li: HTMLElement): string {
  return [...li.querySelectorAll('form')]
    .map((f) => f.outerHTML)
    .join('\n')
    .replace(/radix-[^"]+/g, 'radix-ID');
}

describe('r304 · the row actions are pinned as main shipped them', () => {
  it('Duplicate, Set as default / Remove default, Deactivate / Activate and Delete render byte-for-byte as on main', () => {
    // test/fixtures/r304-row-actions-main.json was captured from main@36b0602f, BEFORE the drawer, by
    // rendering this same component with these same three templates (default + active, active, inactive).
    const pinned = JSON.parse(
      readFileSync(join(__dirname, 'fixtures/r304-row-actions-main.json'), 'utf8'),
    ) as Record<string, string>;
    mount('en');
    for (const t of TEMPLATES) {
      expect(rowActionsMarkup(rowOf(t.name)), `${t.name}: the row actions changed`).toBe(pinned[t.id]);
    }
    expect(LOCALES).toHaveLength(6);
  });
});
