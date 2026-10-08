/**
 * r422 (board 7e784380) — components/ui/date-field.tsx: SHOWS DD-MMM-YYYY, POSTS yyyy-mm-dd.
 *
 * The contract every server action on the Personnel profile relies on is that the field it reads is still
 * a native `<input type="date">` with the same `name` and the same ISO value. So each case below reads the
 * value the way the action does — `new FormData(form).get(name)` — and reads the display the way the
 * reader does — the visible text and the accessible name — and the two must agree on the same date.
 */
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DateField } from '../components/ui/date-field';

function inForm(ui: React.ReactNode) {
  const formRef = createRef<HTMLFormElement>();
  const utils = render(<form ref={formRef}>{ui}</form>);
  return { ...utils, form: () => formRef.current! };
}

describe('r422 — DateField', () => {
  it('posts the ISO value under the same name and shows DD-MMM-YYYY', () => {
    const { form, container } = inForm(<DateField name="hiredOn" defaultValue="2026-01-31" label="Join Date" required />);
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(input, 'still a native date input').not.toBeNull();
    expect(input.name).toBe('hiredOn');
    expect(input.required).toBe(true);
    expect(new FormData(form()).get('hiredOn'), 'the action reads ISO').toBe('2026-01-31');
    expect(container.querySelector('[data-date-display]')?.textContent, 'the reader sees DMY').toBe('31-Jan-2026');
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(screen.getByLabelText('Join Date: 31-Jan-2026')).toBe(input);
  });

  it('a blank field posts blank and shows the em dash', () => {
    const { form, container } = inForm(<DateField name="validTo" label="To" />);
    expect(new FormData(form()).get('validTo')).toBe('');
    expect(container.querySelector('[data-date-display]')?.textContent).toBe('—');
    expect(screen.getByLabelText('To')).toBeInstanceOf(HTMLInputElement);
  });

  it('picking a date updates the display and the posted value together', () => {
    const onChange = vi.fn();
    const { form, container } = inForm(<DateField name="effectiveDate" defaultValue="2026-01-31" label="Effective" onChange={onChange} />);
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2028-02-29' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(new FormData(form()).get('effectiveDate')).toBe('2028-02-29');
    expect(container.querySelector('[data-date-display]')?.textContent).toBe('29-Feb-2028');
    expect(input.getAttribute('aria-label')).toBe('Effective: 29-Feb-2028');
  });

  it('a script’s `el.value = …` write (IcDobAutofill) reaches the display', () => {
    const { form, container } = inForm(<DateField id="profile-dob-input" name="dateOfBirth" defaultValue="" label="Date of birth" />);
    const input = document.getElementById('profile-dob-input') as HTMLInputElement;
    act(() => {
      input.value = '1990-01-01';
    });
    expect(new FormData(form()).get('dateOfBirth')).toBe('1990-01-01');
    expect(container.querySelector('[data-date-display]')?.textContent).toBe('01-Jan-1990');
  });

  it('a form reset puts the display back with the value', async () => {
    const { form, container } = inForm(<DateField name="d" defaultValue="2026-03-15" />);
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-04-01' } });
    expect(container.querySelector('[data-date-display]')?.textContent).toBe('01-Apr-2026');
    await act(async () => {
      form().reset();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(new FormData(form()).get('d')).toBe('2026-03-15');
    expect(container.querySelector('[data-date-display]')?.textContent).toBe('15-Mar-2026');
  });

  it('a controlled value is drawn as given', () => {
    const { rerender, container } = render(<DateField value="2026-12-31" onChange={() => undefined} />);
    expect(container.querySelector('[data-date-display]')?.textContent).toBe('31-Dec-2026');
    rerender(<DateField value="" onChange={() => undefined} />);
    expect(container.querySelector('[data-date-display]')?.textContent).toBe('—');
  });

  it('click and Space open the native picker where the browser has one; disabled does not', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-01-31" />);
    const input = container.querySelector('input[type="date"]') as HTMLInputElement & { showPicker?: () => void };
    const showPicker = vi.fn();
    input.showPicker = showPicker;
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: ' ' });
    fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
    expect(showPicker).toHaveBeenCalledTimes(3);
    // Enter is NOT taken: the surrounding form keeps whatever it does with Enter.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(showPicker).toHaveBeenCalledTimes(3);
    // The input is the focusable element (keyboard reachable), not a decorative span.
    input.focus();
    expect(document.activeElement).toBe(input);

    const off = render(<DateField name="e" defaultValue="2026-01-31" disabled />);
    const disabled = off.container.querySelector('input[type="date"]') as HTMLInputElement & { showPicker?: () => void };
    const neverCalled = vi.fn();
    disabled.showPicker = neverCalled;
    fireEvent.click(disabled);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it('a browser without showPicker (or one that throws) still works', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-01-31" />);
    const input = container.querySelector('input[type="date"]') as HTMLInputElement & { showPicker?: () => void };
    input.showPicker = () => {
      throw new DOMException('not allowed', 'NotAllowedError');
    };
    expect(() => fireEvent.click(input)).not.toThrow();
  });
});
