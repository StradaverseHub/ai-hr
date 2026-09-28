/**
 * ══ 0df7dd44 (r352) — THE VISIBLE CLAMP, AND THE BANNER THAT DOES NOT NAVIGATE ══════════════════════
 *
 * The approved plan's third point: "when more than the remaining amount is keyed, the box is clamped DOWN
 * to the remaining amount VISIBLY, in front of the user, before submit — not silently altered at save
 * time." That is browser behaviour. It cannot be asserted by a source grep and it cannot be asserted by a
 * service test, which is why this file exists beside test/r352-tp1-limit.test.ts rather than inside it.
 *
 * ⚠️ EVERY FIXTURE HERE HAS A PRIOR APPROVED CLAIM, so `limit` and `remaining` are DIFFERENT NUMBERS.
 * That is the whole non-vacuity of the file. With `already: 0` the two figures coincide and every
 * assertion below would pass against a version that clamps to the ANNUAL LIMIT — which would hand an
 * employee who has already claimed this year a relief the server refuses and the PCB should never see.
 * Switch `bite.cap` from `limit − already` to `limit` in components/tp1-form-client.tsx and the named
 * assertions in "clamps DOWN to what REMAINS" fail.
 *
 * ⚠️ PRESENCE IS NOT TRANSLATION. `i18n/request.ts` deep-merges each locale over English, so a key missing
 * from ms.json renders the ENGLISH sentence and never a MISSING_MESSAGE. The locale case therefore asserts
 * the six sentences are DISTINCT as well as present.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import {
  Tp1AmountBox,
  Tp1DeclarationTick,
  Tp1EditableForm,
  Tp1ItemBoxes,
  Tp1RemarksField,
} from '../components/tp1-form-client';

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

const wrap = (node: ReactNode, messages: unknown = en) => (
  <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
    {node}
  </NextIntlClientProvider>
);

const box = (p: Partial<Tp1AmountBox> & { name: string }): Tp1AmountBox => ({
  sub: null,
  limit: null,
  already: 0,
  frequency: null,
  value: '',
  ...p,
});

/** Key a whole figure into a box, the way a paste or a finished entry arrives. */
const key = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });
const amount = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement;

// ── C2: one box, annual limit 6,000, and 4,500 of it already approved this assessment year ──────────
const C2_LIMIT = 6000;
const C2_ALREADY = 4500;
const C2_REMAINING = 1500; // ⚠️ the ONLY figure the box may be clamped to
const c2 = (
  <Tp1ItemBoxes
    group="items"
    code="c2"
    limit={C2_LIMIT}
    already={C2_ALREADY}
    perSubLimit={false}
    boxes={[box({ name: 'tp1_items_c2_amount' })]}
  />
);

