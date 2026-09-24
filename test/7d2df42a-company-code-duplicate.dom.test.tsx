/**
 * Item 7d2df42a — THE COMPANY CODE WARNING, TYPED INTO, IN ALL SIX CATALOGUES.
 *
 * ── WHAT THE REPORTER ASKED FOR, AND WHAT THEY APPROVED INSTEAD ───────────────────────────────────
 * They asked for a COMPULSORY Company Code and an ENFORCED unique rule. We recommended against both
 * and they approved that recommendation, so neither is built. Their own data is the argument, read off
 * production 2026-09-24: of 13 companies 7 hold no code at all, and of the 6 that hold something one
 * reads "PRIVATE CO." and one holds the entire legal name "ISEDECOR BINA SDN BHD". A compulsory field
 * would block those seven from being saved; an enforced unique rule would reject the two odd rows the
 * first time anybody touched any other field on their screen.
 *
 * What ships is a WARNING that NAMES the other company, so an accident looks different from an
 * intention. `They can still save` is not a footnote to that sentence — it is the thing most likely to
 * be lost by a later change, which is why `still saves` below submits the form with a duplicate typed
 * and asserts both that the browser did not refuse it and that the typed code is in the payload.
 *
 * ── WHY THIS IS A DOM TEST AND NOT A CURL OF THE PAGE ─────────────────────────────────────────────
 * The warning is INTERACTIVE: it does not exist in the server's first render, because at that moment
 * the field is empty (create) or holds this company's own stored code (edit), and neither warns. A GET
 * of /admin/organization/new or /admin/organization/<id> therefore cannot reach it at all, so the §8
 * render check covers those two screens' STATIC markup and this file covers the warning — once per
 * shipping catalogue, which is the part a 200 never proves.
 *
 * ⚠️ AND IT ASSERTS THE SIX CATALOGUES DIRECTLY, not through i18n/request.ts. That request config
 * deep-merges each locale over English, so a key missing from ms.json renders the ENGLISH sentence and
 * looks perfectly fine on screen. These blocks feed the raw catalogue, so a missing key is a hard
 * next-intl error (the provider's onError rethrows) and a key that merely exists but was never
 * translated is caught by comparing against that locale's own string.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { CompanyCodeField } from '../components/company-code-field';
import { companyCodeHolders } from '../lib/company-code';

/** The reporter's own example, and the sentence the approved plan showed them. */
const CHIN_HIN = 'Chin Hin Construction Engineering Sdn Bhd';
const ISEDECOR = 'ISEDECOR BINA SDN BHD';

/**
 * Rows exactly as `listCompanies` returns them, put through the SAME mapper both screens use. Feeding
 * the mapper rather than a hand-built holder list is the point: the archived rule lives in the mapper,
 * so a test that hand-built the list would pass with the rule deleted.
 */
const ROWS = [
  { id: 'chin-hin', name: CHIN_HIN, companyLabel: 'ASG', archivedAt: null },
  { id: 'isedecor', name: ISEDECOR, companyLabel: ISEDECOR, archivedAt: null },
  { id: 'codeless', name: 'Nameless Sdn Bhd', companyLabel: null, archivedAt: null },
  { id: 'blankish', name: 'Blankish Sdn Bhd', companyLabel: '   ', archivedAt: null },
  // Retired years ago, and it took 'OLD' with it. Recycling that code is normal, not a collision.
  { id: 'retired', name: 'Retired Holdings Bhd', companyLabel: 'OLD', archivedAt: new Date('2019-03-31') },
  // The company being EDITED on the General tab. Its own code is not a duplicate of itself.
  { id: 'self', name: 'Self Sdn Bhd', companyLabel: 'SELF', archivedAt: null },
];

type Catalogue = typeof en;

function renderField(
  { messages = en as Catalogue, locale = 'en', excludeId = null as string | null } = {},
) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      onError={(err) => {
        throw err;
      }}
    >
      <form>
        <CompanyCodeField codesInUse={companyCodeHolders(ROWS)} excludeId={excludeId} />
        <button type="submit">save</button>
      </form>
    </NextIntlClientProvider>,
  );
}

const codeInput = (): HTMLInputElement => document.querySelector('input[name="companyLabel"]')!;
const warning = (): HTMLElement | null => document.querySelector('[data-company-code-warning]');

