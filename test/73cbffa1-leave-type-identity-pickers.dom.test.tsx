/**
 * 73cbffa1 · LEAVE TYPE INFORMATION, ALWAYS SHOWN, WITH COMPACT ICON AND COLOUR PICKERS — RENDERED.
 *
 * The approved plan retires the Rename toggle on tab 1 ("The leave type") and folds the separate icon/colour
 * form into the identity form:
 *   · Code, Name, Reason, Leave Unit, Paid and Description show as soon as the type is opened;
 *   · Code · Icon · Colour theme share a row; each picker shows only the current choice and opens a small
 *     panel (same 16 icons with search, same 7 colours, plus Default);
 *   · ONE Save and ONE Discard for the section, disabled until something changes, with an "Unsaved changes"
 *     marker; Save still goes through the "Save changes?" confirmation;
 *   · the statutory code stays locked and is never posted; Archive / Delete sit in the section header,
 *     OUTSIDE the identity form.
 *
 * Mounted under the SHIPPING catalogues with next-intl's onError collected, so a missing message fails here.
 * Fictional data only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LeaveTypeTabs, type LeaveTypeTabsData } from '../app/admin/leave-config/types/leave-type-tabs';
import { LEAVE_COLOR_TOKENS, LEAVE_ICON_KEYS } from '../lib/leave-visual';

const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
type LeaveMessages = Record<string, string> & { visual: Record<string, string> & { color: Record<string, string> } };
const L = (loc: Locale) => (CATALOGUES[loc] as unknown as { admin: { leave: LeaveMessages } }).admin.leave;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const noop = () => {};

function typeData(over: Partial<LeaveTypeTabsData> = {}): LeaveTypeTabsData {
  return {
    id: 'lt-study',
    name: 'Study Leave',
    code: 'STUDY_LEAVE',
    description: 'For approved professional exams (fictional).',
    paid: true,
    archived: false,
    inUse: true,
    cascadeApprovalRules: [],
    cascadeBalanceSourceOf: [],
    eligibility: null,
    durations: null,
    requiresDocument: false,
    mandatoryAfterDays: null,
    allowedMimeTypes: null,
    maxDocBytes: 10 * 1024 * 1024,
    employeeRemarkRequired: false,
    hrRemarkRequired: false,
    backdatingLimitDays: null,
    maxDaysPerLeaveYear: null,
    maxDaysPeriod: null,
    maxConsecutiveDays: null,
    maxConsecutiveUnit: null,
    minAdvanceDays: null,
    minAdvanceDayType: null,
    customMessages: null,
    essViewConfig: null,
    formulaExplanations: null,
    dayTypeInclusion: null,
    color: 'blue',
    icon: 'graduationcap',
    leaveUnit: 'day',
    yearCycleOverride: null,
    probationEligibility: null,
    visibleToEmployee: null,
    employeeCanApply: null,
    essPlacement: null,
    role: null,
    counting: 'working_days',
    perDateApproval: false,
    duplicateApplicationPolicy: 'allow',
    overrideRules: null,
    allowNegativeBalance: false,
    maxNegativeBalance: null,
    balanceSourceTypeId: null,
    allowUnpaidLeave: false,
    employeeCancelApproved: false,
    cancelNoticeDays: 0,
    cancelAutoApprove: false,
    cancelNotify: false,
    sendToPayroll: false,
    rules: {},
    ...over,
  };
}

function mount(loc: Locale, data: LeaveTypeTabsData, updateTypeAction: (fd: FormData) => void = noop) {
  const errors: string[] = [];
  const view = render(
    <NextIntlClientProvider
      locale={loc}
      messages={CATALOGUES[loc]}
      onError={(e) => {
        errors.push(String((e as Error).message ?? e));
      }}
    >
      <LeaveTypeTabs
        type={data}
        sweep={{ leaveTypeName: data.name, annualSwitch: 'on', otherAnnualLeaveTypeNames: [], earnedMethods: [] }}
        orgAssignmentOptions={{}}
        balanceSourceOptions={[]}
        formulaTemplate={null}
        openTab="identity"
        updateTypeAction={updateTypeAction}
        archiveTypeAction={noop}
        deleteTypeAction={noop}
        setTypeRulesAction={noop}
      />
    </NextIntlClientProvider>,
  );
  return { view, errors };
}

/** The identity form: the one carrying the `identity=1` marker. */
const identityForm = (container: HTMLElement) =>
  container.querySelector('input[name="identity"][value="1"]')!.closest('form') as HTMLFormElement;
const hidden = (form: HTMLFormElement, name: string) =>
  (form.querySelector(`input[type="hidden"][name="${name}"]`) as HTMLInputElement | null)?.value;
