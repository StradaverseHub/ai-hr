/**
 * Customize Columns, RENDERED (feedback 579255c3, points 2 & 3).
 *
 * A rendering test rather than a source scan, because every claim this item makes about the picker is a
 * claim about behaviour: that ticking a box changes nothing until Apply, that dragging a row changes the
 * ORDER that Apply sends, that Full Name cannot be switched off, and that the payload is a plain
 * serialisable object rather than anything a server action would refuse. A source assertion can see the
 * checkbox exists; only a render can see what the Apply button actually hands over.
 *
 * Scope note: jsdom applies no CSS and computes no layout, so nothing here says anything about how the
 * popover sits over the toolbar. What it pins is the payload contract and the keyboard path — the ↑/↓
 * buttons, which are the accessible half of "drag to reorder" and the half a mouse-only test would miss.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ColumnPicker, type EmployeeColumnChoice } from '../app/admin/personnel/column-picker';

// The router, stubbed. `refresh()` is RECORDED rather than performed: after Apply the picker asks the
// server to re-render the table so the columns and the Export link are rebuilt from the SAVED value
// rather than guessed at on the client — that request is part of the contract, the navigation is not.
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  useSearchParams: () => new URLSearchParams(''),
}));

const labels = {
  title: 'Customize Columns',
  hint: 'Tick to show. Drag to reorder.',
  apply: 'Apply',
  reset: 'Reset to default',
  moveUp: 'Move up',
  moveDown: 'Move down',
  unavailableNote:
    'Not held in Personnel yet: Division, Section, Line, Team, Region, Base, Employee Category, Employee Type.',
};

const columns: EmployeeColumnChoice[] = [
  { key: 'code', label: 'Emp ID' },
  { key: 'name', label: 'Full Name', mandatory: true },
  { key: 'company', label: 'Company' },
  { key: 'department', label: 'Department' },
  { key: 'position', label: 'Position' },
  { key: 'status', label: 'Status' },
  { key: 'jobGrade', label: 'Job Grade' },
];

const DEFAULTS = ['code', 'name', 'company', 'department', 'position', 'status'];

function renderPicker(selected: string[] = DEFAULTS) {
  const saveAction = vi.fn(async (_prefs: { selected: string[]; order: string[] }) => {});
  const resetAction = vi.fn(async () => {});
  const view = render(
    <ColumnPicker
      columns={columns}
      selected={selected}
      labels={labels}
      saveAction={saveAction}
      resetAction={resetAction}
    />,
  );
  const open = () => userEvent.click(screen.getByRole('button', { name: labels.title }));
  const box = (label: string) => screen.getByRole('checkbox', { name: label });
  const rowKeys = () =>
    [...view.container.querySelectorAll('li[data-column]')].map((li) => li.getAttribute('data-column'));
  return { ...view, saveAction, resetAction, open, box, rowKeys };
}

describe('ColumnPicker · what Apply hands over', () => {
  it('opens a dialog listing every catalogue column, ticked according to the saved view', async () => {
    const { open, box, rowKeys } = renderPicker();
    await open();
    expect(screen.getByRole('dialog', { name: labels.title })).toBeInTheDocument();
    expect(rowKeys()).toEqual(['code', 'name', 'company', 'department', 'position', 'status', 'jobGrade']);
    expect(box('Emp ID')).toBeChecked();
    // Job Grade exists in the panel but is off by default — the reporter's six columns are the view.
    expect(box('Job Grade')).not.toBeChecked();
    // The fields that do not exist are NAMED, not silently missing (18103ba4's precedent).
    expect(screen.getByText(labels.unavailableNote)).toBeInTheDocument();
  });

  it('ticking changes nothing until Apply, and then sends the chosen set IN PANEL ORDER', async () => {
    const { open, box, saveAction } = renderPicker();
    await open();
    await userEvent.click(box('Job Grade'));
    await userEvent.click(box('Department'));
    expect(saveAction).not.toHaveBeenCalled(); // a draft until Apply — an interrupted fiddle costs nothing

    await userEvent.click(screen.getByRole('button', { name: labels.apply }));
    expect(saveAction).toHaveBeenCalledTimes(1);
    const payload = saveAction.mock.calls[0][0];
    expect(payload.selected).toEqual(['code', 'name', 'company', 'position', 'status', 'jobGrade']);
    // The ORDER carries every column, shown and hidden alike, so a hidden column keeps its place.
    expect(payload.order).toEqual(['code', 'name', 'company', 'department', 'position', 'status', 'jobGrade']);
    // Serialisable only: a server action must not be handed a function or a class instance.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('Full Name cannot be switched off', async () => {
    const { open, box, saveAction } = renderPicker();
    await open();
    expect(box('Full Name')).toBeDisabled();
    await userEvent.click(box('Full Name')).catch(() => {}); // pointer-events on a disabled box
    await userEvent.click(screen.getByRole('button', { name: labels.apply }));
    const payload = saveAction.mock.calls[0][0];
    expect(payload.selected).toContain('name');
  });

  it('the ↑/↓ buttons reorder the list, and Apply sends the new order', async () => {
    const { open, rowKeys, saveAction } = renderPicker();
    await open();
    // Job Grade is last; move it above Status, which is the reporter's own worked example
    // (Emp ID → Full Name → Company → Department → Position → Job Grade → Status).
    await userEvent.click(screen.getByRole('button', { name: `${labels.moveUp}: Job Grade` }));
    expect(rowKeys()).toEqual(['code', 'name', 'company', 'department', 'position', 'jobGrade', 'status']);

    await userEvent.click(screen.getByRole('button', { name: labels.apply }));
    const payload = saveAction.mock.calls[0][0];
    expect(payload.order).toEqual([
      'code',
      'name',
      'company',
      'department',
      'position',
      'jobGrade',
      'status',
    ]);
    // The SELECTION follows the order, so the table cannot render in a third sequence.
    expect(payload.selected).toEqual(['code', 'name', 'company', 'department', 'position', 'status']);
  });

  it('the first row cannot move up and the last cannot move down', async () => {
    const { open } = renderPicker();
    await open();
    expect(screen.getByRole('button', { name: `${labels.moveUp}: Emp ID` })).toBeDisabled();
    expect(screen.getByRole('button', { name: `${labels.moveDown}: Job Grade` })).toBeDisabled();
  });

  it('Reset asks the server to clear the saved view rather than saving a default', async () => {
    const { open, resetAction, saveAction } = renderPicker();
    await open();
    await userEvent.click(screen.getByRole('button', { name: labels.reset }));
    expect(resetAction).toHaveBeenCalledTimes(1);
    expect(saveAction).not.toHaveBeenCalled();
  });
});
