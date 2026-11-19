import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { FamilyIdentityDates } from '../components/family-identity-dates';
import en from '../messages/en.json';
import '../app/globals.css';

afterEach(cleanup);

it.each([
  { width: 1200, child: true, label: 'Child' },
  { width: 375, child: false, label: 'Other family member' },
])('fits and accepts keyboard input for a $label at $width px', async ({ width, child, label }) => {
  await page.viewport(width, 760);
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <main className="mx-auto max-w-3xl p-4">
        <form className="rounded-lg border border-border p-3">
          <h1 className="mb-3 text-base font-medium">{label}</h1>
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
            <FamilyIdentityDates child={child} initialIc="" initialDob="" dobLabel="Date of Birth"
              asOf={new Date('2026-11-19T00:00:00+08:00')} />
          </div>
        </form>
      </main>
    </NextIntlClientProvider>,
  );
  const form = container.querySelector('form')!;
  const ic = form.querySelector<HTMLInputElement>('input[name="icOrPassport"]')!;
  const dob = form.querySelector<HTMLInputElement>('input[name="dateOfBirth"]')!;
  const age = form.querySelector<HTMLInputElement>('input[readonly]')!;
  await userEvent.tab();
  expect(document.activeElement).toBe(ic);
  await userEvent.keyboard('150518-14-1234');
  await expect.poll(() => dob.value).toBe('2015-05-18');
  expect(age.value).toBe('11');
  expect(age.name).toBe('');
  expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth);
  for (const input of [ic, dob, age]) {
    const { left, right } = input.getBoundingClientRect();
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(width);
  }
  const evidence = await page.screenshot({ element: form, animations: 'disabled', scale: 'css', base64: true,
    path: `../.vitest-attachments/family-identity-${width}.png` });
  console.info('FAMILY_IDENTITY_PREVIEW ' + JSON.stringify({ width, png: evidence.base64 }));
  await userEvent.tab();
  expect(document.activeElement).toBe(dob);
});
