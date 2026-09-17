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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

type SaveMock = ReturnType<typeof vi.fn<(fd: FormData) => Promise<SaveTemplateResult>>>;

function managerNode(loc: Locale, save: SaveMock, templates: TemplateRow[] = TEMPLATES) {
  return (
    <ApprovalTemplateManager
      templates={templates}
      labels={labelsFor(loc)}
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
      {node}
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
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
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
    const save = within(footer).getByRole('button', { name: L.save });
    expect(save.getAttribute('type')).toBe('submit');
    expect(save.getAttribute('form')).toBe(form.id);
    expect(within(footer).getByRole('button', { name: L.cancel })).toBeTruthy();
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
    // "Keep editing" hands the keyboard back to where the close was asked from.
    await waitFor(() => expect(document.activeElement).toBe(cancel));

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

    await userEvent.click(within(dialog).getByRole('button', { name: L.save }));

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
    await userEvent.click(within(dialog).getByRole('button', { name: L.save }));

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
    await userEvent.click(within(dialog).getByRole('button', { name: L.save }));

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
    // Full screen below md; clamp(36rem, 40vw, 48rem) from md up; pinned to the right edge.
    expect(cls).toEqual(expect.arrayContaining(['w-full', 'md:w-[clamp(36rem,40vw,48rem)]', 'fixed', 'inset-y-0', 'right-0']));
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
      expect(rowActionsMarkup(rowOf(t.name)), `${t.name}: the row actions changed`).toBe(pinned[t.id]);
    }
    expect(LOCALES).toHaveLength(6);
  });
});
