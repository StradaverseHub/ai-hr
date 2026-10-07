/**
 * r304 (board 85875e4b "Edit Function") · APPROVAL WORKFLOW — THE TEMPLATE EDIT DRAWER, RENDERED.
 *
 * Everything here is client state: the drawer, its exit animation, the dirty check and its confirm, the
 * refused-save banner, the toast and where focus lands. A server render and a curl of the page see none of
 * it, so it is mounted under the SHIPPING catalogues in all six locales with next-intl's onError collected
 * and asserted empty (CLAUDE.md §8), and clicked.
 *
 * PIN FIRST. The row-actions case at the foot was written and committed BEFORE the drawer existed
 * (2d36bf9a, against main@36b0602f), so the markup of the four row actions the plan promises are untouched —
 * Duplicate, Set as default / Remove default, Deactivate / Activate, Delete behind ConfirmSubmit — is the
 * markup main shipped, not the markup this round produced.
 *
 * NO DEV-SERVER RENDER WAS DONE FOR THIS ROUND (the dev database has no users and the seeder is refused);
 * this file is the render check.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

const { refresh, toastSuccess, toastError } = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import {
  ApprovalTemplateManager,
  type SaveTemplateResult,
  type TemplateManagerLabels,
  type TemplateRow,
} from '../app/admin/leave-approval/template-manager';
import { DRAWER_EXIT_ANIMATION } from '../components/ui/drawer';

const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

afterEach(() => cleanup());
beforeEach(() => {
  refresh.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

const commonSave = (loc: Locale) => (CATALOGUES[loc] as unknown as { common: { save: string } }).common.save;
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
    'unassign', 'unassignConfirm', 'rolesGatedNote', 'cancel', 'chain', 'empty', 'manager', 'departmentHead',
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
    ...(out as Omit<TemplateManagerLabels, 'save' | 'templateCol' | 'leaveTypeCol' | 'companyCol' | 'levelTemplate' | 'hints' | 'employeeSearch'>),
    // r304 fix 3 — the drawer's button is the plain common "Save" (the plan and mockup), not "Save chain".
    save: commonSave(loc),
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

type SaveMock = ReturnType<typeof vi.fn<(fd: FormData) => Promise<SaveTemplateResult>>>;

/** A named-approver template: its level 1 renders the employee search whose suggestions Escape must close. */
const EMP_A = '11111111-1111-4111-8111-111111111111';
const EMP_B = '22222222-2222-4222-8222-222222222222';
const EMPLOYEES = [
  { value: EMP_A, name: 'Aisha Rahman', employeeCode: 'EMP-0001' },
  { value: EMP_B, name: 'Bala Kumar', employeeCode: 'EMP-0002' },
];
const NAMED: TemplateRow = {
  id: 'tpl-named',
  name: 'Named Approver Flow',
  description: null,
  levels: [
    { kind: 'specific_employee', employmentId: EMP_A, alternates: [] },
    { kind: 'hr_admin', employmentId: null, alternates: [] },
  ],
  isTenantDefault: false,
  active: true,
  assignedCount: 0,
};

/** What a thrown transition reaches when nothing catches it: the page's error boundary, and the drawer gone. */
class Boundary extends React.Component<{ children: React.ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { err: String(e?.message ?? e) };
  }
  render() {
    return this.state.err ? <p data-testid="error-boundary">{this.state.err}</p> : this.props.children;
  }
}

function managerNode(loc: Locale, save: SaveMock, templates: TemplateRow[] = TEMPLATES) {
  return (
    <ApprovalTemplateManager
      templates={templates}
      labels={labelsFor(loc)}
      employees={EMPLOYEES}
      actions={{
        saveTemplate: save,
        duplicateTemplate: noop,
        setActive: noop,
        deleteTemplate: noop,
        setDefault: noop,
      }}
    />
  );
}