const saveBtn = (loc: Locale, form: HTMLFormElement) =>
  within(form).getByRole('button', { name: L(loc).save }) as HTMLButtonElement;
const discardBtn = (loc: Locale, form: HTMLFormElement) =>
  within(form).getByRole('button', { name: L(loc).discardChanges }) as HTMLButtonElement;
const iconTrigger = (form: HTMLFormElement) => form.querySelector('button[data-picker="icon"]') as HTMLButtonElement;
const colorTrigger = (form: HTMLFormElement) => form.querySelector('button[data-picker="color"]') as HTMLButtonElement;

describe('73cbffa1 · the fields are shown straight away, in every locale', () => {
  it.each(LOCALES)('%s — Code, Name, Reason, Leave Unit, Paid, Description and both pickers; no Rename', (loc) => {
    const { view, errors } = mount(loc, typeData());
    const form = identityForm(view.container);
    const m = L(loc);
    expect(within(form).getByRole('textbox', { name: m.codeLabel })).toHaveProperty('value', 'STUDY_LEAVE');
    expect(within(form).getByRole('textbox', { name: m.nameLabel })).toHaveProperty('value', 'Study Leave');
    expect(within(form).getByRole('textbox', { name: m.reasonLabel })).toHaveProperty('value', '');
    expect(within(form).getByRole('combobox', { name: m.leaveUnitLabel })).toHaveProperty('value', 'day');
    expect(within(form).getByRole('checkbox', { name: m.paidLabel })).toHaveProperty('checked', true);
    expect(within(form).getByRole('textbox', { name: m.descriptionLabel })).toHaveProperty(
      'value',
      'For approved professional exams (fictional).',
    );
    // Both triggers carry their caption as accessible name; the colour one shows the chosen colour's name.
    expect(iconTrigger(form).getAttribute('aria-haspopup')).toBe('dialog');
    expect(iconTrigger(form).getAttribute('aria-expanded')).toBe('false');
    expect(colorTrigger(form).textContent).toContain(m.visual.color.blue);
    // The whole icon library is NOT on the page until asked for.
    expect(within(form).queryByRole('button', { name: 'palmtree' })).toBeNull();
    // The Rename toggle is gone.
    expect(screen.queryByRole('button', { name: /^Rename$/ })).toBeNull();
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

describe('73cbffa1 · one Save / Discard, dirty-gated', () => {
  it('Save and Discard are disabled until a field changes; Discard restores the stored values', async () => {
    const user = userEvent.setup();
    const { view } = mount('en', typeData());
    const form = identityForm(view.container);
    const m = L('en');
    expect(saveBtn('en', form).disabled).toBe(true);
    expect(discardBtn('en', form).disabled).toBe(true);
    expect(within(form).queryByText(m.unsavedChanges)).toBeNull();

    const nameInput = within(form).getByRole('textbox', { name: m.nameLabel }) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Exam Leave');
    expect(saveBtn('en', form).disabled).toBe(false);
    expect(discardBtn('en', form).disabled).toBe(false);
    expect(within(form).getByText(m.unsavedChanges)).toBeTruthy();

    // Typing it back to the stored value is "not dirty" again — the snapshot is what is stored.
    await user.clear(nameInput);
    await user.type(nameInput, 'Study Leave');
    expect(saveBtn('en', form).disabled).toBe(true);

    await user.click(within(form).getByRole('checkbox', { name: m.paidLabel }));
    await user.click(colorTrigger(form));
    await user.click(screen.getByRole('button', { name: m.visual.color.purple }));
    expect(hidden(form, 'color')).toBe('purple');
    expect(saveBtn('en', form).disabled).toBe(false);

    await user.click(discardBtn('en', form));
    expect((within(form).getByRole('checkbox', { name: m.paidLabel }) as HTMLInputElement).checked).toBe(true);
    expect(hidden(form, 'color')).toBe('blue');
    expect(hidden(form, 'icon')).toBe('graduationcap');
    expect(colorTrigger(form).textContent).toContain(m.visual.color.blue);
    expect(saveBtn('en', form).disabled).toBe(true);
    expect(within(form).queryByText(m.unsavedChanges)).toBeNull();
  });

  it('Save goes through the "Save changes?" confirmation and posts identity + leaveUnit + visual in ONE submit', async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    const { view } = mount('en', typeData(), action);
    const form = identityForm(view.container);
    const m = L('en');
    await user.type(within(form).getByRole('textbox', { name: m.reasonLabel }), 'Exam season (fictional)');
    await user.click(iconTrigger(form));
    await user.click(screen.getByRole('button', { name: 'plane' }));
    await user.click(saveBtn('en', form));
    expect(action).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(m.saveConfirmTitle)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: m.saveConfirmConfirm }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get('id')).toBe('lt-study');
    expect(fd.get('identity')).toBe('1');
    expect(fd.get('leaveUnit')).toBe('1');
    expect(fd.get('visual')).toBe('1');
    expect(fd.get('name')).toBe('Study Leave');
    expect(fd.get('code')).toBe('STUDY_LEAVE');
    expect(fd.get('reason')).toBe('Exam season (fictional)');
    expect(fd.get('leaveUnitValue')).toBe('day');
    expect(fd.get('paid')).toBe('on');
    expect(fd.get('icon')).toBe('plane');
    expect(fd.get('color')).toBe('blue');
  });
});

describe('73cbffa1 · the compact icon picker', () => {
  it('opens a panel with the search, all 16 icons and Default; picking one closes it and returns focus', async () => {
    const user = userEvent.setup();
    const { view } = mount('en', typeData());
    const form = identityForm(view.container);
    const m = L('en');
    const trigger = iconTrigger(form);
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('dialog');
    for (const key of LEAVE_ICON_KEYS) expect(within(panel).getByRole('button', { name: key })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'graduationcap' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(panel).getByRole('searchbox', { name: m.visual.searchPlaceholder })).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: 'thermometer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hidden(form, 'icon')).toBe('thermometer');
    expect(document.activeElement).toBe(trigger);

    // Default clears the choice ('' ⇒ null ⇒ the standard look).
    await user.click(trigger);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: m.visual.default }));
    expect(hidden(form, 'icon')).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('search filters by keyword, shows the empty state, and Enter in the search box does not submit', async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    const { view } = mount('en', typeData(), action);
    const form = identityForm(view.container);
    const m = L('en');
    await user.click(iconTrigger(form));
    const panel = screen.getByRole('dialog');
    const search = within(panel).getByRole('searchbox');
    await user.type(search, 'sick{Enter}');
    const shown = within(panel)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter(Boolean);
    expect(shown.sort()).toEqual(['stethoscope', 'thermometer']);
    await user.clear(search);
    await user.type(search, 'zzzz');
    expect(within(panel).getByText(m.visual.noIcons)).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
  });

  it('closes on Escape (focus back on the trigger) and on an outside click, keeping the value', async () => {
    const user = userEvent.setup();
    const { view } = mount('en', typeData());
    const form = identityForm(view.container);
    const trigger = iconTrigger(form);
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(hidden(form, 'icon')).toBe('graduationcap');
  });
});

