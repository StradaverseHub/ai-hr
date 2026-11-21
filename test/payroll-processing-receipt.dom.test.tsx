import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const { request, refresh, replace } = vi.hoisted(() => ({
  request: vi.fn(), refresh: vi.fn(), replace: vi.fn(),
}));
const router = { refresh, replace };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../app/payroll/actions', () => ({ requestPayrollProcessingReceipt: request }));

import { PayrollProcessingReceipt } from '../app/payroll/[batchId]/processing-receipt';

const unavailable = 'The result could not be confirmed. Check the current status before repeating the action.';

function renderForm() {
  const fallback = vi.fn();
  const { container } = render(
    <form action={fallback}>
      <input type="hidden" name="batchId" value="fictional-run" />
      <PayrollProcessingReceipt unavailable={unavailable}>
        <input type="hidden" name="ackWarnings" value="1" />
        <button type="submit">Process Payroll</button>
      </PayrollProcessingReceipt>
    </form>,
  );
  return { form: container.querySelector('form')!, fallback };
}

beforeEach(() => vi.resetAllMocks());

it('sends one request with the confirmed warning and refreshes only after acceptance', async () => {
  const pending = Promise.withResolvers<{ status: 'queued'; message: string }>();
  request.mockReturnValue(pending.promise);
  const { form, fallback } = renderForm();

  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(request).toHaveBeenCalledOnce();
  expect(Object.fromEntries(request.mock.calls[0][0])).toMatchObject({
    batchId: 'fictional-run', ackWarnings: '1',
  });
  expect(fallback).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole('button')).toBeDisabled();

  pending.resolve({ status: 'queued', message: 'Payroll processing started.' });
  expect(await screen.findByRole('status')).toHaveTextContent('Payroll processing started.');
  expect(refresh).toHaveBeenCalledOnce();
});

it('keeps a warning refusal on the form and lets the operator try again', async () => {
  request.mockResolvedValue({ status: 'refused', message: 'Confirm the warnings.' });
  const { form } = renderForm();

  fireEvent.submit(form);

  expect(await screen.findByRole('alert')).toHaveTextContent('Confirm the warnings.');
  expect(screen.getByRole('button')).toBeEnabled();
  expect(refresh).not.toHaveBeenCalled();
});

it('checks the register after an uncertain transport failure', async () => {
  request.mockRejectedValue(new Error('connection closed'));
  const { form } = renderForm();

  fireEvent.submit(form);

  expect(await screen.findByRole('alert')).toHaveTextContent(unavailable);
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});
