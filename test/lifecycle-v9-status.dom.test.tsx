import { beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CaseStatus } from '../app/(app)/lifecycle/v9/case-status';
beforeAll(() => { Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } }); });
it('requires an explicit reason before sending a missing-item change and retains it after a failure', async () => {
  const change = vi.fn().mockResolvedValueOnce({ ok: false, error: 'This case changed. Refresh before trying again.' }).mockResolvedValueOnce({ ok: true });
  render(<CaseStatus name="Fictional laptop" kind="item" value="todo" reason="" busy={false} editable change={change}/>);
  fireEvent.change(screen.getByLabelText('Status for Fictional laptop'), { target: { value: 'notReturned' } });
  expect(change).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Reason required'), { target: { value: 'Employee reported the device missing.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This case changed'); expect(screen.getByLabelText('Reason required')).toHaveValue('Employee reported the device missing.');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(change).toHaveBeenLastCalledWith('notReturned', 'Employee reported the device missing.');
});
it('cancels an exception without changing the task and prevents bypassing its linked document', () => {
  const change = vi.fn(); render(<CaseStatus name="Sign form" kind="task" value="todo" reason="" busy={false} editable documentLinked change={change}/>);
  expect(screen.getByRole('option', { name: 'Done' })).toBeDisabled(); expect(screen.queryByRole('option', { name: 'Not returned' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Status for Sign form'), { target: { value: 'notNeeded' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close reason' })); expect(change).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Status for Sign form')).toHaveValue('todo');
});