describe('73cbffa1 · the compact colour picker', () => {
  it('lists the same 7 colours plus Default, marks the current one, and shows only the chosen colour after', async () => {
    const user = userEvent.setup();
    const { view } = mount('en', typeData({ color: null }));
    const form = identityForm(view.container);
    const m = L('en');
    expect(hidden(form, 'color')).toBe('');
    expect(colorTrigger(form).textContent).toContain(m.visual.default);
    await user.click(colorTrigger(form));
    const panel = screen.getByRole('dialog');
    for (const token of LEAVE_COLOR_TOKENS) {
      expect(within(panel).getByRole('button', { name: m.visual.color[token] })).toBeTruthy();
    }
    expect(within(panel).getAllByRole('button')).toHaveLength(LEAVE_COLOR_TOKENS.length + 1);
    expect(within(panel).getByRole('button', { name: m.visual.default }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(panel).getByRole('button', { name: m.visual.color.teal }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hidden(form, 'color')).toBe('teal');
    expect(colorTrigger(form).textContent).toContain(m.visual.color.teal);
  });
});

describe('73cbffa1 · guards kept', () => {
  it('a statutory type shows its code read-only and posts NO code field', () => {
    const { view } = mount('en', typeData({ id: 'lt-annual', name: 'Annual Leave', code: 'ANNUAL', role: 'annual' }));
    const form = identityForm(view.container);
    const code = within(form).getByRole('textbox', { name: L('en').codeLabel }) as HTMLInputElement;
    expect(code.readOnly).toBe(true);
    expect(code.getAttribute('name')).toBeNull();
    expect(new FormData(form).has('code')).toBe(false);
  });

  it('Archive / Delete are sibling forms in the section header, never inside the identity form', () => {
    const inUse = mount('en', typeData());
    const form = identityForm(inUse.view.container);
    const archive = screen.getByRole('button', { name: L('en').archive });
    expect(form.contains(archive)).toBe(false);
    expect(archive.closest('[data-ui-card-header]')).not.toBeNull();
    cleanup();
    const unused = mount('en', typeData({ inUse: false }));
    const form2 = identityForm(unused.view.container);
    const del = screen.getByRole('button', { name: L('en').delete });
    expect(form2.contains(del)).toBe(false);
    expect(del.closest('[data-ui-card-header]')).not.toBeNull();
  });
});
