/**
 * def44f29 — the Add / Edit holiday dialog, PROVED BY RENDERING.
 *
 * The report is about what the screen does: "Add holiday" showed a form at the bottom of the page, and
 * National / State could not be changed. A source grep can say the anchor is gone; it cannot say a
 * dialog took its place with every field in it, that Edit opens the same dialog PRE-FILLED (state
 * included), or that a refused save leaves the dialog open with the typing intact — which is the thing
 * the reporter will check first, because it is the thing the movement-type dialog got wrong once
 * (React 19 resets an uncontrolled form when the action settles, success or failure).
 *
 * The labels are resolved from the REAL en.json the way the server page resolves them, so a key the page
 * asks for and the catalogue does not hold fails here rather than painting MISSING_MESSAGE at an admin.
 * The state list is the pack's own (localization/my/holidays.ts), never a copy typed into this file.
 *
 * The server action is stubbed: it is a 'use server' module that reaches Postgres on import, and its own
 * behaviour (insert vs update, the returned path, the refusal) is proved against a real database in
 * test/holiday-add-shows-new-row.test.ts and test/holiday-editable-tentative.test.ts.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import messages from '../messages/en.json';
import { MY_STATES } from '../localization/my/holidays';

// vi.mock factories are hoisted above every other statement, so the spies they close over are hoisted too.
const { push, refresh, save } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), save: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('../app/admin/actions', () => ({ saveHolidayAction: save, deleteHolidayAction: vi.fn() }));

import { HolidayDialog, type HolidayDialogLabels } from '../app/admin/holidays/holiday-dialog';

const en = messages.admin.holidays;
/** Built the way app/admin/holidays/page.tsx builds them — same keys, same catalogue. */
const ADD_LABELS: HolidayDialogLabels = {
  title: en.addTitle,
  hint: en.addHint,
  name: en.nameLabel,
  namePlaceholder: en.namePlaceholder,
  date: en.dateLabel,
  nationalState: en.nationalStateLabel,
  nationalStateHint: en.nationalStateHint,
  national: en.national,
  scopeFixedHint: en.scopeFixedHint,
  holidayType: en.holidayTypeLabel,
  country: en.countryLabel,
  active: en.activeLabel,
  tentative: en.tentativeCreateLabel,
  submit: en.save,
  saving: en.saving,
  cancel: en.cancel,
  close: en.close,
};
const EDIT_LABELS: HolidayDialogLabels = { ...ADD_LABELS, title: en.editTitle, hint: en.editHint };
const TYPES = [
  { value: 'public', label: en.holidayType.public },
  { value: 'company', label: en.holidayType.company },
  { value: 'optional', label: en.holidayType.optional },
];
const FILTER = { country: 'MY', year: '2026', page: '1', size: '' };
const shared = {
  countryOptions: ['MY'],
  statesByCountry: { MY: [...MY_STATES] },
  typeOptions: TYPES,
  filter: FILTER,
};

const mountAdd = () =>
  render(
    <HolidayDialog
      triggerLabel={en.addHoliday}
      triggerClassName=""
      id={null}
      initial={{ name: '', holidayDate: '2026-09-11', state: '', holidayType: 'public', country: 'MY', active: true, tentative: false }}
      fixedScope={null}
      labels={ADD_LABELS}
      {...shared}
    />,
  );

const mountEdit = (over: Partial<Parameters<typeof HolidayDialog>[0]> = {}) =>
  render(
    <HolidayDialog
      triggerLabel={en.edit}
      triggerClassName=""
      id="h-1"
      initial={{ name: 'Good Friday', holidayDate: '2026-04-03', state: 'Sabah', holidayType: 'public', country: 'MY', active: true, tentative: false }}
      fixedScope={null}
      labels={EDIT_LABELS}
      {...shared}
      {...over}
    />,
  );

const field = <T extends HTMLElement>(dialog: HTMLElement, selector: string): T => {
  const el = dialog.querySelector(selector) as T | null;
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
};

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  save.mockReset();
});