function mount(loc: Locale, save: SaveMock = vi.fn(), templates: TemplateRow[] = TEMPLATES) {
  const errors: string[] = [];
  const wrap = (node: React.ReactNode) => (
    <NextIntlClientProvider
      locale={loc}
      messages={CATALOGUES[loc]}
      onError={(e) => errors.push(String((e as Error).message ?? e))}
    >
      <Boundary>{node}</Boundary>
    </NextIntlClientProvider>
  );
  const view = render(wrap(managerNode(loc, save, templates)));
  const rerender = (next: TemplateRow[]) => view.rerender(wrap(managerNode(loc, save, next)));
  return { view, errors, save, rerender };
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

/**
 * r400 — the Monolith primitives append `monolith:`-scoped utilities to Button's classes. Those do not match
 * outside <html data-ui-theme="monolith">, so they change nothing Classic paints (proven in a real engine by
 * test/r400-monolith-primitives.browser.test.tsx); the pin below is on everything ELSE, byte for byte. The
 * strip is exact: only whole `monolith:` tokens inside class attributes are removed, and the result must not
 * still contain one (so a renamed variant cannot slip through as an unstripped token).
 */
function withoutMonolithClasses(markup: string): string {
  const out = markup.replace(/class="([^"]*)"/g, (_m, cls: string) =>
    `class="${cls.split(' ').filter((t) => !t.startsWith('monolith:')).join(' ')}"`,
  );
  expect(out).not.toContain('monolith:');
  return out;
}

const fill = (template: string, name: string) => template.replace('{name}', name);
const closeLabel = (loc: Locale) => (CATALOGUES[loc] as unknown as { components: { drawer: { close: string } } }).components.drawer.close;
const editButtonOf = (loc: Locale, name: string) =>
  within(rowOf(name)).getByRole('button', { name: la(loc).editTemplate, hidden: true });
/** The drawer, found even while a confirm on top of it has hidden it from the accessibility tree. */
const drawerEl = () => screen.queryByRole('dialog', { hidden: true });
const overlayEl = () => document.querySelector<HTMLElement>('.ui-drawer-overlay');

/** Finish the exit the way a browser does: the panel's slide-out keyframes END. */
function endAnimation(name: string = DRAWER_EXIT_ANIMATION) {
  const panel = document.querySelector<HTMLElement>('.ui-drawer-panel');
  if (!panel) return;
  const ev = new Event('animationend', { bubbles: true });
  Object.defineProperty(ev, 'animationName', { value: name });
  act(() => {
    panel.dispatchEvent(ev);
  });
}
async function closeFully() {
  endAnimation();
  await waitFor(() => expect(drawerEl()).toBeNull());
}
/** Radix registers its outside-pointer listener a tick after the layer mounts. */
const settle = (ms = 20) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

const NIGHT: TemplateRow = {
  id: 'tpl-night',
  name: 'Night Shift',
  description: null,
  levels: [
    { kind: 'direct_manager', employmentId: null, alternates: [] },
    { kind: 'hr_admin', employmentId: null, alternates: [] },
  ],
  isTenantDefault: false,
  active: true,
  assignedCount: 0,
};

