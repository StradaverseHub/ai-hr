import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { DirectSuperiorChangeForm } from '../app/admin/personnel/[employmentId]/direct-superior-change-form';
import messages from '../messages/en.json';

const copy = messages.people.detail;
const labels = {
  title: copy.directSuperiorChangeTitle,
  amendment: copy.directSuperiorAmend,
  movement: copy.directSuperiorMovement,
  reason: copy.directSuperiorReason,
  effectiveDate: copy.movement.columns.effectiveDate,
  cancel: copy.directSuperiorCancel,
  save: copy.directSuperiorSave,
};

function renderForm() {
  const action = vi.fn(async (_data: FormData) => {});
  const rendered = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DirectSuperiorChangeForm action={action} employmentId="employee" currentLineId="line" labels={labels}>
        <input type="hidden" name="superiorEmploymentId" value="new-superior" />
      </DirectSuperiorChangeForm>
    </NextIntlClientProvider>,
  );
  return { action, form: rendered.container.querySelector('form')! };
}

afterEach(cleanup);

describe('Direct Superior Employment confirmation', () => {
  it('opens the choices on Save and omits the date for an amendment', async () => {
    const user = userEvent.setup();
    const { action, form } = renderForm();
    await user.click(screen.getByRole('button', { name: labels.save }));
    expect(action).not.toHaveBeenCalled();
    const choices = within(screen.getByRole('group', { name: labels.title }));
    expect(choices.getByRole('button', { name: labels.save })).toBeDisabled();
    await user.click(choices.getByRole('radio', { name: labels.amendment }));
    await user.type(choices.getByRole('textbox', { name: labels.reason }), 'Correct the existing assignment');
    const data = new FormData(form);
    expect(data.get('superiorChangeMode')).toBe('amend');
    expect(data.get('currentLineId')).toBe('line');
    expect(data.get('superiorChangeReason')).toBe('Correct the existing assignment');
    expect(data.has('superiorEffectiveDate')).toBe(false);
  });

  it('requires an empty-by-default date for a new movement and discards the choice on Cancel', async () => {
    const user = userEvent.setup();
    const { action, form } = renderForm();
    await user.click(screen.getByRole('button', { name: labels.save }));
    const choices = within(screen.getByRole('group', { name: labels.title }));
    await user.click(choices.getByRole('radio', { name: labels.movement }));
    expect(choices.getByLabelText(labels.effectiveDate)).toBeRequired();
    expect(choices.getByLabelText(labels.effectiveDate)).toHaveValue('');
    expect(form).toBeInvalid();
    await user.click(choices.getByRole('button', { name: labels.cancel }));
    expect(screen.queryByRole('group', { name: labels.title })).not.toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
});
