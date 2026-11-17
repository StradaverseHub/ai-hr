/**
 * Slice 15 review — the outcome of a long Recruitment form whose save RETURNS a refusal instead of redirecting (the new-position
 * form and the position template form). A refusal keeps the person on the same form with everything they typed and the chosen
 * company: the typed values come back in the action's state to the same viewer (never in the URL, never logged), and the
 * refused field names let each field say what is wrong next to it. A successful save still redirects.
 *
 * Shared by app/recruitment/actions.ts (server) and app/recruitment/action-form.tsx (client); no directive, no server import.
 */
export type FormRefusal = {
  status: 'idle' | 'refused';
  /** The service's refusal code (recruitment.errors). */
  problem?: string;
  /** The sentence for the banner, already in the viewer's language. */
  errorText?: string;
  /** The refused fields, by form name (`cf.<field id>` for a custom field, `interviewPlan`, `title` …). */
  fields?: string[];
  /** What the form carried, by input name (every value of a repeated name, in order). */
  values?: Record<string, string[]>;
  /** Changes on every refusal, so the form re-applies the values even when they are the same as before. */
  nonce?: number;
};

/** Every text value a form carried, by name; React's own action keys ($ACTION_…) are left out. */
export function formValuesOf(form: Pick<FormData, 'entries'>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of form.entries()) {
    if (k.startsWith('$') || typeof v !== 'string') continue;
    (out[k] ??= []).push(v);
  }
  return out;
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * Put a refused form's values back into its controls (should the form have been re-rendered with its defaults): text-like inputs,
 * textareas and selects take their value(s); checkboxes and radios are checked exactly when their value was sent (an unchecked
 * checkbox is absent from a submission, so one whose name was not sent is unchecked). Hidden inputs, files and buttons are left alone.
 */
export function restoreFormValues(form: HTMLFormElement, values: Record<string, string[]>): void {
  const seen = new Map<string, number>();
  for (const el of Array.from(form.elements) as Control[]) {
    const name = el.getAttribute('name');
    if (!name || el instanceof HTMLButtonElement) continue;
    const sent = values[name] ?? [];
    if (el instanceof HTMLInputElement) {
      if (el.type === 'hidden' || el.type === 'file' || el.type === 'submit' || el.type === 'button') continue;
      if (el.type === 'checkbox' || el.type === 'radio') { el.checked = sent.includes(el.value); continue; }
    }
    if (el instanceof HTMLSelectElement && el.multiple) {
      for (const o of Array.from(el.options)) o.selected = sent.includes(o.value);
      continue;
    }
    // Repeated names (the interview plan's rounds) take their values in order.
    const i = seen.get(name) ?? 0;
    seen.set(name, i + 1);
    if (i < sent.length) el.value = sent[i];
  }
}
