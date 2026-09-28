/**
 * Item 15e5bd93 REVISION 2 (r353) — THE DEDICATED STATUTORY SCREEN, DRIVEN THROUGH REAL EVENTS.
 *
 * ⚠️ THIS FILE WAS `test/15e5bd93-statutory-workspace.dom.test.tsx` AND IT DROVE A SHAPE THE REPORTER
 * CONTESTED. r352 built a rail plus a workspace inside the Statutory tab with ONE Save; the contest asked
 * for "a dedicated full-width screen" whose cards are read-only until each one's own Edit is pressed, with
 * Save and Cancel on that card. So it mounts `StatutorySetupScreen` instead of `CompanyPanel`.
 *
 * WHAT THE OLD FILE GUARDED, AND WHERE EACH CLAIM WENT — none of the three is dropped:
 *
 *  (1) THE PACK FLAG. `filingCountry`, not `country`, because a hidden `country` beside a visible postal
 *      `country` was overwritten with "Malaysia" and posted into `packFor()`. The mechanism that did the
 *      overwriting (`syncCarriedValues`, which only runs inside a TabSaveScope) is not on this screen — so
 *      the SERVER half is where the claim now bites, and it is run against the real database in
 *      test/organization-statutory-card-save.test.ts ("a postal country of Malaysia does not poison the
 *      pack lookup"). §3 here keeps the DOM half: both names, distinct values, on one submitted form.
 *
 *  (2) THE SIGNATORY. `diffTab` skipped a hidden input it could not prove was user-facing, and
 *      `components/employee-search-field.tsx` posts its choice through one — so a signatory-only edit was
 *      silently discarded. This screen has no diff and no change summary, so that path no longer runs here.
 *      ⚠️ THE FIX IS NOT DELETED AND ITS COVERAGE IS NOT EITHER: `hiddenInputIsUserFacing` and
 *      `controlDisplay` are still what the PERSONNEL tab-save bar reads, and this file was their only test.
 *      §4 therefore tests them DIRECTLY against the searchable field's real rendered shape. Deleting the
 *      only exercise of a fix because the screen that found it moved is how a fix rots.
 *
 *  (3) "an edit to one body survives selecting another". REVERSED, on purpose, and §2 is the reversal.
 *      r352 kept all eight panes mounted because one Save read them all out of the DOM; with Save on each
 *      card there is no such reader, and a closed-but-mounted form would make Cancel a lie. So the claim
 *      becomes its opposite: Cancel DISCARDS, and while a card is open no other card can be opened to
 *      discard it by accident.
 *
 * ⚠️ IT MOUNTS THE REAL COMPONENT, not a stand-in shaped like it.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import { StatutorySetupScreen } from '../components/statutory-setup-screen';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import { controlDisplay, fieldLabel, hiddenInputIsUserFacing } from '../lib/tab-save-dom';
import { EmployeeSearchField } from '../components/employee-search-field';

const org = messages.admin.organization as Record<string, string>;
const noop = () => undefined;

const SAVED_EPF = {
  id: 'sa1',
  authority: 'epf',
  accountNo: 'ACC-1',
  bankProfileId: 'bp1',
  addressLine1: 'Level 8, Menara Demo',
  addressLine2: null,
  addressLine3: null,
  city: 'Kuala Lumpur',
  state: 'Selangor',
  postcode: '50000',
  // The postal country a body's card renders as a VISIBLE select — the value that used to be copied over
  // a hidden `country` on the registrations card when the flag was still called that.
  country: 'Malaysia',
  phone: '03-2712 3400',
  email: 'epf@example.test',
  signatoryPersonId: 'p1',
};

const BANK = {
  id: 'bp1',
  bank: 'maybank',
  corporateId: 'CORP',
  debitAccountNo: '512345678901',
  orgName: null,
  txnType: 'IBG',
  accountLabel: 'Payroll — Maybank',
  accountName: null,
  accountType: null,
  branch: null,
  swiftCode: null,
  currency: 'MYR',
  isPrimary: true,
};

function mount(over: Record<string, unknown> = {}) {
  const props = {
    companyId: 'c1',
    filingCountry: 'MY',
    statutory: {
      epfEmployerNo: 'E123',
      socsoEmployerCode: 'S123',
      lhdnEmployerNo: 'L123',
      myinvoisTin: null,
      ssmRegistrationNo: null,
      hrdfStatus: 'mandatory' as const,
    },
    statutoryAuthorities: [SAVED_EPF],
    bankProfiles: [BANK],
    signatories: [
      { personId: 'p1', name: 'Aminah binti Ali', employeeCode: 'EMP-0001' },
      { personId: 'p2', name: 'Bala a/l Muthu', employeeCode: 'EMP-0002' },
    ],
    stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
    actions: { setStatutoryAuthority: noop, removeStatutoryAuthority: noop },
    ...over,
  };
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
      <StatutorySetupScreen {...(props as Parameters<typeof StatutorySetupScreen>[0])} />
    </NextIntlClientProvider>,
  );
}

const cardOf = (authority: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-statutory-card="${authority}"]`);
  expect(el, `${authority} has a card`).not.toBeNull();
  return el!;
};
const editButton = (authority: string) => within(cardOf(authority)).getByRole('button', { name: org.authorityEdit });
const formIn = (authority: string) =>
  cardOf(authority).querySelector<HTMLFormElement>(`form[data-statutory-form="${authority}"]`);
const fieldIn = (authority: string, name: string): HTMLInputElement => {
  const el = cardOf(authority).querySelector<HTMLInputElement>(`[name="${name}"]`);
  expect(el, `${name} is in the ${authority} card`).not.toBeNull();
  return el!;
};
/** The view-mode values, read out of a card's <dd>s. */
const values = (authority: string) =>
  [...cardOf(authority).querySelectorAll('dd')].map((d) => (d.textContent ?? '').trim());

