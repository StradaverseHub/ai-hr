import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import type { SwitcherEmployee } from '../app/admin/personnel/employee-search';
const mocks = vi.hoisted(() => ({ search: vi.fn(), push: vi.fn() }));
vi.mock('../app/admin/personnel/search-actions', () => ({ searchPersonnelEmployeesAction: mocks.search }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
import { EmployeeSwitcher } from '../app/admin/personnel/employee-switcher';

const employee = (id: string, name: string): SwitcherEmployee => ({ employmentId: id, name, employeeCode: `EMP-${id}`, company: 'Acme', department: 'Finance' });
const first = employee('first', 'Aisha Rahman');
const second = employee('second', 'Bala Krishnan');
const renderSwitcher = () => render(<NextIntlClientProvider locale="en" messages={messages}><EmployeeSwitcher tab="profile" currentEmploymentId="first" /></NextIntlClientProvider>);
beforeEach(() => { vi.resetAllMocks(); });

describe('Personnel server search interaction', () => {
  it('searches after typing and preserves current tagging, arrows, Enter and tab navigation', async () => {
    mocks.search.mockResolvedValue([first, second]);
    renderSwitcher();
    expect(mocks.search).not.toHaveBeenCalled();
    const user = userEvent.setup();
    const box = screen.getByRole('combobox');
    await user.type(box, 'employee');
    expect(box).toHaveAttribute('aria-busy', 'true');
    await screen.findByRole('option', { name: /Aisha Rahman/ });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith('employee');
    expect(screen.getByRole('option', { name: /Aisha Rahman/ })).toHaveTextContent('Current');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Bala/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}{ArrowDown}{Enter}');
    expect(mocks.push).toHaveBeenCalledWith('/admin/personnel/second?tab=profile');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('never displays or selects results for an older query after typing changes', async () => {
    let finishOld!: (rows: SwitcherEmployee[]) => void;
    mocks.search.mockImplementation((query: string) => query === 'old'
      ? new Promise<SwitcherEmployee[]>((resolve) => { finishOld = resolve; }) : Promise.resolve([second]));
    renderSwitcher();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'old' } });
    await waitFor(() => expect(mocks.search).toHaveBeenCalledWith('old'));
    fireEvent.change(box, { target: { value: 'new' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(mocks.push).not.toHaveBeenCalled();
    await screen.findByRole('option', { name: /Bala/ });
    await act(async () => finishOld([first]));
    expect(screen.queryByRole('option', { name: /Aisha/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bala/ })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps failed requests distinct from no matches and permits retry without changing the query', async () => {
    mocks.search.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce([]);
    renderSwitcher();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'missing' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.commandBar.loadError);
    await userEvent.click(screen.getByRole('button', { name: messages.commandBar.retry }));
    await screen.findByText(messages.people.switcher.noMatches);
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes on Escape and does not reopen when an in-flight request completes', async () => {
    let finish!: (rows: SwitcherEmployee[]) => void;
    mocks.search.mockReturnValue(new Promise<SwitcherEmployee[]>((resolve) => { finish = resolve; }));
    renderSwitcher();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'aisha' } });
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    fireEvent.keyDown(box, { key: 'Escape' });
    await act(async () => finish([first]));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.focus(box);
    expect(screen.getByRole('option', { name: /Aisha/ })).toBeInTheDocument();
  });
});