describe.each(LOCALES)('r304 · %s · the template drawer', (loc) => {
  const L = la(loc);

  it('Edit opens a drawer titled "Edit: <name>" holding the same fields; the row is marked; Cancel / Save sit in the sticky footer', async () => {
    const { errors } = mount(loc);
    const edit = editButtonOf(loc, SENIOR.name);
    await userEvent.click(edit);

    const dialog = screen.getByRole('dialog', { name: fill(L.drawerEditTitle, SENIOR.name) });
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const body = dialog.querySelector<HTMLElement>('[data-drawer-body]')!;
    const footer = dialog.querySelector<HTMLElement>('[data-drawer-footer]')!;

    // The same fields as the inline form had: name, description, multi-step, the step editor.
    expect((within(body).getByLabelText(L.templateName) as HTMLInputElement).value).toBe(SENIOR.name);
    expect((within(body).getByLabelText(L.templateDescription) as HTMLInputElement).value).toBe('');
    expect((within(body).getByLabelText(L.requireMultiStep) as HTMLInputElement).checked).toBe(false);
    const level1 = within(body).getByRole('combobox', { name: L.levelN.replace('{n}', '1') }) as HTMLSelectElement;
    expect(level1.value).toBe('department_head');
    const form = body.querySelector('form')!;
    expect(form.querySelector('input[name="templateId"]')?.getAttribute('value')).toBe(SENIOR.id);

    // Cancel and Save are in the footer, OUTSIDE the scrolling body; Save posts the form by id.
    const save = within(footer).getByRole('button', { name: commonSave(loc) });
    expect(save.getAttribute('type')).toBe('submit');
    expect(save.getAttribute('form')).toBe(form.id);
    expect(within(footer).getByRole('button', { name: L.cancel })).toBeTruthy();
    expect(within(footer).queryByRole('button', { name: L.save }), 'the footer still says "Save chain"').toBeNull();
    expect(body.contains(save)).toBe(false);
    expect(body.className).toContain('overflow-y-auto');
    expect(footer.className).toContain('shrink-0');

    // The row being edited is marked — a coloured left edge and a tint — and no other row is.
    const row = rowOf(SENIOR.name);
    expect(row.hasAttribute('data-editing')).toBe(true);
    expect(row.className).toContain('border-l-4');
    expect(row.className).toContain('border-l-primary');
    expect(row.className).toContain('bg-primary/5');
    expect(rowOf(STANDARD.name).hasAttribute('data-editing')).toBe(false);
    // …and the form is no longer rendered under the list.
    expect(row.closest('ul')!.parentElement!.querySelector('form#' + form.id)).toBeNull();

    // Keyboard focus moved inside the drawer.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('Add template opens the same drawer, headed "Add template", on an empty multi-step form', async () => {
    const { errors } = mount(loc);
    await userEvent.click(screen.getByRole('button', { name: L.addTemplate }));
    const dialog = screen.getByRole('dialog', { name: L.addTemplate });
    expect(dialog.classList.contains('ui-drawer-panel')).toBe(true);
    expect((within(dialog).getByLabelText(L.templateName) as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText(L.requireMultiStep) as HTMLInputElement).checked).toBe(true);
    expect(dialog.querySelector('input[name="templateId"]')).toBeNull();
    expect(document.querySelectorAll('[data-editing]')).toHaveLength(0);
    // Add template is no longer hidden while a template is open.
    expect(screen.getByRole('button', { name: L.addTemplate, hidden: true })).toBeTruthy();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('X on an unchanged template closes at once — no question, no save — and focus returns to its Edit button', async () => {
    const { errors, save } = mount(loc);
    const edit = editButtonOf(loc, SENIOR.name);
    await userEvent.click(edit);
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: closeLabel(loc) }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(dialog.getAttribute('data-state')).toBe('closed');
    expect(rowOf(SENIOR.name).hasAttribute('data-editing')).toBe(false);
    await closeFully();
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(save).not.toHaveBeenCalled();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('closing with a change asks in this language; Keep editing keeps drawer and edits; Discard closes without saving', async () => {
    const { errors, save } = mount(loc);
    const edit = editButtonOf(loc, SENIOR.name);
    await userEvent.click(edit);
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText(L.templateName) as HTMLInputElement;
    await userEvent.type(nameInput, ' v2');

    const cancel = within(dialog).getByRole('button', { name: L.cancel });
    await userEvent.click(cancel);
    let confirm = screen.getByRole('alertdialog', { name: L.discardTitle });
    expect(within(confirm).getByText(L.discardBody)).toBeTruthy();
    expect(within(confirm).getByRole('button', { name: L.discardConfirm })).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: L.discardKeep }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(nameInput.value).toBe(`${SENIOR.name} v2`);
    // "Keep editing" puts the keyboard back inside the drawer, on its first field, whatever asked to close.
    await waitFor(() => expect(document.activeElement).toBe(nameInput));

    await userEvent.click(within(dialog).getByRole('button', { name: closeLabel(loc) }));
    confirm = screen.getByRole('alertdialog', { name: L.discardTitle });
    await userEvent.click(within(confirm).getByRole('button', { name: L.discardConfirm }));
    expect(dialog.getAttribute('data-state')).toBe('closed');
    await closeFully();
    expect(save).not.toHaveBeenCalled();

    // Reopening starts from the saved values, never from the discarded edit.
    await userEvent.click(edit);
    expect((within(screen.getByRole('dialog')).getByLabelText(L.templateName) as HTMLInputElement).value).toBe(SENIOR.name);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('"Keep editing" after a click on the dimmed list puts keyboard focus back INSIDE the drawer, on its first field', async () => {
    const { errors, save } = mount(loc);
    await userEvent.click(editButtonOf(loc, SENIOR.name));
    await settle();
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText(L.templateName) as HTMLInputElement;
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: L.levelN.replace('{n}', '1') }), 'hr_manager');

    // The close attempt comes from OUTSIDE the drawer. A real browser moves focus to <body> on a mousedown
    // over the non-focusable overlay (Radix's trap ignores a focusout with no relatedTarget); jsdom's
    // user-event leaves it where it was, so the test does what the browser does.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    await userEvent.click(overlayEl()!);
    const confirm = screen.getByRole('alertdialog', { name: L.discardTitle });
    await userEvent.click(within(confirm).getByRole('button', { name: L.discardKeep }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(dialog.getAttribute('data-state')).toBe('open');
    await waitFor(() => expect(document.activeElement).toBe(nameInput));
    // …and it stays there: the focus return is not undone a tick later.
    await settle();
    expect(document.activeElement).toBe(nameInput);
    expect(save).not.toHaveBeenCalled();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('Escape in the named-approver suggestions closes ONLY the list; a second Escape then closes the unchanged drawer', async () => {
    const { errors } = mount(loc, vi.fn(), [...TEMPLATES, NAMED]);
    const edit = editButtonOf(loc, NAMED.name);
    await userEvent.click(edit);
    await settle();
    const dialog = screen.getByRole('dialog');
    const search = within(dialog).getAllByRole('combobox', { name: L.previewSearchAria })[0] as HTMLInputElement;
    await userEvent.clear(search);
    await userEvent.type(search, 'Bal');
    expect(within(dialog).getByRole('listbox')).toBeTruthy();
    expect(search.getAttribute('aria-expanded')).toBe('true');

    await userEvent.keyboard('{Escape}');
    expect(within(dialog).queryByRole('listbox'), 'Escape did not close the suggestions').toBeNull();
    expect(dialog.getAttribute('data-state'), 'Escape in the suggestions list closed the whole drawer').toBe('open');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(search);

    // The list is closed now, so Escape is the drawer's again — and nothing was changed, so it just closes.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(dialog.getAttribute('data-state')).toBe('closed');
    await closeFully();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('with a change, Escape in the suggestions closes only the list; the second Escape asks to discard', async () => {
    const { errors, save } = mount(loc, vi.fn(), [...TEMPLATES, NAMED]);
    await userEvent.click(editButtonOf(loc, NAMED.name));
    await settle();
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(L.templateName), ' v2');
    const search = within(dialog).getAllByRole('combobox', { name: L.previewSearchAria })[0] as HTMLInputElement;
    await userEvent.clear(search);
    await userEvent.type(search, 'Bal');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog'), 'Escape in the suggestions list asked to discard the template').toBeNull();
    expect(within(dialog).queryByRole('listbox')).toBeNull();
    expect(dialog.getAttribute('data-state')).toBe('open');

    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: L.discardTitle })).toBeTruthy();
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(save).not.toHaveBeenCalled();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('a save that THROWS (network drop, expired session) keeps the drawer and the edits, and says the generic sentence', async () => {
    const save: SaveMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { errors } = mount(loc, save);
    await userEvent.click(editButtonOf(loc, SENIOR.name));
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText(L.templateName) as HTMLInputElement;
    await userEvent.type(nameInput, ' renamed after an hour of work');
    await userEvent.click(within(dialog).getByRole('button', { name: commonSave(loc) }));

    const alert = await within(dialog).findByRole('alert');
    expect(screen.queryByTestId('error-boundary'), 'the thrown save reached the error boundary: drawer and edits gone').toBeNull();
    expect(alert.textContent).toBe(L.templateSaveFailed);
    expect(alert.textContent).not.toContain('Failed to fetch');
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(nameInput.value).toBe(`${SENIOR.name} renamed after an hour of work`);
    expect(refresh).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    // …and it can be tried again.
    await waitFor(() => {
      expect((within(dialog).getByRole('button', { name: commonSave(loc) }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('a refused save keeps the drawer open, the service reason at the top of the panel, and every edit in place', async () => {
    const refusal = 'A template with that name already exists';
    const save: SaveMock = vi.fn(async () => ({ ok: false as const, error: refusal }));
    const { errors } = mount(loc, save);
    await userEvent.click(editButtonOf(loc, SENIOR.name));
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText(L.templateName) as HTMLInputElement;
    const descInput = within(dialog).getByLabelText(L.templateDescription) as HTMLInputElement;
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, STANDARD.name);
    await userEvent.type(descInput, 'Heads first');
    await userEvent.click(within(dialog).getByLabelText(L.requireMultiStep));

    await userEvent.click(within(dialog).getByRole('button', { name: commonSave(loc) }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(refusal);
    expect(dialog.querySelector('[data-drawer-body]')!.firstElementChild).toBe(alert);
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(nameInput.value).toBe(STANDARD.name);
    expect(descInput.value).toBe('Heads first');
    expect((within(dialog).getByLabelText(L.requireMultiStep) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('combobox', { name: L.levelN.replace('{n}', '2') }) as HTMLSelectElement).value).toBe('hr_admin');
    expect(rowOf(SENIOR.name).hasAttribute('data-editing')).toBe(true);

    // What was posted is what the old form posted.
    expect(save).toHaveBeenCalledTimes(1);
    const fd = save.mock.calls[0][0];
    expect(fd.get('templateId')).toBe(SENIOR.id);
    expect(fd.get('name')).toBe(STANDARD.name);
    expect(fd.get('description')).toBe('Heads first');
    expect(JSON.parse(String(fd.get('levels')))).toEqual([
      { kind: 'department_head', employmentId: null, alternates: [] },
      { kind: 'hr_admin', employmentId: null, alternates: [] },
    ]);
    expect(refresh).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('a save closes the drawer, refreshes, confirms "<name> updated" in this language and puts focus on that row', async () => {
    const save: SaveMock = vi.fn(async () => ({ ok: true as const, id: SENIOR.id, name: 'Senior Staff v2', created: false }));
    const { errors } = mount(loc, save);
    const edit = editButtonOf(loc, SENIOR.name);
    await userEvent.click(edit);
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(L.templateName), ' v2');
    await userEvent.click(within(dialog).getByRole('button', { name: commonSave(loc) }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(fill(L.templateUpdatedToast, 'Senior Staff v2')));
    expect(String(toastSuccess.mock.calls[0][0])).not.toContain('{');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(dialog.getAttribute('data-state')).toBe('closed');
    expect(screen.queryByRole('alertdialog')).toBeNull(); // a save is not a discard
    expect(rowOf(SENIOR.name).hasAttribute('data-saved')).toBe(true);

    await closeFully();
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('a created template confirms "<name> created" and focus lands on the NEW row once the refresh brings it', async () => {
    const save: SaveMock = vi.fn(async () => ({ ok: true as const, id: NIGHT.id, name: NIGHT.name, created: true }));
    const { errors, rerender } = mount(loc, save);
    const add = screen.getByRole('button', { name: L.addTemplate });
    await userEvent.click(add);
    const dialog = screen.getByRole('dialog', { name: L.addTemplate });
    await userEvent.type(within(dialog).getByLabelText(L.templateName), NIGHT.name);
    await userEvent.click(within(dialog).getByRole('button', { name: commonSave(loc) }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(fill(L.templateCreatedToast, NIGHT.name)));
    expect(save.mock.calls[0][0].get('templateId')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    await closeFully();
    // Let the drawer's own focus return run, then the refresh lands with the new row.
    await settle();
    expect(document.activeElement).not.toBe(add);
    rerender([...TEMPLATES, NIGHT]);
    await waitFor(() => expect(document.activeElement).toBe(editButtonOf(loc, NIGHT.name)));
    expect(rowOf(NIGHT.name).hasAttribute('data-saved')).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

describe('r304 · closing, dirtiness and the one-drawer rule (en)', () => {
  const L = la('en');

  it('Escape and a click on the dimmed list close an unchanged drawer without asking or saving', async () => {
    const { save } = mount('en');
    const edit = editButtonOf('en', SENIOR.name);
    await userEvent.click(edit);
    await settle();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(drawerEl()!.getAttribute('data-state')).toBe('closed');
    await closeFully();
    await waitFor(() => expect(document.activeElement).toBe(edit));

    await userEvent.click(edit);
    await settle();
    await userEvent.click(overlayEl()!);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(drawerEl()!.getAttribute('data-state')).toBe('closed');
    await closeFully();
    expect(save).not.toHaveBeenCalled();
  });

  it('dirty means "differs from what it OPENED with": a change put back does not ask; a step, the multi-step box, Escape and the overlay do', async () => {
    mount('en');
    const edit = editButtonOf('en', SENIOR.name);

    // Typed and put back: not a change.
    await userEvent.click(edit);
    await settle();
    let dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(L.templateName), 'xy{Backspace}{Backspace}');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await closeFully();

    // A changed step, closed from the overlay: asks.
    await userEvent.click(edit);
    await settle();
    dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: L.levelN.replace('{n}', '1') }), 'hr_manager');
    await userEvent.click(overlayEl()!);
    expect(screen.getByRole('alertdialog', { name: L.discardTitle })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: L.discardKeep }));
    expect(dialog.getAttribute('data-state')).toBe('open');
    // …and put back, it no longer asks.
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: L.levelN.replace('{n}', '1') }), 'department_head');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await closeFully();

    // The multi-step box, closed with Escape: asks.
    await userEvent.click(edit);
    await settle();
    dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText(L.requireMultiStep));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: L.discardTitle })).toBeTruthy();
  });

  it('the saved row is highlighted briefly, then goes back to normal', async () => {
    const save: SaveMock = vi.fn(async () => ({ ok: true as const, id: SENIOR.id, name: SENIOR.name, created: false }));
    mount('en', save);
    await userEvent.click(editButtonOf('en', SENIOR.name));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: commonSave('en') }));
    await waitFor(() => expect(rowOf(SENIOR.name).hasAttribute('data-saved')).toBe(true));
    expect(rowOf(STANDARD.name).hasAttribute('data-saved')).toBe(false);
    await waitFor(() => expect(rowOf(SENIOR.name).hasAttribute('data-saved')).toBe(false), { timeout: 4000 });
  }, 10_000);

  it('a drawer already sliding out after a save does not ask "discard?" — not from Escape, not from its own Cancel', async () => {
    const save: SaveMock = vi.fn(async () => ({ ok: true as const, id: SENIOR.id, name: 'Senior Staff v2', created: false }));
    mount('en', save);
    await userEvent.click(editButtonOf('en', SENIOR.name));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(L.templateName), ' v2');
    await userEvent.click(within(dialog).getByRole('button', { name: commonSave('en') }));
    await waitFor(() => expect(dialog.getAttribute('data-state')).toBe('closed'));
    expect(dialog.isConnected, 'the drawer finished closing before Escape — this case would prove nothing').toBe(true);
    // Escape: Radix does not report a close for a dialog that is already closed.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The footer Cancel is still on screen while the panel slides, and it calls the close path directly.
    await userEvent.click(within(dialog).getByRole('button', { name: L.cancel }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await closeFully();
  });

  it('Enter during the slide-out posts nothing — after Escape, after X, after Cancel, and after a successful save', async () => {
    /** What Enter in a text field does: implicit submission of the field's form. jsdom's user-event only
     *  submits a form holding its own submit button, and this one's Save sits in the drawer footer (form=),
     *  so the submission is requested directly — the same submit event the browser dispatches. */
    const pressEnterIn = (dialog: HTMLElement) =>
      act(() => {
        dialog.querySelector('form')!.requestSubmit();
      });

    for (const how of ['escape', 'x', 'cancel'] as const) {
      const save: SaveMock = vi.fn(async () => ({ ok: true as const, id: SENIOR.id, name: SENIOR.name, created: false }));
      const { view } = mount('en', save);
      await userEvent.click(editButtonOf('en', SENIOR.name));
      await settle();
      const dialog = screen.getByRole('dialog');
      await userEvent.click(within(dialog).getByLabelText(L.templateName));
      if (how === 'escape') await userEvent.keyboard('{Escape}');
      if (how === 'x') await userEvent.click(within(dialog).getByRole('button', { name: closeLabel('en') }));
      if (how === 'cancel') await userEvent.click(within(dialog).getByRole('button', { name: L.cancel }));
      expect(dialog.getAttribute('data-state'), how).toBe('closed');
      expect(dialog.isConnected, `${how}: the drawer finished closing before Enter — this case would prove nothing`).toBe(true);
      await pressEnterIn(dialog);
      await settle();
      expect(save, `${how}: a closed drawer posted a save of the values it opened with`).not.toHaveBeenCalled();
      expect((within(dialog).getByRole('button', { name: commonSave('en'), hidden: true }) as HTMLButtonElement).disabled).toBe(true);
      view.unmount();
    }

    const save: SaveMock = vi.fn(async () => ({ ok: true as const, id: SENIOR.id, name: 'Senior Staff v2', created: false }));
    mount('en', save);
    await userEvent.click(editButtonOf('en', SENIOR.name));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(L.templateName), ' v2');
    await userEvent.click(within(dialog).getByRole('button', { name: commonSave('en') }));
    await waitFor(() => expect(dialog.getAttribute('data-state')).toBe('closed'));
    expect(dialog.isConnected).toBe(true);
    await pressEnterIn(dialog);
    await settle();
    expect(save, 'the sliding-out drawer posted a second save').toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('while a save is in flight the form is disabled, Save and Cancel are disabled, and Escape / X do nothing; a refusal hands it back intact', async () => {
    let resolve!: (r: SaveTemplateResult) => void;
    const save: SaveMock = vi.fn(() => new Promise<SaveTemplateResult>((r) => (resolve = r)));
    mount('en', save);
    await userEvent.click(editButtonOf('en', SENIOR.name));
    await settle();
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText(L.templateName) as HTMLInputElement;
    const descInput = within(dialog).getByLabelText(L.templateDescription) as HTMLInputElement;
    await userEvent.type(nameInput, ' A');
    await userEvent.click(within(dialog).getByRole('button', { name: commonSave('en') }));
    expect(save).toHaveBeenCalledTimes(1);

    // Pending: nothing in the form can be changed, and neither footer button can be pressed.
    const fieldset = dialog.querySelector('form > fieldset') as HTMLFieldSetElement;
    expect(fieldset, 'no fieldset wraps the form body').not.toBeNull();
    expect(fieldset.disabled).toBe(true);
    expect(nameInput.matches(':disabled')).toBe(true);
    expect(descInput.matches(':disabled')).toBe(true);
    expect((within(dialog).getByRole('combobox', { name: L.levelN.replace('{n}', '1') }) as HTMLSelectElement).matches(':disabled')).toBe(true);
    expect((within(dialog).getByRole('button', { name: commonSave('en') }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: L.cancel }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(descInput, 'typed during the save');
    expect(descInput.value, 'typing during the save reached the field').toBe('');

    // Escape and X wait for the answer.
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(dialog).getByRole('button', { name: closeLabel('en') }));
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => resolve({ ok: false, error: 'A template with that name already exists' }));
    await within(dialog).findByRole('alert');
    expect(fieldset.disabled).toBe(false);
    expect(nameInput.matches(':disabled')).toBe(false);
    expect(nameInput.value).toBe(`${SENIOR.name} A`);
    expect((within(dialog).getByRole('button', { name: L.cancel }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.type(descInput, 'now it types');
    expect(descInput.value).toBe('now it types');
    expect(dialog.getAttribute('data-state')).toBe('open');
  });

  it('re-opening another template while the first slides out: one drawer, focus inside it, and closing returns focus to the SECOND Edit', async () => {
    mount('en');
    const editStandard = editButtonOf('en', STANDARD.name);
    const editSenior = editButtonOf('en', SENIOR.name);
    await userEvent.click(editStandard);
    await settle();
    await userEvent.keyboard('{Escape}');
    expect(drawerEl()!.getAttribute('data-state')).toBe('closed');

    // Mid-exit, another row's Edit is activated.
    act(() => editSenior.focus());
    fireEvent.click(editSenior);
    await settle();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const dialog = screen.getByRole('dialog', { name: fill(L.drawerEditTitle, SENIOR.name) });
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect((within(dialog).getByLabelText(L.templateName) as HTMLInputElement).value).toBe(SENIOR.name);
    await waitFor(() => expect(dialog.contains(document.activeElement), 'focus left outside the re-opened drawer').toBe(true));
    // The first drawer's exit timer must not unmount the re-opened one, nor pull focus back out.
    await settle(600);
    expect(drawerEl()!.getAttribute('data-state')).toBe('open');
    expect(drawerEl()!.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard('{Escape}');
    await closeFully();
    await waitFor(() => expect(document.activeElement, "focus went back to the FIRST template's Edit").toBe(editSenior));
  });

  it('only one drawer: while it is open the list behind it is hidden from assistive tech and nothing else opens', async () => {
    mount('en');
    await userEvent.click(editButtonOf('en', SENIOR.name));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(rowOf(STANDARD.name).closest('[aria-hidden="true"]')).not.toBeNull();
    expect(overlayEl()!.getAttribute('data-state')).toBe('open');
  });

  it('keyboard focus stays inside the open drawer, forwards and backwards', async () => {
    mount('en');
    await userEvent.click(editButtonOf('en', SENIOR.name));
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 25; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement), `tab ${i + 1} left the drawer`).toBe(true);
    }
    for (let i = 0; i < 25; i++) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement), `shift+tab ${i + 1} left the drawer`).toBe(true);
    }
  });
});

describe('r304 · the drawer slides out rather than vanishing', () => {
  it('closing keeps the panel mounted with data-state="closed" until ITS slide-out ends', async () => {
    mount('en');
    await userEvent.click(editButtonOf('en', SENIOR.name));
    const dialog = screen.getByRole('dialog');
    await userEvent.keyboard('{Escape}');

    // Still in the document, marked closed: this is the state the slide-out keyframes key on.
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute('data-state')).toBe('closed');
    expect(overlayEl()!.getAttribute('data-state')).toBe('closed');
    // Its form stays inside while it slides — the panel does not empty first.
    expect(within(dialog).getByLabelText(la('en').templateName)).toBeTruthy();

    // Some OTHER animation ending is not the exit.
    endAnimation('ui-drawer-panel-in');
    expect(dialog.isConnected).toBe(true);
    // The slide-out ending is.
    endAnimation();
    expect(drawerEl()).toBeNull();
    expect(overlayEl()).toBeNull();
  });

  it('with no animationend at all (a stylesheet that never loaded) a timer still removes it — never a stuck invisible modal', async () => {
    mount('en');
    await userEvent.click(editButtonOf('en', SENIOR.name));
    await userEvent.keyboard('{Escape}');
    expect(drawerEl()).not.toBeNull();
    await waitFor(() => expect(drawerEl()).toBeNull(), { timeout: 1500 });
  });

  it('prefers-reduced-motion: there is no slide to wait for, so it is gone at once', async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion: reduce'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    try {
      mount('en');
      await userEvent.click(editButtonOf('en', SENIOR.name));
      expect(drawerEl()).not.toBeNull();
      await userEvent.keyboard('{Escape}');
      expect(drawerEl()).toBeNull();
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: original });
    }
  });

  it('the CSS it waits on is there: slide in/out keyframes on data-state, reduced motion turns them off, and the width presets', async () => {
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    const out = css.slice(css.indexOf(`@keyframes ${DRAWER_EXIT_ANIMATION} {`));
    expect(out.length, `app/globals.css has no @keyframes ${DRAWER_EXIT_ANIMATION}`).toBeLessThan(css.length);
    expect(out.slice(0, 120)).toMatch(/from \{ transform: translateX\(0\); \}\s*to \{ transform: translateX\(100%\); \}/);
    expect(css).toMatch(new RegExp(`\\.ui-drawer-panel\\[data-state='closed'\\] \\{\\s*animation: ${DRAWER_EXIT_ANIMATION} 240ms ease both;`));
    expect(css).toMatch(/\.ui-drawer-panel\[data-state='open'\] \{\s*animation: ui-drawer-panel-in 240ms ease both;/);
    expect(css).toMatch(/\.ui-drawer-overlay\[data-state='closed'\] \{\s*animation: ui-drawer-overlay-out 240ms ease both;/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.ui-drawer-panel\[data-state\],\s*\.ui-drawer-overlay\[data-state\] \{\s*animation: none;/,
    );

    mount('en');
    await userEvent.click(editButtonOf('en', SENIOR.name));
    const cls = screen.getByRole('dialog').className.split(/\s+/);
    // Full screen on a phone AND a tablet (below lg, 1024px — the approved plan: "full screen on a phone or
    // tablet"); clamp(36rem, 40vw, 48rem) from lg up; pinned to the right edge.
    expect(cls).toEqual(expect.arrayContaining(['w-full', 'max-w-full', 'lg:w-[clamp(36rem,40vw,48rem)]', 'fixed', 'inset-y-0', 'right-0']));
    expect(cls.filter((c) => /^(sm|md):(w|max-w)-/.test(c)), 'the panel narrows below lg, i.e. on a tablet').toEqual([]);
  });
});

describe('r304 · the drawer says "Save", not "Save chain"', () => {
  it('the page hands the template manager common.save; the escalation editor keeps leaveApproval.save', () => {
    const page = readFileSync(join(__dirname, '../app/admin/leave-config/approval-chains/page.tsx'), 'utf8');
    expect(page).toContain("const tc = await getTranslations('common');");
    const templateLabels = page.slice(page.indexOf('const templateLabels: TemplateManagerLabels = {'));
    const templateBlock = templateLabels.slice(0, templateLabels.indexOf('\n  };'));
    expect(templateBlock).toContain("save: tc('save'),");
    expect(templateBlock).not.toContain("save: t('save'),");
    const escalation = page.slice(page.indexOf('const escalationLabels: EscalationLabels = {'));
    expect(escalation.slice(0, escalation.indexOf('\n  };'))).toContain("save: t('save'),");
    for (const loc of LOCALES) {
      expect(commonSave(loc), loc).toBeTruthy();
      expect(commonSave(loc), `${loc}: common.save is the same words as "Save chain"`).not.toBe(la(loc).save);
    }
  });
});

describe('r304 · the row actions are pinned as main shipped them', () => {
  it('Duplicate, Set as default / Remove default, Deactivate / Activate and Delete render byte-for-byte as on main', () => {
    // test/fixtures/r304-row-actions-main.json was captured from main@36b0602f, BEFORE the drawer, by
    // rendering this same component with these same three templates (default + active, active, inactive).
    const pinned = JSON.parse(
      readFileSync(join(__dirname, 'fixtures/r304-row-actions-main.json'), 'utf8'),
    ) as Record<string, string>;
    mount('en');
    for (const t of TEMPLATES) {
      const now = rowActionsMarkup(rowOf(t.name));
      // Non-vacuity of the strip: Monolith classes really are on these buttons, and are what is removed.
      expect(now).toContain('monolith:');
      expect(withoutMonolithClasses(now), `${t.name}: the row actions changed`).toBe(pinned[t.id]);
    }
    expect(LOCALES).toHaveLength(6);
  });
});