beforeEach(() => {
  document.body.innerHTML = '';
});

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 every body is a card, all visible at once, and every one of them starts READ-ONLY', () => {
  it('draws all eight bodies in the controlled set’s order, with no form open', () => {
    mount();
    expect(
      [...document.querySelectorAll('[data-statutory-card]')].map((c) => c.getAttribute('data-statutory-card')),
      'approved point 2: every SUPPORTED body, in the controlled set’s own order',
    ).toEqual([...STATUTORY_AUTHORITIES]);
    // Approved point 3: READ-ONLY on arrival. Not "hidden", not "disabled" — absent.
    expect(document.querySelectorAll('form'), 'no card is in edit mode yet').toHaveLength(0);
    expect(document.querySelectorAll('[data-statutory-mode="viewing"]')).toHaveLength(STATUTORY_AUTHORITIES.length);
    // …and every card offers its own Edit.
    expect(screen.getAllByRole('button', { name: org.authorityEdit })).toHaveLength(STATUTORY_AUTHORITIES.length);
  });

  /**
   * VIEW MODE SHOWS WHAT IS SAVED, AND THE CAPTIONS ARE WHAT MAKE IT READABLE (r226). The FILING number and
   * the PAYMENT reference are two different numbers; a card that showed one anonymous "employer number" is
   * the fault r226 was raised for. Asserted as an EXACT list of values, because a substring check would
   * pass on a card that rendered nothing at all.
   */
  it('a configured body states its filing number, its payment reference, its account, signatory and address', () => {
    mount();
    expect(values('epf')).toEqual([
      'E123', // the FILING number (company_statutory_my.epfEmployerNo), under epfEmployerNo's caption
      'ACC-1', // the PAYMENT reference (company_statutory_authority.accountNo)
      'Payroll — Maybank · 512345678901', // unmasked, deliberately: the company's own debit account
      'Aminah binti Ali', // the signatory as a PERSON, never as an id
      'Level 8, Menara Demo, Kuala Lumpur, 50000, Selangor, Malaysia',
      '03-2712 3400',
      'epf@example.test',
    ]);
    const epf = cardOf('epf');
    expect(epf.textContent, 'the filing caption').toContain(org.epfEmployerNo);
    expect(epf.textContent, 'and the payment caption, separately').toContain(org.authorityAccountNo);
    expect(epf.textContent, 'the body is Configured').toContain(org.authorityConfigured);
  });

  it('a body with nothing on file says so in words rather than showing blanks', () => {
    mount();
    // LHDN has no authority row but the company DOES carry its filing number, so this one card proves both
    // halves: the number that exists is shown, and the facts that do not are NAMED as not set.
    expect(values('lhdn')[0]).toBe('L123');
    expect(new Set(values('lhdn').slice(1)), 'every absent fact says Not set').toEqual(
      new Set([org.authorityValueNotSet]),
    );
    expect(cardOf('lhdn').textContent).toContain(org.authorityNotConfigured);
  });

  /**
   * EIS CARRIES NO FILING LINE AT ALL. It has no number of its own — it files under SOCSO's PERKESO
   * employer code — and inventing a caption for it would say something untrue. Six facts, not seven.
   */
  it('EIS shows no filing number, because it has none', () => {
    mount();
    expect(values('eis')).toHaveLength(6);
    expect(cardOf('eis').textContent, 'and no PERKESO code caption on its own card').not.toContain(
      org.socsoEmployerCode,
    );
  });

  /**
   * HRD CORP'S BAND IS THE ONE VIEW-MODE VALUE THAT COULD BE INVENTED. Payroll resolves a missing
   * `company_statutory_my` row to 'not_registered' and charges nothing — but printing "No Contribution" for
   * a company with no row at all would assert a registration decision nobody made (CLAUDE.md §8: an absent
   * box asserts nothing).
   */
  it('states HRD Corp’s band only when the identity row actually carries one', () => {
    mount();
    expect(values('hrdf')[0], 'a real decision on file is stated').toBe(org.hrdfMandatory);
    document.body.innerHTML = '';
    mount({ statutory: null, statutoryAuthorities: [], bankProfiles: [] });
    expect(values('hrdf')[0], 'an absent identity row is never read as a band').toBe(org.authorityValueNotSet);
    for (const band of [org.hrdfNotRegistered, org.hrdfMandatory, org.hrdfOptional]) {
      expect(cardOf('hrdf').textContent, `the card must not claim ${band}`).not.toContain(band);
    }
  });

  /**
   * APPROVED POINT 6 — SOCSO AND EIS STAY PAIRED, EIS INDENTED UNDER SOCSO, AND THEY ARE STILL TWO RECORDS.
   * Asserted on the rendered DOM rather than on classes alone: EIS's card is INSIDE the same grid cell as
   * SOCSO's, which is what makes "under SOCSO" true in a two-column grid rather than "under EPF".
   */
  it('EIS is indented inside SOCSO’s own cell, and keeps its own card', () => {
    mount();
    const socso = cardOf('socso');
    const eis = cardOf('eis');
    expect(socso.parentElement, 'one cell').toBe(eis.parentElement);
    expect(socso.compareDocumentPosition(eis) & Node.DOCUMENT_POSITION_FOLLOWING, 'EIS comes after SOCSO').toBeTruthy();
    expect(eis.className, 'and it is indented').toContain('ml-6');
    expect(socso.className, 'while its group head is not').not.toContain('ml-6');
    // Its own mark is NOT repeated: the group head above it already carries PERKESO's.
    expect(socso.querySelector('img'), 'SOCSO carries the mark').not.toBeNull();
    expect(eis.querySelector('img'), 'EIS does not carry a second copy of it').toBeNull();
  });

  /** The empty state the plan said to reuse rather than reinvent, for a company with no bank accounts. */
  it('warns when there is no bank account to route a statutory payment from', () => {
    mount({ bankProfiles: [] });
    expect(screen.getByText(org.authoritiesNoBankAccounts)).toBeTruthy();
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§2 Edit opens ONE card, Save and Cancel belong to it, and Cancel really discards', () => {
  it('Edit turns that one card into a form and leaves the other seven read-only', async () => {
    const u = userEvent.setup();
    mount();
    await u.click(editButton('socso'));
    expect(formIn('socso'), 'the card it was pressed on').not.toBeNull();
    expect(document.querySelectorAll('[data-statutory-form]'), 'and only that card').toHaveLength(1);
    expect(cardOf('socso').getAttribute('data-statutory-mode')).toBe('editing');
    expect(cardOf('socso').textContent).toContain(org.authorityEditing);
    for (const a of STATUTORY_AUTHORITIES.filter((x) => x !== 'socso')) {
      expect(cardOf(a).getAttribute('data-statutory-mode'), a).toBe('viewing');
    }
    // Every field the body posts is open at once — nothing inside the card expands.
    for (const name of ['socsoEmployerCode', 'accountNo', 'bankProfileId', 'addressLine1', 'city', 'postcode',
      'country', 'phone', 'email', 'signatoryPersonId']) {
      expect(fieldIn('socso', name), name).not.toBeNull();
    }
    expect(within(cardOf('socso')).getByRole('button', { name: org.authoritySave })).toBeTruthy();
    expect(within(cardOf('socso')).getByRole('button', { name: org.authorityCancel })).toBeTruthy();
  });

  /**
   * ONE CARD AT A TIME IS BOTH THE REQUIREMENT AND THE DATA GUARD. With the other Edit buttons live,
   * pressing one would unmount a dirty form and throw the typing away with no warning — the two-dirty-scopes
   * problem r352 recorded, in a new costume. They are DISABLED, and the screen says why.
   */
  it('while a card is open the other Edit buttons are refused, and the screen explains', async () => {
    const u = userEvent.setup();
    mount();
    expect(document.querySelector('[data-statutory-editing-hint]'), 'no hint before anything is open').toBeNull();
    await u.click(editButton('epf'));
    expect(screen.getByText(org.statutoryScreenEditingHint)).toBeTruthy();
    for (const a of STATUTORY_AUTHORITIES.filter((x) => x !== 'epf')) {
      expect(editButton(a).hasAttribute('disabled'), a).toBe(true);
    }
    // Pressing one changes nothing: EPF is still the open card.
    await u.click(editButton('ptptn')).catch(() => undefined);
    expect(formIn('epf'), 'EPF is still the open card').not.toBeNull();
    expect(formIn('ptptn')).toBeNull();
  });

  /**
   * ⚠️ CANCEL DISCARDS, AND THIS IS THE CASE THAT REVERSES r352 ON PURPOSE.
   *
   * That round asserted the opposite — a body's pane stayed MOUNTED and merely hidden, so an edit survived
   * switching bodies — and the reason it gave is why the reversal is right: "the tab's ONE Save reads every
   * body's fields out of the DOM". There is no such reader now. A form left mounted behind a Cancel would
   * hold the operator's typing and hand it back the next time Edit was pressed, which is a Cancel that
   * cancels nothing. The form is unmounted, so `defaultValue` is re-read on the next Edit.
   */
  it('Cancel unmounts the form and the saved value comes back on the next Edit', async () => {
    const u = userEvent.setup();
    mount();
    await u.click(editButton('epf'));
    await u.clear(fieldIn('epf', 'accountNo'));
    await u.type(fieldIn('epf', 'accountNo'), 'TYPED-BUT-NOT-SAVED');
    expect(fieldIn('epf', 'accountNo').value).toBe('TYPED-BUT-NOT-SAVED');

    await u.click(within(cardOf('epf')).getByRole('button', { name: org.authorityCancel }));
    expect(formIn('epf'), 'the form is gone, not hidden').toBeNull();
    expect(cardOf('epf').getAttribute('data-statutory-mode')).toBe('viewing');
    // The card is showing the SAVED value again, and the hint is gone with the open card.
    expect(values('epf')[1]).toBe('ACC-1');
    expect(document.querySelector('[data-statutory-editing-hint]')).toBeNull();

    // …and the other cards are editable again, which is asserted BEFORE re-opening EPF: with a card open
    // they are supposed to be disabled, so the same assertion one line later would pass for the wrong reason.
    expect(editButton('ptptn').hasAttribute('disabled'), 'nothing is open, so nothing is locked').toBe(false);

    await u.click(editButton('epf'));
    expect(fieldIn('epf', 'accountNo').value, 'the discarded typing did not come back').toBe('ACC-1');
  });

  /**
   * "Clear this authority" DELETES the body's row — bucket (b) of
   * docs/audits/65b22c00-organization-save-classification.md. It MOVED to this screen with the editor
   * rather than being dropped (this is the only place in the product that can clear a body's payment
   * setup), it is a form of its own outside the card's Save, and it appears only where there is a row.
   */
  it('Clear is its own form, only on a body that HAS a record', async () => {
    const u = userEvent.setup();
    mount();
    await u.click(editButton('epf'));
    const clear = cardOf('epf').querySelector<HTMLFormElement>('[data-statutory-clear="epf"]');
    expect(clear, 'EPF has a row, so it can be cleared').not.toBeNull();
    expect(clear!.contains(formIn('epf')!), 'and it is not inside the card Save').toBe(false);
    expect(within(clear!).getByRole('button', { name: org.authorityClear })).toBeTruthy();
    expect(clear!.querySelector('[name="id"]')!.getAttribute('value')).toBe('sa1');

    await u.click(within(cardOf('epf')).getByRole('button', { name: org.authorityCancel }));
    await u.click(editButton('ptptn'));
    expect(
      cardOf('ptptn').querySelector('[data-statutory-clear="ptptn"]'),
      'a body with no row has nothing to clear',
    ).toBeNull();
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 what one card’s form actually submits', () => {
  /**
   * DEFECT (1) OF THE OLD FILE, ITS DOM HALF. The pack flag must be `filingCountry` and must NOT be
   * `country`: `country` is the body's own visible postal address field on the same form, carrying a country
   * NAME from the ISO list. Both live here at once, with different values, which is the whole condition the
   * rename exists for. The server half — that the two do not get confused — is run against a real database
   * in test/organization-statutory-card-save.test.ts.
   */
  it('posts filingCountry=MY as a hidden flag, beside a visible postal country that is not it', async () => {
    const u = userEvent.setup();
    mount();
    await u.click(editButton('epf'));
    const form = formIn('epf')!;
    const flag = form.querySelector<HTMLInputElement>('input[name="filingCountry"]')!;
    expect(flag, 'the pack flag is on the form').not.toBeNull();
    expect(flag.type).toBe('hidden');
    expect(flag.value, 'an ISO code, which is what packFor() takes').toBe('MY');
    const postal = form.querySelector<HTMLSelectElement>('select[name="country"]')!;
    expect(postal, 'and the postal country is a VISIBLE select').not.toBeNull();
    expect(postal.value, 'holding a country NAME, which packFor() would reject').toBe('Malaysia');
    expect(flag.name).not.toBe(postal.name);
  });

  it('a body with no filing control posts no pack flag at all', async () => {
    const u = userEvent.setup();
    mount();
    await u.click(editButton('ptptn'));
    const form = formIn('ptptn')!;
    expect(form.querySelector('[name="filingCountry"]'), 'nothing to write towards the identity row').toBeNull();
    for (const n of ['epfEmployerNo', 'socsoEmployerCode', 'lhdnEmployerNo', 'hrdfStatus']) {
      expect(form.querySelector(`[name="${n}"]`), n).toBeNull();
    }
    // …and it still posts every payment field, so its own row is written whole.
    expect(form.querySelector('[name="accountNo"]')).not.toBeNull();
  });

  it('carries the company, the body and the return marker, so the save lands back on this screen', async () => {
    const u = userEvent.setup();
    mount();
    await u.click(editButton('zakat'));
    const form = formIn('zakat')!;
    const hidden = (n: string) => form.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value;
    expect(hidden('companyId')).toBe('c1');
    expect(hidden('authority'), 'the body this card writes').toBe('zakat');
    // app/admin/actions.ts `fromStatutorySetupScreen` compares against this exact literal.
    expect(hidden('returnTo')).toBe('statutory-setup');
  });

  it('HRD Corp posts its registration BAND, under a Registration heading and not a filing one', async () => {
    const u = userEvent.setup();
    mount();
    await u.click(editButton('hrdf'));
    const card = cardOf('hrdf');
    const band = card.querySelector<HTMLSelectElement>('select[name="hrdfStatus"]')!;
    expect(band, 'the band select').not.toBeNull();
    expect(band.value, 'pre-selected from what is on file').toBe('mandatory');
    expect(card.textContent).toContain(org.authorityRegistrationSection);
    expect(card.textContent, 'never captioned as a filed-form number').not.toContain(org.authorityFilingSection);
  });

  it('EIS says out loud that it files under SOCSO’s code, instead of showing an empty box', async () => {
    const u = userEvent.setup();
    mount();
    await u.click(editButton('eis'));
    expect(cardOf('eis').textContent).toContain(org.authorityEisSharesSocso);
    expect(formIn('eis')!.querySelector('[name="socsoEmployerCode"]'), 'no second control over one column').toBeNull();
  });

  /**
   * A DEPARTED SIGNATORY STAYS POSTED. `EmployeeSearchField` drops a value that is not in its own option
   * list, which would have turned "edit the phone number" into "clear the authorised signatory" — so the
   * stored person is injected as an option and the hidden input keeps posting their id.
   */
  it('keeps a signatory who has since LEFT selectable rather than silently clearing them', async () => {
    const u = userEvent.setup();
    mount({ signatories: [{ personId: 'p2', name: 'Bala a/l Muthu', employeeCode: 'EMP-0002' }] });
    await u.click(editButton('epf'));
    // THE HALF THAT SAVES THE DATA: the hidden input still POSTS the stored id, so editing the phone number
    // cannot clear the authorised signatory.
    expect(fieldIn('epf', 'signatoryPersonId').value, 'still on record').toBe('p1');
    /**
     * AND THE HALF THAT TELLS THE OPERATOR. The searchable field shows its selection as the VALUE of its
     * `[role="combobox"]` input, not as text — so this is read off that input. A `textContent` check would
     * have looked right and passed on a field showing an empty box beside a hidden id, which is precisely
     * the state that reads as "nobody is appointed".
     */
    const combo = cardOf('epf').querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(combo.value, 'named as kept on record, not shown blank').toContain(org.authoritySignatoryFormer);
  });

  it('a signatory pick reaches the hidden input the form submits', async () => {
    const u = userEvent.setup();
    mount({ statutoryAuthorities: [{ ...SAVED_EPF, signatoryPersonId: null }] });
    await u.click(editButton('epf'));
    const combo = cardOf('epf').querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await u.type(combo, 'Bala');
    await u.click(await within(cardOf('epf')).findByText(/Bala a\/l Muthu/));
    expect(fieldIn('epf', 'signatoryPersonId').value).toBe('p2');
  });
});

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * DEFECT (2) OF THE OLD FILE, KEPT ALIVE DELIBERATELY.
 *
 * r352 found that `lib/tab-save-dom.ts` `diffTab` SKIPPED the searchable field's hidden input because it
 * could not prove it was user-facing, so a signatory-only edit left the bar reading "No unsaved changes",
 * Save disabled, and the admin's pick thrown away on the next navigation — silently. The fix was two
 * functions recognising the searchable-field SHAPE (`input[role="combobox"]` beside the hidden input) plus
 * `fieldLabel` on the component.
 *
 * THIS SCREEN NO LONGER USES A TabSaveScope, so `diffTab` is not on its path. The fix still matters: the
 * PERSONNEL tab-save bar reads the same two functions, and this file was their only exercise. Deleting it
 * because the screen that found the defect moved is how a fix rots into untested code. So the functions are
 * tested directly, against the component's REAL rendered markup rather than a hand-built div — the whole
 * point of the original case was that the shape and the walker have to agree.
 */
describe('§4 the searchable field is still legible to the tab-save walker (carried forward from r352)', () => {
  function mountField(fieldLabelProp?: string) {
    return render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
        <EmployeeSearchField
          id="sig"
          name="signatoryPersonId"
          fieldLabel={fieldLabelProp}
          employees={[{ value: 'p1', name: 'Aminah binti Ali', employeeCode: 'EMP-0001' }]}
          value="p1"
          labels={{
            placeholder: org.signatorySearchPlaceholder,
            ariaLabel: org.signatorySearchLabel,
            resultsLabel: org.signatorySearchResults,
            noMatches: org.signatoryNoMatches,
            clear: org.signatoryClear,
          }}
        />
      </NextIntlClientProvider>,
    );
  }
  const hidden = () => document.querySelector<HTMLInputElement>('input[name="signatoryPersonId"]')!;

  it('its hidden input counts as USER-FACING, so a signatory-only edit is never skipped', () => {
    mountField(org.authoritySignatory);
    expect(hidden().type, 'the value travels in a hidden input').toBe('hidden');
    expect(hiddenInputIsUserFacing(hidden()), 'the walker must not treat it as plumbing').toBe(true);
  });

  /**
   * RECOGNISING THE SHAPE, NOT ONLY THE OPT-IN MARKER, is what makes a forgotten `fieldLabel` prop cost a
   * poor caption instead of a LOST EDIT — which is exactly the difference between an annoyance and the
   * defect r352 fixed. Asserted by rendering the component WITHOUT the prop.
   */
  it('recognises the shape even when the fieldLabel prop was forgotten', () => {
    mountField(undefined);
    expect(hidden().getAttribute('data-field-label'), 'no opt-in marker').toBeFalsy();
    expect(hiddenInputIsUserFacing(hidden()), 'and it is still visible to the walker').toBe(true);
    expect(fieldLabel(hidden()), 'falling back to a humanised column name, not to silence').toBe(
      'Signatory Person Id',
    );
  });

  it('shows the PERSON in a change summary, never their id', () => {
    mountField(org.authoritySignatory);
    expect(controlDisplay(hidden()), 'read off the visible combobox beside it').toContain('Aminah binti Ali');
    expect(controlDisplay(hidden()), 'the id is never shown').not.toContain('p1');
    expect(fieldLabel(hidden()), 'captioned by the field, not by its column name').toBe(org.authoritySignatory);
  });
});
