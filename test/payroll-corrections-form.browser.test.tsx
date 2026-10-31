import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { page } from 'vitest/browser';
import en from '../messages/en.json';
import '../app/globals.css';

const save = vi.hoisted(() => vi.fn(async (_previous: unknown, _formData: FormData) => ({ saved: true })));
vi.mock('../app/(app)/payroll/setup/corrections-actions', () => ({ savePayrollCorrections: save }));
const { PayrollCorrectionsForm } = await import('../app/(app)/payroll/setup/corrections-form');
const labels = en.payroll.setup.corrections;
afterEach(() => { cleanup(); vi.clearAllMocks(); document.documentElement.removeAttribute('data-ui-theme'); document.documentElement.classList.remove('dark'); });

describe('payroll correction controls in Chromium', () => {
  it.each([1280, 390])('saves both directions and fits a %ipx screen', async width => {
    await page.viewport(width, 800);
    document.documentElement.setAttribute('data-ui-theme', 'atelier');
    render(<main className="mx-auto max-w-7xl space-y-6 p-6"><h1 className="text-2xl font-semibold">Payroll Settings</h1><PayrollCorrectionsForm enabled canEdit labels={labels} /></main>);
    const toggle = screen.getByRole('switch', { name: labels.label });
    const button = screen.getByRole('button', { name: labels.save });
    fireEvent.click(toggle);
    fireEvent.click(button);
    await screen.findByText(labels.saved);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect((save.mock.calls[0][1] as FormData).has('enabled')).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect((save.mock.calls[1][1] as FormData).get('enabled')).toBe('on');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
    await page.screenshot({ path: `../.vitest-attachments/payroll-corrections-${width}.png`, animations: 'disabled' });
  });
});