describe('0df7dd44 · the amount box clamps DOWN to what REMAINS', () => {
  it('reduces an over-claim to limit − already, and NOT to the limit', () => {
    render(wrap(c2));
    const input = amount('tp1_items_c2_amount');
    key(input, '5000'); // inside the RM6,000 limit, well past the RM1,500 left of it
    // ⚠️ THE ASSERTION THE WHOLE ITEM TURNS ON. `6000.00` here is the silent over-claim.
    expect(input.value, 'the box was clamped to the LIMIT, which over-claims').toBe('1500.00');
  });

  it('leaves a figure that fits exactly alone', () => {
    render(wrap(c2));
    const input = amount('tp1_items_c2_amount');
    key(input, String(C2_REMAINING));
    expect(input.value).toBe('1500');
    expect(screen.queryByRole('status'), 'a figure that fits was reported as clamped').toBeNull();
  });

  it('names the limit, what is already approved this year, and what remains — beside the box', () => {
    render(wrap(c2));
    key(amount('tp1_items_c2_amount'), '5000');
    const note = screen.getByRole('status');
    expect(note.textContent, 'the annual limit is not named').toContain('6,000.00');
    expect(note.textContent, 'what is already approved this year is not named').toContain('4,500.00');
    expect(note.textContent, 'what remains is not named').toContain('1,500.00');
    expect(note.textContent, 'the offending box is not named').toContain('C2');
  });

  it('withdraws the message once the figure is corrected', () => {
    render(wrap(c2));
    const input = amount('tp1_items_c2_amount');
    key(input, '5000');
    expect(screen.getByRole('status')).toBeTruthy();
    key(input, '100');
    expect(screen.queryByRole('status'), 'the message outlived the problem').toBeNull();
  });

  it('clamps to zero when the year is already fully claimed, rather than to the limit', () => {
    render(
      wrap(
        <Tp1ItemBoxes
          group="items"
          code="c2"
          limit={C2_LIMIT}
          already={C2_LIMIT}
          perSubLimit={false}
          boxes={[box({ name: 'tp1_items_c2_amount' })]}
        />,
      ),
    );
    const input = amount('tp1_items_c2_amount');
    key(input, '500');
    expect(input.value, 'an exhausted line still accepted money').toBe('0.00');
  });

  /**
   * THE REASON THE ISLAND IS PER ITEM AND NOT PER BOX. C5's annual limit caps the SUM of its four lettered
   * lines, so the ceiling of (b) depends on what is currently sitting in (a) — a figure no server render
   * can know, because the reader has not submitted it. `validateCatalogueCategories` checks exactly this
   * sum, so a screen that clamped each box to the item's whole remaining would promise what the server
   * refuses.
   */
  it('accounts for the sibling lines under a shared annual limit', () => {
    render(
      wrap(
        <Tp1ItemBoxes
          group="items"
          code="c5"
          limit={2500}
          already={500}
          perSubLimit={false}
          boxes={[
            box({ name: 'tp1_items_c5_sub_a', sub: 'a' }),
            box({ name: 'tp1_items_c5_sub_b', sub: 'b' }),
          ]}
        />,
      ),
    );
    // 2,500 − 500 already approved = 2,000 left for the item, across both lines.
    key(amount('tp1_items_c5_sub_a'), '1600');
    expect(amount('tp1_items_c5_sub_a').value).toBe('1600');
    key(amount('tp1_items_c5_sub_b'), '900');
    expect(amount('tp1_items_c5_sub_b').value, 'the sibling line was ignored').toBe('400.00');
    expect(screen.getByRole('status').textContent, 'the message does not explain the item ceiling').toContain(
      '2,500.00',
    );
  });

  /** C1 group 8,000, with sub-line (c) limited to RM1,000 on the form. The SMALLER ceiling wins. */
  it("uses a sub-line's own printed cap when that is the smaller ceiling", () => {
    render(
      wrap(
        <Tp1ItemBoxes
          group="items"
          code="c1"
          limit={8000}
          already={0}
          perSubLimit={false}
          boxes={[
            box({ name: 'tp1_items_c1_sub_a', sub: 'a' }),
            box({ name: 'tp1_items_c1_sub_c', sub: 'c', limit: 1000, already: 400 }),
          ]}
        />,
      ),
    );
    key(amount('tp1_items_c1_sub_c'), '1200');
    // 1,000 − 400 already approved on THAT line = 600. Not 1,000, and not the group's 8,000.
    expect(amount('tp1_items_c1_sub_c').value).toBe('600.00');
    expect(screen.getByRole('status').textContent).toContain('C1(c)');
  });

  /** C16 — two independent claims, each with its own limit and its own Accumulated row, no group cap. */
  it('treats a perSubLimit item as two separate claims', () => {
    render(
      wrap(
        <Tp1ItemBoxes
          group="items"
          code="c16"
          limit={null}
          already={0}
          perSubLimit
          boxes={[
            box({ name: 'tp1_items_c16_sub_a', sub: 'a', limit: 7000, already: 3000 }),
            box({ name: 'tp1_items_c16_sub_b', sub: 'b', limit: 5000, already: 0 }),
          ]}
        />,
      ),
    );
    key(amount('tp1_items_c16_sub_a'), '6000');
    expect(amount('tp1_items_c16_sub_a').value, "band (a) ignored its own accumulated figure").toBe('4000.00');
    // Band (b) is untouched by band (a): they are not one pot.
    key(amount('tp1_items_c16_sub_b'), '5000');
    expect(amount('tp1_items_c16_sub_b').value, 'the two bands were treated as one group').toBe('5000');
  });

  /**
   * ADR-0008 — the agency's form prints no annual limit against Section D, so nothing here invents one.
   * A guessed cap on live payroll is a wrong-figure defect; an absent check is a missing check, and this
   * repo takes the missing check deliberately.
   */
  it('does not clamp a line the form prints no limit against', () => {
    render(
      wrap(
        <Tp1ItemBoxes
          group="rebates"
          code="d1"
          limit={null}
          already={0}
          perSubLimit={false}
          boxes={[box({ name: 'tp1_rebates_d1_sub_a', sub: 'a' })]}
        />,
      ),
    );
    const input = amount('tp1_rebates_d1_sub_a');
    key(input, '99999');
    expect(input.value, 'an unsourced cap was invented for Section D').toBe('99999');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never rewrites a saved figure on its own — only a keystroke can clamp', () => {
    // A draft written before this round can legitimately hold more than today's remaining. Silently
    // rewriting it on render is exactly the "silently altered at save time" the reporter asked against.
    render(
      wrap(
        <Tp1ItemBoxes
          group="items"
          code="c2"
          limit={C2_LIMIT}
          already={C2_ALREADY}
          perSubLimit={false}
          boxes={[box({ name: 'tp1_items_c2_amount', value: '5000.00' })]}
        />,
      ),
    );
    expect(amount('tp1_items_c2_amount').value, 'a stored figure was rewritten without a keystroke').toBe(
      '5000.00',
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is said in all six locales, and the six are DISTINCT', () => {
    const seen = new Set<string>();
    for (const [loc, messages] of LOCALES) {
      const { unmount } = render(wrap(c2, messages));
      key(amount('tp1_items_c2_amount'), '5000');
      const note = screen.getByRole('status').textContent ?? '';
      expect(note, `${loc} produced no clamp message`).not.toBe('');
      // Every ringgit figure is interpolated from the pack, so it survives translation.
      expect(note, `${loc} lost the remaining figure`).toContain('1,500.00');
      seen.add(note);
      unmount();
    }
    expect(seen.size, `six locales, ${seen.size} distinct sentences`).toBe(6);
  });
});

describe('0df7dd44 · the refusal stays on the form, and nothing keyed is lost', () => {
  const REFUSAL = 'C2 exceeds its annual limit — this is the message the reader must see.';

  /** The shape of the shipped form: the island owns the `<form>`, the boxes and the two other fields. */
  const editable = (action: (prev: { error: string | null }, fd: FormData) => Promise<{ error: string | null }>) => (
    <Tp1EditableForm action={action} formId="tp1-form" className="space-y-4">
      <input type="hidden" name="assessmentYear" value="2026" />
      <input type="hidden" name="tp1Form" value="tp1-2026" />
      {c2}
      <Tp1DeclarationTick defaultChecked={false} />
      <Tp1RemarksField defaultValue="" />
      <button type="submit" name="intent" value="submit" form="tp1-form">
        Submit
      </button>
    </Tp1EditableForm>
  );

  it('renders the refused message in a banner on THIS form, and keeps every keyed field', async () => {
    const action = vi.fn(async () => ({ error: REFUSAL }));
    render(wrap(editable(action)));

    // What the reader keyed before pressing Submit — the thing the old redirect threw away.
    key(amount('tp1_items_c2_amount'), '900');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Receipts attached.' } });

    fireEvent.submit(document.getElementById('tp1-form') as HTMLFormElement);
    await waitFor(() => expect(action).toHaveBeenCalled());
    // ⚠️ THE REPORTED FAULT. Before r352 the message was drawn on the TP1 Relief LIST, after a redirect
    // that unmounted this form and blanked all of it.
    await waitFor(() => expect(screen.getByText(REFUSAL)).toBeTruthy());

    // ⚠️ AND THE OTHER HALF: React resets an UNCONTROLLED field once a form action resolves, redirect or
    // no redirect. Every field the reader can type into is therefore a controlled island, and this is the
    // assertion that says so — it fails the moment one of them goes back to `defaultValue`.
    expect(amount('tp1_items_c2_amount').value, 'the keyed amount was blanked by the refusal').toBe('900');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked, 'the Section E tick was cleared').toBe(
      true,
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value, 'the remarks were cleared').toBe(
      'Receipts attached.',
    );
  });

  it('carries the pressed button’s intent to the action, so one form can save or submit', async () => {
    const seen: string[] = [];
    const action = vi.fn(async (_p: { error: string | null }, fd: FormData) => {
      seen.push(String(fd.get('intent')));
      return { error: REFUSAL };
    });
    render(wrap(editable(action)));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(seen, 'the submitter’s intent did not reach the action').toEqual(['submit']);
  });

  it('shows nothing until something is refused', () => {
    render(wrap(editable(vi.fn(async () => ({ error: null })))));
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });
});
