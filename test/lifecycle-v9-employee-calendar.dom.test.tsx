import { expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const actions = vi.hoisted(() => ({ task: vi.fn(), document: vi.fn(), report: vi.fn() }));
vi.mock('../app/(app)/me/lifecycle/actions', () => ({ updateOwnLifecycleTask: actions.task, saveOwnLifecycleDocument: actions.document, reportOwnLifecycleReturn:actions.report }));
import { EmployeeLifecycle } from '../app/(app)/me/lifecycle/view';
import type { LifecycleV9OwnCase } from '../packs/lifecycle/service';
it('shows actual calendar dates, locks future tasks and labels another person’s assigned case', () => {
  const c = { id: 'case', number: 'OB-FICTIONAL', module: 'onb', revision: 2, state: 'submitted', own: false, facts: { name: 'Fictional joiner', joinDate: '2026-11-02' }, documents: [], items: [], tasks: [{ id: 'future', name: 'Day 1 orientation', by: 'group', due: 1, opensOn: '2026-11-02', dueOn: '2026-11-02', status: 'todo', documentTemplate: null }] } as unknown as LifecycleV9OwnCase;
  render(<EmployeeLifecycle cases={[c]} today="2026-10-30"/>);
  expect(screen.getByRole('heading', { name: 'Tasks for Fictional joiner' })).toBeInTheDocument();
  const calendar = screen.getByRole('region', { name: 'My calendar' });
  expect(within(calendar).getByText('Opens: Day 1 orientation · Fictional joiner')).toBeVisible();
  expect(within(calendar).getByText('Mon 2 Nov')).toHaveAttribute('datetime', '2026-11-02');
  const status = screen.getByRole('combobox', { name: 'Status for Day 1 orientation' });
  expect(status).toBeDisabled();
  // Disabled controls are the visible affordance; the canonical command remains the authorization boundary.
  expect(screen.getByText(/Opens 02\/11\/2026/)).toBeVisible();
});
