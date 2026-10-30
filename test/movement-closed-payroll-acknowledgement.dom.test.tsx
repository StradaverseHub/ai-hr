/**
 * 646355e5 — the closed-payroll acknowledgement on a Movement rollback, proved over the FormData the
 * browser would post. The service refuses without `acknowledgeClosedPayroll=1`
 * (test/movement-corrections.test.ts); this pins that the dialog keeps Confirm disabled until the box is
 * ticked and only then mirrors the value into the enclosing form.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { ConfirmSubmit } from '../components/ui/confirm-submit';

function Rollback() {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <form data-testid="form" onSubmit={(e) => e.preventDefault()}>
        <ConfirmSubmit
          title="Roll back this movement?"
          confirmLabel="Roll Back"
          reasonField={{ name: 'reason', label: 'Reason (required)', required: true }}
          acknowledgement={{ name: 'acknowledgeClosedPayroll', warning: 'Payroll for 2026-08 is already closed.', label: 'I understand that closed payroll will not change.' }}
        >
          Roll Back
        </ConfirmSubmit>
      </form>
    </NextIntlClientProvider>
  );
}

describe('646355e5 closed-payroll acknowledgement', () => {
  it('keeps Confirm disabled until the reason AND the acknowledgement are given, then posts it', async () => {
    const user = userEvent.setup();
    render(<Rollback />);
    await user.click(screen.getByRole('button', { name: 'Roll Back' }));
    const confirm = () => screen.getAllByRole('button', { name: 'Roll Back' }).at(-1)!;
    expect(screen.getByText('Payroll for 2026-08 is already closed.')).toBeTruthy();

    await user.type(screen.getByRole('textbox'), 'Wrong event type');
    expect((confirm() as HTMLButtonElement).disabled).toBe(true);
    const form = screen.getByTestId('form') as HTMLFormElement;
    expect(new FormData(form).get('acknowledgeClosedPayroll')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'I understand that closed payroll will not change.' }));
    expect((confirm() as HTMLButtonElement).disabled).toBe(false);
    expect(new FormData(form).get('acknowledgeClosedPayroll')).toBe('1');
    expect(new FormData(form).get('reason')).toBe('Wrong event type');
  });
});