describe('7d2df42a — typing a code somebody else uses says so, and names them', () => {
  it('names the other company, in the sentence the reporter approved', async () => {
    const user = userEvent.setup();
    renderField();
    expect(warning(), 'an empty field warns about nothing').toBeNull();

    await user.type(codeInput(), 'ASG');
    const w = warning();
    expect(w, 'typing a code another company holds raises the warning').not.toBeNull();
    expect(w!.textContent, 'and it NAMES that company — "already in use" alone is not the feature').toBe(
      `${CHIN_HIN} already uses this code.`,
    );
    expect(w!.getAttribute('data-company-code-warning'), 'and points at the right row').toBe('chin-hin');
    // The field is DESCRIBED by the warning, never marked invalid: aria-invalid would tell a screen
    // reader the entry is in error, which is the one thing this is not.
    expect(codeInput().getAttribute('aria-describedby')).toBe(w!.id);
    expect(codeInput().getAttribute('aria-invalid')).toBeNull();
  });

  it('a code nobody uses is silent, and so is clearing it again', async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(codeInput(), 'BRAND-NEW');
    expect(warning(), 'an unused code is not a warning').toBeNull();

    await user.clear(codeInput());
    await user.type(codeInput(), 'ASG');
    expect(warning()).not.toBeNull();
    await user.clear(codeInput());
    expect(warning(), 'and it goes away again when the code does — the code stays optional').toBeNull();
  });

  it('is blind to case and to whitespace, because ASG / asg / "ASG " are one code to a human', async () => {
    const user = userEvent.setup();
    for (const typed of ['asg', 'ASG ', ' aSg', 'Asg']) {
      const { unmount } = renderField();
      await user.type(codeInput(), typed);
      expect(warning()?.textContent, `${JSON.stringify(typed)} is the same code as ASG`).toBe(
        `${CHIN_HIN} already uses this code.`,
      );
      unmount();
    }
  });

  it('an ARCHIVED company does not collide — its code is free to reuse, and its name is never shipped', async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(codeInput(), 'OLD');
    expect(warning(), "a company retired in 2019 is not a collision worth a warning").toBeNull();
    expect(
      companyCodeHolders(ROWS).some((h) => h.name === 'Retired Holdings Bhd'),
      'and the archived company is not in the browser payload at all',
    ).toBe(false);
  });

  it('a whitespace-only stored code is not something to collide WITH either', async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(codeInput(), '   ');
    expect(warning(), 'blank never clashes — 7 of 13 production companies are in exactly that state').toBeNull();
  });

  it('the company being edited is not warned about its own stored code', async () => {
    const user = userEvent.setup();
    renderField({ excludeId: 'self' });
    await user.type(codeInput(), 'SELF');
    expect(warning(), 'or the General tab would warn about every coded company the moment it opened').toBeNull();
    // …but a code belonging to somebody ELSE still warns on that same screen.
    await user.clear(codeInput());
    await user.type(codeInput(), 'ASG');
    expect(warning()?.textContent).toBe(`${CHIN_HIN} already uses this code.`);
  });
});

describe('7d2df42a — it is a WARNING. It must not become a refusal by accident.', () => {
  it('still saves: the browser does not block the submit and the typed code is in the payload', async () => {
    const user = userEvent.setup();
    const { container } = renderField();
    await user.type(codeInput(), 'ASG');
    expect(warning(), 'precondition: we are looking at the warned state').not.toBeNull();

    const form = container.querySelector('form')!;
    expect(
      form.checkValidity(),
      'constraint validation still passes — a `required`, a `pattern` or a setCustomValidity here would ' +
        'make the browser REFUSE the submit, which is the failure mode this item exists to avoid',
    ).toBe(true);
    expect(codeInput().validationMessage, 'and no custom validity message was set').toBe('');
    expect(new FormData(form).get('companyLabel'), 'the duplicate is what gets posted, unchanged').toBe('ASG');
  });

  it('the input carries no required / pattern, and the Save button is never disabled by a duplicate', async () => {
    const user = userEvent.setup();
    renderField();
    const save = screen.getByRole('button', { name: 'save' });
    await user.type(codeInput(), 'ASG');
    expect(codeInput().hasAttribute('required'), 'the code stays OPTIONAL').toBe(false);
    expect(codeInput().hasAttribute('pattern')).toBe(false);
    expect((save as HTMLButtonElement).disabled, 'they can still save — that is the whole decision').toBe(false);
  });

  it('stores what was typed: the warning normalises for COMPARISON only, never for storage', async () => {
    const user = userEvent.setup();
    const { container } = renderField();
    await user.type(codeInput(), '  aSg  ');
    expect(warning(), 'compared case- and whitespace-insensitively').not.toBeNull();
    expect(
      new FormData(container.querySelector('form')!).get('companyLabel'),
      'but posted byte-for-byte as typed — core/admin.ts normNullableText owns the trim, and nothing here ' +
        'may quietly rewrite an operator’s value to a canonical form nobody asked for',
    ).toBe('  aSg  ');
  });
});

describe('7d2df42a — the warning resolves in all six shipping catalogues', () => {
  for (const [loc, messages] of [
    ['en', en],
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi],
    ['zh', zh],
  ] as const) {
    it(`${loc}: the company is named, nothing renders a raw key, and the string is this locale's own`, async () => {
      const user = userEvent.setup();
      const { unmount } = renderField({ messages: messages as Catalogue, locale: loc });
      await user.type(codeInput(), 'ASG');
      const text = warning()?.textContent ?? '';
      expect(text, `[${loc}] the warning rendered`).not.toBe('');
      expect(text, 'no MISSING_MESSAGE').not.toContain('MISSING_MESSAGE');
      expect(text, 'no unresolved key printed as itself').not.toContain('companyCodeDuplicate');
      expect(text, 'the ICU argument was substituted, not printed').not.toContain('{company}');
      expect(text, 'the other company is named in this locale too').toContain(CHIN_HIN);

      // THE PART THE DEEP-MERGE WOULD HIDE. i18n/request.ts merges each locale over English, so a key
      // absent from this catalogue would render the English sentence and read as a pass. Compare against
      // THIS catalogue's own entry, and require the five non-English ones to differ from English.
      const own = (messages as Catalogue).admin.organization.companyCodeDuplicate;
      expect(own, `[${loc}] admin.organization.companyCodeDuplicate exists in messages/${loc}.json`).toBeTruthy();
      expect(text).toBe(own.replace('{company}', CHIN_HIN));
      if (loc !== 'en') {
        expect(own, `[${loc}] is translated, not the English string copied over`).not.toBe(
          en.admin.organization.companyCodeDuplicate,
        );
      }

      // The placeholder on the input is the other string this field renders; a screen is not one key.
      expect(codeInput().placeholder).toBe((messages as Catalogue).admin.organization.companyCodeHint);
      unmount();
    });
  }
});
