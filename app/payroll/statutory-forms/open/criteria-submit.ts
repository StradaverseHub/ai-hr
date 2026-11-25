/**
 * Board 66175cd2 — WHO MAY DISABLE CONTINUE ON THE CRITERIA STEP, written once.
 *
 * Two islands on the same server-rendered GET form have a reason to hold Continue:
 *   • the Payroll Cycle list (`./cycles-criterion.tsx`, r407): runs are listed and none is ticked — an empty
 *     selection cannot be written on a URL, so Continue would quietly produce the whole month;
 *   • the period list (`./period-criterion.tsx`, 66175cd2): the company has no payroll month with processed
 *     EPF at all, so there is nothing Continue could open.
 * Each island records ITS reason as a data attribute on the form and then asks this function to settle the
 * button, so neither can re-enable a Continue the other is holding. The button is found by
 * `data-criteria-submit` inside the same form. With no runs listed, the cycle island holds nothing on
 * purpose — the server-side gate answers that, with its own sentence.
 */
export const HOLD_CYCLES = 'holdCycles';
export const HOLD_PERIODS = 'holdPeriods';

export function holdContinue(form: HTMLFormElement | null | undefined, reason: typeof HOLD_CYCLES | typeof HOLD_PERIODS, hold: boolean) {
  if (!form) return;
  if (hold) form.dataset[reason] = 'true';
  else delete form.dataset[reason];
  const button = form.querySelector<HTMLButtonElement>('[data-criteria-submit]');
  if (button) button.disabled = form.dataset[HOLD_CYCLES] === 'true' || form.dataset[HOLD_PERIODS] === 'true';
}
