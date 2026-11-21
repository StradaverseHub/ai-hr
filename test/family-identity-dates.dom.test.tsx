import { fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { FamilyIdentityDates } from '../components/family-identity-dates';
import { FamilyRelationshipFields } from '../components/family-relationship-fields';
import messages from '../messages/en.json';

function renderFamily(relationship: string, initialDob = '', initialIc = '') {
  const choices = ['spouse', 'child', 'parent', 'sibling', 'other', 'guardian'];
  const dates = (child: boolean) => (
    <FamilyIdentityDates child={child} initialIc={initialIc} initialDob={initialDob}
      dobLabel="Date of birth" asOf={new Date('2026-05-15T00:00:00Z')} />
  );
  const { container, getByRole } = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <form>
        <FamilyRelationshipFields label="Relationship" placeholder="Choose a relationship"
          options={choices.map((value) => ({ value, label: value }))}
          spousePanel={dates(false)} childPanel={dates(true)} otherPanel={dates(false)} />
      </form>
    </NextIntlClientProvider>,
  );
  const form = container.querySelector('form')!;
  return {
    form,
    async selectRelationship() {
      await userEvent.selectOptions(getByRole('combobox'), relationship);
      const panel = form.querySelector('fieldset:not([disabled])')!;
      return {
        ic: panel.querySelector<HTMLInputElement>('[name="icOrPassport"]')!,
        dob: panel.querySelector<HTMLInputElement>('[name="dateOfBirth"]')!,
        age: panel.querySelector<HTMLInputElement>('[data-personnel-field="family.family_and_dependents.age"]')!,
      };
    },
  };
}

describe('Family identity dates', () => {
  it.each([
    ['spouse', '900515-10-1234', '1990-05-15', '36'],
    ['child', '120306-10-1234', '2012-03-06', '14'],
    ['parent', '850823-14-5678', '1985-08-23', '40'],
    ['sibling', '000229101234', '2000-02-29', '26'],
    ['other', '260515101234', '2026-05-15', '0'],
    ['guardian', '900516101234', '1990-05-16', '35'],
  ])('fills date and completed age for %s', async (relationship, raw, birthDate, completedAge) => {
    const { form, selectRelationship } = renderFamily(relationship);
    const { ic, dob, age } = await selectRelationship();
    const user = userEvent.setup();
    await user.click(ic);
    await user.paste(raw);

    expect(dob.value).toBe(birthDate);
    expect(age.value).toBe(completedAge);
    expect(age.readOnly).toBe(true);
    expect(new FormData(form).getAll('dateOfBirth')).toEqual([birthDate]);
    expect(new FormData(form).has('age')).toBe(false);
  });

  it('clears only derived dates when the IC is cleared, partial or invalid', async () => {
    const { selectRelationship } = renderFamily('spouse');
    const { ic, dob, age } = await selectRelationship();
    for (const invalid of ['', '900515-10', '900431-10-1234', '010229-10-1234']) {
      fireEvent.change(ic, { target: { value: '900515-10-1234' } });
      expect(dob.value).toBe('1990-05-15');
      fireEvent.change(ic, { target: { value: invalid } });
      expect(dob.value).toBe('');
      expect(age.value).toBe('');
    }
  });

  it('preserves saved and manually edited dates, including an intentional clear', async () => {
    const { selectRelationship } = renderFamily('child', '2012-03-06', '120306101234');
    const { ic, dob, age } = await selectRelationship();
    expect(age.value).toBe('14');
    fireEvent.change(ic, { target: { value: '100101101234' } });
    expect(dob.value).toBe('2012-03-06');

    fireEvent.change(dob, { target: { value: '2010-05-16' } });
    expect(age.value).toBe('15');
    fireEvent.change(ic, { target: { value: '' } });
    expect(dob.value).toBe('2010-05-16');

    fireEvent.change(dob, { target: { value: '' } });
    fireEvent.change(ic, { target: { value: '900515101234' } });
    expect(dob.value).toBe('');
    expect(age.value).toBe('');
  });
});