describe('def44f29 — Add holiday opens a dialog over the list', () => {
  it('holds every field, National first among the 17 National / State options, and the filter as hidden fields', async () => {
    const user = userEvent.setup();
    mountAdd();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: en.addHoliday }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(en.addTitle)).toBeInTheDocument();
    expect(within(dialog).getByText(en.addHint)).toBeInTheDocument();

    expect(field<HTMLInputElement>(dialog, 'input[name="name"]').value).toBe('');
    expect(field<HTMLInputElement>(dialog, 'input[name="holidayDate"]').value).toBe('2026-09-11');
    // National + the pack's 16 states, National first and selected.
    const state = field<HTMLSelectElement>(dialog, 'select[name="state"]');
    expect(state.options).toHaveLength(1 + MY_STATES.length);
    expect(state.options[0].textContent).toBe(en.national);
    expect(state.value).toBe('');
    expect([...state.options].map((o) => o.value)).toContain('Sabah');
    expect(within(dialog).getByText(en.nationalStateHint)).toBeInTheDocument();
    expect(field<HTMLSelectElement>(dialog, 'select[name="holidayType"]').options).toHaveLength(3);
    expect(field<HTMLSelectElement>(dialog, 'select[name="country"]').value).toBe('MY');
    expect(field<HTMLInputElement>(dialog, 'input[name="active"]').checked).toBe(true);
    expect(field<HTMLInputElement>(dialog, 'input[name="tentative"]').checked).toBe(false);
    expect(within(dialog).getByRole('button', { name: en.save })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: en.cancel })).toBeInTheDocument();

    // No row identity when adding — that is what makes the action an insert.
    expect(dialog.querySelector('input[name="id"]')).toBeNull();
    // The filter rides in the form so the action can rebuild the address of the view (holidaysPath).
    expect(field<HTMLInputElement>(dialog, 'input[name="filterCountry"]').value).toBe('MY');
    expect(field<HTMLInputElement>(dialog, 'input[name="filterYear"]').value).toBe('2026');
    expect(field<HTMLInputElement>(dialog, 'input[name="filterPage"]').value).toBe('1');
    // …and no size, because the reader chose none.
    expect(dialog.querySelector('input[name="filterSize"]')).toBeNull();
  });

  it('Cancel closes it and nothing is saved', async () => {
    const user = userEvent.setup();
    mountAdd();
    await user.click(screen.getByRole('button', { name: en.addHoliday }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(save).not.toHaveBeenCalled();
  });

  it('switching country while adding drops a state the new country does not have', async () => {
    const user = userEvent.setup();
    render(
      <HolidayDialog
        triggerLabel={en.addHoliday}
        triggerClassName=""
        id={null}
        initial={{ name: '', holidayDate: '2026-09-11', state: '', holidayType: 'public', country: 'MY', active: true, tentative: false }}
        fixedScope={null}
        labels={ADD_LABELS}
        {...shared}
        countryOptions={['MY', 'SG']}
        statesByCountry={{ MY: [...MY_STATES], SG: [] }}
      />,
    );
    await user.click(screen.getByRole('button', { name: en.addHoliday }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(field(dialog, 'select[name="state"]'), 'Sabah');
    expect(field<HTMLSelectElement>(dialog, 'select[name="state"]').value).toBe('Sabah');
    await user.selectOptions(field(dialog, 'select[name="country"]'), 'SG');
    const state = field<HTMLSelectElement>(dialog, 'select[name="state"]');
    expect(state.value).toBe('');
    expect(state.options).toHaveLength(1);
  });
});

describe('def44f29 — Edit opens the same dialog pre-filled', () => {
  it('carries the row, National / State included, with Country fixed', async () => {
    const user = userEvent.setup();
    mountEdit();
    await user.click(screen.getByRole('button', { name: en.edit }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(en.editTitle)).toBeInTheDocument();
    expect(field<HTMLInputElement>(dialog, 'input[name="id"]').value).toBe('h-1');
    expect(field<HTMLInputElement>(dialog, 'input[name="name"]').value).toBe('Good Friday');
    expect(field<HTMLInputElement>(dialog, 'input[name="holidayDate"]').value).toBe('2026-04-03');
    expect(field<HTMLSelectElement>(dialog, 'select[name="state"]').value).toBe('Sabah');
    expect(field<HTMLSelectElement>(dialog, 'select[name="holidayType"]').value).toBe('public');
    // updateHoliday takes no country: shown read-only, not offered. (Not getByDisplayValue: the hidden
    // filterCountry input carries the same value.)
    expect(dialog.querySelector('select[name="country"]')).toBeNull();
    const country = field<HTMLInputElement>(dialog, 'input[readonly][disabled]');
    expect(country.value).toBe('MY');
  });

  it('a business-group row shows its scope fixed and offers no National / State picker at all', async () => {
    const user = userEvent.setup();
    mountEdit({ fixedScope: 'Business group: Acme Sdn Bhd', initial: { name: 'Company Day', holidayDate: '2026-04-03', state: '', holidayType: 'company', country: 'MY', active: true, tentative: false } });
    await user.click(screen.getByRole('button', { name: en.edit }));

    const dialog = screen.getByRole('dialog');
    // No picker means no `state` field is posted — the action reads its presence, and leaves the row alone.
    expect(dialog.querySelector('select[name="state"]')).toBeNull();
    expect(dialog.querySelector('[name="state"]')).toBeNull();
    const fixed = within(dialog).getByDisplayValue('Business group: Acme Sdn Bhd') as HTMLInputElement;
    expect(fixed.disabled).toBe(true);
    expect(within(dialog).getByText(en.scopeFixedHint)).toBeInTheDocument();
  });
});

describe('def44f29 — the save answers the dialog', () => {
  it('a refused save keeps the dialog open with the typing intact and shows the reason', async () => {
    const user = userEvent.setup();
    const reason = 'A MY Sabah holiday on 2026-04-03 already exists.';
    save.mockResolvedValue({ ok: false, error: reason });
    mountAdd();
    await user.click(screen.getByRole('button', { name: en.addHoliday }));
    const dialog = screen.getByRole('dialog');

    await user.type(field(dialog, 'input[name="name"]'), 'Good Friday');
    await user.selectOptions(field(dialog, 'select[name="state"]'), 'Sabah');
    await user.selectOptions(field(dialog, 'select[name="holidayType"]'), 'company');
    await user.click(field(dialog, 'input[name="tentative"]'));
    await user.click(within(dialog).getByRole('button', { name: en.save }));

    // The service's words paint INSIDE the dialog…
    expect(await within(dialog).findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // …and every field still holds what was typed. The <select>s and the checkbox are the ones React's
    // post-action form reset snaps back to their defaults — and it DID, with the movement dialog's
    // onReset cancel in place, when this dialog was first built (react-dom disables its own listener
    // during the commit in which it calls form.reset(), so the cancel never runs). The form therefore
    // dispatches the action itself and React never requests the reset; this is the line that proves it.
    expect(field<HTMLInputElement>(dialog, 'input[name="name"]').value).toBe('Good Friday');
    expect(field<HTMLSelectElement>(dialog, 'select[name="state"]').value).toBe('Sabah');
    expect(field<HTMLSelectElement>(dialog, 'select[name="holidayType"]').value).toBe('company');
    expect(field<HTMLInputElement>(dialog, 'input[name="tentative"]').checked).toBe(true);
    expect(push).not.toHaveBeenCalled();

    // What actually went to the server: the typed values, the state, and the filter — no id (an insert).
    expect(save).toHaveBeenCalledTimes(1);
    const posted = save.mock.calls[0]![1] as FormData;
    expect(posted.get('name')).toBe('Good Friday');
    expect(posted.get('state')).toBe('Sabah');
    expect(posted.get('holidayType')).toBe('company');
    expect(posted.get('tentative')).toBe('on');
    expect(posted.get('active')).toBe('on');
    expect(posted.get('country')).toBe('MY');
    expect(posted.get('filterPage')).toBe('1');
    expect(posted.get('id')).toBeNull();
  });

  it('a successful save navigates to the page the action answers with, and closes', async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, path: '/admin/holidays?country=MY&page=2' });
    mountEdit();
    await user.click(screen.getByRole('button', { name: en.edit }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(field(dialog, 'select[name="state"]'), 'Sarawak');
    await user.click(within(dialog).getByRole('button', { name: en.save }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/holidays?country=MY&page=2'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const posted = save.mock.calls[0]![1] as FormData;
    expect(posted.get('id')).toBe('h-1');
    expect(posted.get('state')).toBe('Sarawak');
  });
});
