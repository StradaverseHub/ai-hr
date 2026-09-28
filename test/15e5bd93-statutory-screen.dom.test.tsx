/**
 * Item 15e5bd93 REVISION 3 (r355) — THE STATUTORY SETUP, DRIVEN THROUGH REAL EVENTS, ON BOTH ITS SCREENS.
 *
 * ⚠️ THIS FILE HAS NOW BEEN RE-POINTED TWICE AND BOTH PREVIOUS SUBJECTS WERE CONTESTED BY THE REPORTER.
 * It was `test/15e5bd93-statutory-workspace.dom.test.tsx` (r352: a rail plus a workspace inside the
 * Statutory tab, one Save). r353 re-pointed it at a dedicated screen of eight always-visible cards, each
 * read-only until its own Edit was pressed, with `editing` held as client state. The reporter contested that
 * too and drew the layout themselves: a TABLE of one row per body, and "Selecting Edit → EPF opens a screen
 * containing ONLY the EPF fields, with Cancel / Save."
 *
 * So it now mounts TWO components, which is the shape of the thing being tested:
 *   · `StatutorySetupScreen` — the list. Identity card on top, four columns, no field and no form.
 *   · `StatutoryBodyScreen`  — one body, in `view` or `edit`, which the ROUTE decides from `?mode=`.
 *
 * ── EVERY r353 CLAIM, AND WHAT BECAME OF IT ───────────────────────────────────────────────────────
 *
 *  (1) "draws all eight bodies in the controlled set's order, with no form open" — KEPT, TIGHTENED. The
 *      exact set and the exact order still hold, on rows now instead of cards, and "no form open" became
 *      "no form AT ALL on this screen", which is stronger: r353's list could grow a form by pressing Edit.
 *
 *  (2) "Edit turns that one card into a form and leaves the other seven read-only" — REPLACED by §2/§3.
 *      There are no other seven on the screen to leave alone; Edit is a LINK to a route that shows one body.
 *
 *  (3) "while a card is open the other Edit buttons are refused, and the screen explains" — REVERSED, and
 *      the r353 reason is why it can be. That lock existed so pressing another card's Edit could not unmount
 *      a dirty form and discard typing silently. One body per route means there is no second form to
 *      discard, so the lock, the `locked` prop and `statutoryScreenEditingHint` are all gone — and §1
 *      asserts that no Edit affordance on the list is ever disabled, which is the reversal made explicit.
 *
 *  (4) "Cancel unmounts the form and the saved value comes back on the next Edit" — KEPT IN SUBSTANCE,
 *      SIMPLER MECHANISM. Cancel is a LINK to the list, so leaving the route is the discard and there is no
 *      mounted form left holding anything. §2 asserts it is an `<a>` to the list and not a submit button,
 *      because a `<button>` inside that form would SUBMIT it — a Cancel that saves.
 *
 *  (5) THE PACK FLAG. `filingCountry`, not `country`, because a hidden `country` beside a visible postal
 *      `country` was overwritten with "Malaysia" and posted into `packFor()`. §3 keeps the DOM half: both
 *      names, distinct values, on one submitted form. The server half runs against a real database in
 *      test/organization-statutory-card-save.test.ts.
 *
 *  (6) THE SIGNATORY, AND THE FIX r353 FOUND HAD BEEN MISJUSTIFIED. `diffTab` skipped a hidden input it
 *      could not prove was user-facing, so a signatory-only edit was silently discarded. r353 established
 *      that the dom file it replaced was the ONLY test in the repo exercising `hiddenInputIsUserFacing` and
 *      `controlDisplay` — the earlier claim that "the personnel guards depend on it" was FALSE. §4 is
 *      therefore carried forward UNTOUCHED: it is the only coverage those two functions have.
 *
 * ⚠️ IT MOUNTS THE REAL COMPONENTS, not stand-ins shaped like them.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import { StatutorySetupScreen } from '../components/statutory-setup-screen';
import { StatutoryBodyScreen } from '../components/statutory-body-screen';
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
  // The postal country a body's editor renders as a VISIBLE select — the value that used to be copied over
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

const IDENTITY = {
  epfEmployerNo: 'E123',
  socsoEmployerCode: 'S123',
  lhdnEmployerNo: 'L123',
  myinvoisTin: 'C12345678900',
  ssmRegistrationNo: '202301001234',
  hrdfStatus: 'mandatory' as const,
};

const SIGNATORIES = [
  { personId: 'p1', name: 'Aminah binti Ali', employeeCode: 'EMP-0001' },
  { personId: 'p2', name: 'Bala a/l Muthu', employeeCode: 'EMP-0002' },
];

const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
      {node}
    </NextIntlClientProvider>,
  );

/** THE LIST. The props it takes are exactly the props it needs: no actions, no signatories, no states. */
function mountList(over: Record<string, unknown> = {}) {
  const props = {
    companyId: 'c1',
    filingCountry: 'MY',
    statutory: IDENTITY,
    statutoryAuthorities: [SAVED_EPF],
    bankProfiles: [BANK],
    ...over,
  };
  return wrap(<StatutorySetupScreen {...(props as Parameters<typeof StatutorySetupScreen>[0])} />);
}

/** ONE BODY, in the mode the ROUTE resolved. */
function mountBody(mode: 'view' | 'edit', authority = 'epf', over: Record<string, unknown> = {}) {
  const rows = (over.statutoryAuthorities as typeof SAVED_EPF[] | undefined) ?? [SAVED_EPF];
  const props = {
    mode,
    authority,
    companyId: 'c1',
    filingCountry: 'MY',
    statutory: IDENTITY,
    row: rows.find((r) => r.authority === authority) ?? null,
    bankProfiles: [BANK],
    signatories: SIGNATORIES,
    stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
    actions: { setStatutoryAuthority: noop, removeStatutoryAuthority: noop },
    ...over,
  };
  return wrap(<StatutoryBodyScreen {...(props as Parameters<typeof StatutoryBodyScreen>[0])} />);
}

const rowOf = (authority: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-statutory-row="${authority}"]`);
  expect(el, `${authority} has a row`).not.toBeNull();
  return el!;
};
const linkIn = (authority: string, kind: 'view' | 'edit') => {
  const el = rowOf(authority).querySelector<HTMLAnchorElement>(`[data-statutory-${kind}-link="${authority}"]`);
  expect(el, `${authority} offers ${kind}`).not.toBeNull();
  return el!;
};
const bodyForm = () => document.querySelector<HTMLFormElement>('form[data-statutory-form]');
const fieldNamed = (name: string): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
  expect(el, `${name} is on the screen`).not.toBeNull();
  return el!;
};
/** The view-mode values, read out of the `<dl>`'s `<dd>`s. */
const values = () => [...document.querySelectorAll('dd')].map((d) => (d.textContent ?? '').trim());

beforeEach(() => {
  document.body.innerHTML = '';
});

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 the list is the reporter’s table: identity on top, one row per body, no fields', () => {
  it('draws all eight bodies in the controlled set’s order, as table rows', () => {
    mountList();
    expect(
      [...document.querySelectorAll('[data-statutory-row]')].map((r) => r.getAttribute('data-statutory-row')),
      'every SUPPORTED body, in the controlled set’s own order, nothing filtered and nothing sliced',
    ).toEqual([...STATUTORY_AUTHORITIES]);
    // Rows of a real table, not divs dressed as one: the four column headers are <th>s.
    const heads = [...document.querySelectorAll('th')].map((h) => (h.textContent ?? '').trim());
    expect(heads, 'the reporter’s four columns, in their order').toEqual([
      org.statutoryColBody,
      org.statutoryColPaymentSetup,
      org.statutoryColStatus,
      org.statutoryColAction,
    ]);
  });

  /**
   * ⚠️ THE CLAIM THIS ITEM WAS CONTESTED TWICE OVER. r352 put the fields in the tab; r353 put them behind
   * eight Edit buttons on this screen. The approved plan for revision 3: "The eight bodies below become a
   * plain table: Statutory, Payment Setup, Status, Action. One line each. No fields, no forms, nothing
   * expanded." ABSENT, not hidden and not disabled.
   */
  it('holds no field, no form and nothing that can expand', () => {
    mountList();
    expect(document.querySelectorAll('form'), 'the list cannot write').toHaveLength(0);
    expect(document.querySelectorAll('input'), 'and holds no box at all').toHaveLength(0);
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
    expect(document.querySelectorAll('details'), 'nothing folds').toHaveLength(0);
    expect(document.querySelectorAll('[aria-expanded]')).toHaveLength(0);
  });

  /**
   * ⚠️ REVERSES r353's "while a card is open the other Edit buttons are refused". That round DISABLED the
   * other seven Edit buttons because pressing one would unmount a dirty form and discard typing with no
   * warning. Edit is a LINK to another route now, there is no form on this screen to discard, and so there
   * is nothing to lock: every row's View and Edit are live, always, and the hint that explained the lock is
   * gone from the screen (its catalogue entry is kept — see the layout guard).
   */
  it('every row offers a live View and a live Edit, and nothing is ever disabled or explained away', () => {
    mountList();
    for (const a of STATUTORY_AUTHORITIES) {
      for (const kind of ['view', 'edit'] as const) {
        const link = linkIn(a, kind);
        expect(link.tagName, `${a} ${kind} is a link, not a button`).toBe('A');
        expect(link.getAttribute('href'), `${a} ${kind} address`).toBe(`/admin/organization/c1/statutory/${a}?mode=${kind}`);
        expect(link.hasAttribute('disabled'), `${a} ${kind} is not refused`).toBe(false);
      }
    }
    expect(document.querySelectorAll('button'), 'no control on this screen does anything in place').toHaveLength(0);
    expect(document.body.textContent, 'and no advice about a lock that no longer exists').not.toContain(
      org.statutoryScreenEditingHint,
    );
  });

  /**
   * ⚠️ THE TWO STATUS COLUMNS ARE TWO FACTS, AND THE PLAN PROMISED THE REPORTER THAT PRECISELY.
   *
   *     Payment Setup = a company_statutory_authority row exists
   *     Status        = it is actually contributing
   *
   * EPF has a row; HRD Corp does NOT, and the identity row says `hrdfStatus: 'mandatory'` — so HRD Corp is
   * the case where the two columns DISAGREE in the other direction from the plan's headline example, and it
   * is asserted here because a column derived from the wrong fact would look identical on EPF.
   */
  it('reads Payment Setup off the record and Status off what is actually contributing', () => {
    mountList();
    const cell = (a: string, what: 'payment-setup' | 'status') =>
      (rowOf(a).querySelector(`[data-statutory-${what}]`)?.textContent ?? '').trim();

    // EPF: a row exists, so both columns agree.
    expect(cell('epf', 'payment-setup')).toBe(org.authorityConfigured);
    expect(cell('epf', 'status')).toBe(org.authorityStatusActive);
    // The other six non-HRDF bodies have no row, so both columns agree the other way.
    for (const a of STATUTORY_AUTHORITIES.filter((x) => x !== 'epf' && x !== 'hrdf')) {
      expect(cell(a, 'payment-setup'), a).toBe(org.authorityNotConfigured);
      expect(cell(a, 'status'), a).toBe(org.authorityStatusInactive);
    }
    // HRD CORP: no payment record, but a registration band that means payroll charges the levy. The two
    // columns differ, and neither one is an echo of the other.
    expect(cell('hrdf', 'payment-setup'), 'no payment record').toBe(org.authorityNotConfigured);
    expect(cell('hrdf', 'status'), 'yet the levy IS charged (hrdf_status = mandatory)').toBe(
      org.authorityStatusActive,
    );
  });

  /**
   * THE OTHER HALF OF THE HRD CORP CASE, AND THE ONE THE PLAN NAMED TO THE REPORTER IN SO MANY WORDS: "a
   * company can have the payment details filled in and still be set to no contribution, and that row will
   * read Configured and Inactive".
   */
  it('HRD Corp can read Configured and Inactive at the same time, which is a real state', () => {
    mountList({
      statutoryAuthorities: [{ ...SAVED_EPF, id: 'sa9', authority: 'hrdf' }],
      statutory: { ...IDENTITY, hrdfStatus: 'not_registered' as const },
    });
    const row = rowOf('hrdf');
    expect(row.querySelector('[data-statutory-payment-setup]')!.textContent!.trim()).toBe(org.authorityConfigured);
    expect(row.querySelector('[data-statutory-status]')!.textContent!.trim()).toBe(org.authorityStatusInactive);
  });

  /**
   * ⚠️ NO ENABLE/DISABLE SWITCH WAS INVENTED. The Status column reads facts the schema already holds; there
   * is no per-body on/off control in `company_statutory_authority` and the build did not add one to make the
   * second column more interesting than the data (CLAUDE.md §8).
   */
  it('offers no control that could switch a body on or off, because no such fact exists', () => {
    mountList();
    for (const label of [org.authorityStatusActive, org.authorityStatusInactive]) {
      for (const el of screen.queryAllByText(label)) {
        expect(el.closest('button'), `${label} is a statement, not a switch`).toBeNull();
        expect(el.closest('a'), `${label} is not a link either`).toBeNull();
      }
    }
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0);
  });

  /**
   * ⚠️ SOCSO AND EIS STAY TWO ROWS, EIS INDENTED UNDER SOCSO — the reporter's sketch, and efe424b0's
   * measured reason: their payment accounts genuinely differ on this tenant (one company pays SMSB_EIS and
   * SMSB_SOCSO), so merging them would leave EIS's account on file with no screen able to edit it.
   *
   * In a TABLE this needs no grid trick: `STATUTORY_AUTHORITIES` already orders EIS immediately after SOCSO,
   * so the row order carries the relationship and the indent shows it. (r353 needed `.filter()` plus a
   * re-draw inside SOCSO's grid cell, because in two columns the third card lands under the FIRST.)
   */
  it('puts EIS immediately after SOCSO, indented, and keeps it its own row with its own screen', () => {
    mountList();
    const rows = [...document.querySelectorAll('[data-statutory-row]')].map((r) =>
      r.getAttribute('data-statutory-row'),
    );
    expect(rows[rows.indexOf('socso') + 1], 'the very next row').toBe('eis');
    expect(rowOf('eis').querySelector('td')!.innerHTML, 'indented').toContain('pl-6');
    expect(rowOf('socso').querySelector('td')!.innerHTML, 'while its group head is not').not.toContain('pl-6');
    // Its own record and its own screen: the two links name EIS, not SOCSO.
    expect(linkIn('eis', 'edit').getAttribute('href')).toContain('/statutory/eis?');
  });

  /**
   * THE IDENTITY CARD, AT THE TOP, READ-ONLY — approved point 1 of revision 3. Six facts: SSM, MyInvois, and
   * the four filing identifiers the reporter listed. Asserted as an EXACT ordered list of captions, because a
   * substring check would pass on a card that rendered two of them.
   */
  it('prints the statutory identity at the top, with the four filing identifiers and no input', () => {
    mountList();
    const card = document.querySelector<HTMLElement>('[data-statutory-identity]');
    expect(card, 'the identity card is on the screen').not.toBeNull();
    expect(
      [...card!.querySelectorAll('dt')].map((d) => (d.textContent ?? '').trim()),
      'the reporter’s own list, in their order',
    ).toEqual([
      org.ssmRegistrationNo,
      org.myinvoisTin,
      org.epfEmployerNo,
      org.socsoEmployerCode,
      org.lhdnENumber,
      org.hrdfStatusLabel,
    ]);
    expect(
      [...card!.querySelectorAll('dd')].map((d) => (d.textContent ?? '').trim()),
      'and what is on file for each',
    ).toEqual(['202301001234', 'C12345678900', 'E123', 'S123', 'L123', org.hrdfMandatory]);
    /**
     * ⚠️ READ-ONLY HERE AND EDITABLE PER BODY — the decision this round had to make and state. These four
     * live on `company_statutory_my` and are edited inside each body's editor through MY_FILING_FIELD (r226).
     * Two editable copies would be two doors onto one column and whichever was saved second would win.
     */
    expect(card!.querySelectorAll('input, select, textarea'), 'the card holds no writer').toHaveLength(0);
    // It is ABOVE the table, which is the whole of "identity moves to the top".
    const table = document.querySelector('table')!;
    expect(card!.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING, 'card first').toBeTruthy();
  });

  it('names what is not set on the identity card instead of rendering an empty gap', () => {
    mountList({ statutory: null });
    const card = document.querySelector<HTMLElement>('[data-statutory-identity]')!;
    expect(
      new Set([...card.querySelectorAll('dd')].map((d) => (d.textContent ?? '').trim())),
      'every absent fact says so in words, including HRD Corp’s band',
    ).toEqual(new Set([org.authorityValueNotSet]));
    for (const band of [org.hrdfNotRegistered, org.hrdfMandatory, org.hrdfOptional]) {
      expect(card.textContent, `an absent identity row is never read as ${band}`).not.toContain(band);
    }
  });

  /** The empty state the plan said to reuse rather than reinvent, for a company with no bank accounts. */
  it('warns when there is no bank account to route a statutory payment from', () => {
    mountList({ bankProfiles: [] });
    expect(screen.getByText(org.authoritiesNoBankAccounts)).toBeTruthy();
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§2 one body, one screen: View is read-only, Edit has Cancel and Save', () => {
  /**
   * VIEW IS THE SAME SCREEN, READ-ONLY, WITH NO SAVE — the reporter's words. "READ-ONLY" means ABSENT, not
   * disabled: a greyed-out input reads as something you can fix where you are standing.
   */
  it('view mode shows what is on file as text, with no form and no Save', () => {
    mountBody('view');
    expect(bodyForm(), 'no form in view mode').toBeNull();
    expect(document.querySelectorAll('input'), 'and no box').toHaveLength(0);
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(document.querySelector('[data-statutory-mode]')!.getAttribute('data-statutory-mode')).toBe('viewing');
    expect(screen.queryByRole('button', { name: org.authoritySave }), 'no Save in view mode').toBeNull();
    // r226 — the FILING number and the PAYMENT reference under separate captions, as an EXACT list, because
    // a substring check would pass on a `<dl>` that rendered nothing at all.
    expect(values()).toEqual([
      'E123', // the FILING number (company_statutory_my.epfEmployerNo)
      'ACC-1', // the PAYMENT reference (company_statutory_authority.accountNo)
      'Payroll — Maybank · 512345678901', // unmasked, deliberately: the company's OWN debit account
      'Aminah binti Ali', // the signatory as a PERSON, never as an id
      'Level 8, Menara Demo, Kuala Lumpur, 50000, Selangor, Malaysia',
      '03-2712 3400',
      'epf@example.test',
    ]);
    expect(document.body.textContent).toContain(org.epfEmployerNo);
    expect(document.body.textContent).toContain(org.authorityAccountNo);
  });

  /**
   * VIEW IS NOT A DEAD END. The sketch draws only the list and the edit screen; a read-only page whose only
   * exit is the browser's Back button is a screen you escape rather than use. A LINK to the same route in the
   * other mode — never a button, because nothing here toggles client state.
   */
  it('view mode offers Edit as a link into the same route’s edit mode', () => {
    mountBody('view', 'socso');
    const edit = document.querySelector<HTMLAnchorElement>('[data-statutory-edit-link]')!;
    expect(edit, 'an Edit affordance').not.toBeNull();
    expect(edit.tagName).toBe('A');
    expect(edit.getAttribute('href')).toBe('/admin/organization/c1/statutory/socso?mode=edit');
    expect(edit.textContent).toContain(org.authorityEdit);
  });

  it('edit mode is one form for one body, with every field that body posts already open', () => {
    mountBody('edit', 'socso');
    const form = bodyForm();
    expect(form, 'the body’s form').not.toBeNull();
    expect(document.querySelectorAll('[data-statutory-form]'), 'exactly one').toHaveLength(1);
    expect(form!.getAttribute('data-statutory-form'), 'and it is THIS body').toBe('socso');
    expect(document.querySelector('[data-statutory-mode]')!.getAttribute('data-statutory-mode')).toBe('editing');
    // Nothing inside expands: every posted name is mounted at once.
    for (const name of ['socsoEmployerCode', 'accountNo', 'bankProfileId', 'addressLine1', 'addressLine2',
      'addressLine3', 'city', 'state', 'postcode', 'country', 'phone', 'email', 'signatoryPersonId']) {
      expect(fieldNamed(name), name).not.toBeNull();
    }
    // "Editing EPF shows EPF and nothing else" — no other body's card, row or form is anywhere on the page.
    expect(document.querySelectorAll('[data-statutory-row]'), 'no list on the edit screen').toHaveLength(0);
    expect(
      [...document.querySelectorAll('[data-statutory-card]')].map((c) => c.getAttribute('data-statutory-card')),
      'exactly one body on screen',
    ).toEqual(['socso']);
  });

  /**
   * ⚠️ CANCEL IS A LINK, AND IT HAS TO BE. r353's Cancel was an `onClick` that set `editing` to null and
   * unmounted the form. There is no client state to reset here — leaving the route IS the discard — and a
   * `<button>` placed where this sits would SUBMIT the form it is inside, which is a Cancel that saves. So:
   * an `<a>` to the list, asserted as such rather than by its caption.
   */
  it('Cancel is a link back to the list, never a button inside the form it would submit', () => {
    mountBody('edit');
    const cancel = document.querySelector<HTMLAnchorElement>('[data-statutory-cancel-link]')!;
    expect(cancel, 'Cancel is on the screen').not.toBeNull();
    expect(cancel.tagName, 'and it is a link').toBe('A');
    expect(cancel.getAttribute('href'), 'back to the list, which is where Cancel returns you').toBe(
      '/admin/organization/c1/statutory',
    );
    expect(cancel.textContent).toContain(org.authorityCancel);
    expect(cancel.closest('form'), 'it may sit in the form only because it is not a submitter').toBe(bodyForm());
    expect(cancel.getAttribute('type'), 'and it has no submit behaviour at all').toBeNull();
    // Save is the one submitter.
    const save = within(bodyForm()!).getByRole('button', { name: org.authoritySave });
    expect(save.getAttribute('type')).toBe('submit');
  });

  /**
   * "Clear this authority" DELETES the body's row — bucket (b) of
   * docs/audits/65b22c00-organization-save-classification.md. It is a form of its own outside the Save, it
   * appears only where there IS a row, and it is the only place in the product that can clear a body's
   * payment setup, so it moved with the editor rather than being dropped.
   */
  it('Clear is its own form, only on a body that HAS a record, and it names the body it can return to', () => {
    mountBody('edit');
    const clear = document.querySelector<HTMLFormElement>('[data-statutory-clear="epf"]');
    expect(clear, 'EPF has a row, so it can be cleared').not.toBeNull();
    expect(clear!.contains(bodyForm()!), 'and it is not inside the card Save').toBe(false);
    expect(within(clear!).getByRole('button', { name: org.authorityClear })).toBeTruthy();
    expect(clear!.querySelector('[name="id"]')!.getAttribute('value')).toBe('sa1');
    // `authority` rides along so a REFUSED Clear can be returned to this screen; the delete itself is keyed
    // off the row id (app/admin/actions.ts).
    expect(clear!.querySelector('[name="authority"]')!.getAttribute('value')).toBe('epf');
    expect(clear!.querySelector('[name="returnTo"]')!.getAttribute('value')).toBe('statutory-setup');

    document.body.innerHTML = '';
    mountBody('edit', 'ptptn');
    expect(
      document.querySelector('[data-statutory-clear="ptptn"]'),
      'a body with no row has nothing to clear',
    ).toBeNull();
  });

  /**
   * A BODY WITH NOTHING ON FILE SAYS SO IN WORDS RATHER THAN SHOWING BLANKS. LHDN proves both halves at
   * once: it has no authority row, but the company DOES carry its filing number.
   */
  it('a body with nothing on file names each absent fact', () => {
    mountBody('view', 'lhdn');
    expect(values()[0], 'the filing number the company does have').toBe('L123');
    expect(new Set(values().slice(1)), 'and every absent fact says Not set').toEqual(
      new Set([org.authorityValueNotSet]),
    );
    expect(document.body.textContent).toContain(org.authorityNotConfigured);
  });

  /** EIS carries no filing line at all: it has none of its own. Six facts, not seven. */
  it('EIS shows no filing number, because it has none', () => {
    mountBody('view', 'eis');
    expect(values()).toHaveLength(6);
    expect(document.body.textContent, 'and no PERKESO code caption on its own screen').not.toContain(
      org.socsoEmployerCode,
    );
  });

  /**
   * HRD CORP'S BAND IS THE ONE VIEW-MODE VALUE THAT COULD BE INVENTED. Payroll resolves a missing
   * `company_statutory_my` row to 'not_registered' and charges nothing — but printing "No Contribution" for a
   * company with no row at all would assert a registration decision nobody made (§8).
   */
  it('states HRD Corp’s band only when the identity row actually carries one', () => {
    mountBody('view', 'hrdf');
    expect(values()[0], 'a real decision on file is stated').toBe(org.hrdfMandatory);
    document.body.innerHTML = '';
    mountBody('view', 'hrdf', { statutory: null, statutoryAuthorities: [] });
    expect(values()[0], 'an absent identity row is never read as a band').toBe(org.authorityValueNotSet);
    for (const band of [org.hrdfNotRegistered, org.hrdfMandatory, org.hrdfOptional]) {
      expect(document.body.textContent, `the screen must not claim ${band}`).not.toContain(band);
    }
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 what the one body’s form actually submits', () => {
  /**
   * CARRIED FORWARD FROM r352, THROUGH r353, UNCHANGED IN SUBSTANCE: the pack flag must be `filingCountry`
   * and must NOT be `country`. `country` is the body's own visible postal address field on the same form,
   * carrying a country NAME from the ISO list. Both live here at once with different values, which is the
   * whole condition the rename exists for; without it every identity save died with "No statutory pack for
   * Malaysia". The server half runs against a real database in test/organization-statutory-card-save.test.ts.
   */
  it('posts filingCountry=MY as a hidden flag, beside a visible postal country that is not it', () => {
    mountBody('edit');
    const form = bodyForm()!;
    const flag = form.querySelector<HTMLInputElement>('input[name="filingCountry"]')!;
    expect(flag, 'the pack flag is on the form').not.toBeNull();
    expect(flag.type).toBe('hidden');
    expect(flag.value, 'an ISO code, which is what packFor() takes').toBe('MY');
    const postal = form.querySelector<HTMLSelectElement>('select[name="country"]')!;
    expect(postal, 'and the postal country is a VISIBLE select').not.toBeNull();
    expect(postal.value, 'holding a country NAME, which packFor() would reject').toBe('Malaysia');
    expect(flag.name).not.toBe(postal.name);
  });

  it('a body with no filing control posts no pack flag at all', () => {
    mountBody('edit', 'ptptn');
    const form = bodyForm()!;
    expect(form.querySelector('[name="filingCountry"]'), 'nothing to write towards the identity row').toBeNull();
    for (const n of ['epfEmployerNo', 'socsoEmployerCode', 'lhdnEmployerNo', 'hrdfStatus']) {
      expect(form.querySelector(`[name="${n}"]`), n).toBeNull();
    }
    // …and it still posts every payment field, so its own row is written whole.
    expect(form.querySelector('[name="accountNo"]')).not.toBeNull();
  });

  it('carries the company, the body and the return marker, so the save lands back on the list', () => {
    mountBody('edit', 'zakat');
    const form = bodyForm()!;
    const hidden = (n: string) => form.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value;
    expect(hidden('companyId')).toBe('c1');
    expect(hidden('authority'), 'the body this form writes').toBe('zakat');
    // app/admin/actions.ts `fromStatutorySetupScreen` compares against this exact literal. ONE marker for a
    // flow that is now two routes: the action chooses list-on-success / here-on-refusal by OUTCOME.
    expect(hidden('returnTo')).toBe('statutory-setup');
  });

  it('HRD Corp posts its registration BAND, under a Registration heading and not a filing one', () => {
    mountBody('edit', 'hrdf');
    const band = document.querySelector<HTMLSelectElement>('select[name="hrdfStatus"]')!;
    expect(band, 'the band select').not.toBeNull();
    expect(band.value, 'pre-selected from what is on file').toBe('mandatory');
    expect(document.body.textContent).toContain(org.authorityRegistrationSection);
    expect(document.body.textContent, 'never captioned as a filed-form number').not.toContain(
      org.authorityFilingSection,
    );
  });

  it('EIS says out loud that it files under SOCSO’s code, instead of showing an empty box', () => {
    mountBody('edit', 'eis');
    expect(document.body.textContent).toContain(org.authorityEisSharesSocso);
    expect(bodyForm()!.querySelector('[name="socsoEmployerCode"]'), 'no second control over one column').toBeNull();
  });

  /**
   * A DEPARTED SIGNATORY STAYS POSTED. `EmployeeSearchField` drops a value that is not in its own option
   * list, which would have turned "edit the phone number" into "clear the authorised signatory" — so the
   * stored person is injected as an option and the hidden input keeps posting their id.
   */
  it('keeps a signatory who has since LEFT selectable rather than silently clearing them', () => {
    mountBody('edit', 'epf', { signatories: [SIGNATORIES[1]] });
    // THE HALF THAT SAVES THE DATA.
    expect(fieldNamed('signatoryPersonId').value, 'still on record').toBe('p1');
    /**
     * AND THE HALF THAT TELLS THE OPERATOR. The searchable field shows its selection as the VALUE of its
     * `[role="combobox"]` input, not as text — so this is read off that input. A `textContent` check would
     * have passed on a field showing an empty box beside a hidden id, which is exactly the state that reads
     * as "nobody is appointed".
     */
    const combo = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(combo.value, 'named as kept on record, not shown blank').toContain(org.authoritySignatoryFormer);
  });

  it('a signatory pick reaches the hidden input the form submits', async () => {
    const u = userEvent.setup();
    mountBody('edit', 'epf', { statutoryAuthorities: [{ ...SAVED_EPF, signatoryPersonId: null }] });
    const combo = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await u.type(combo, 'Bala');
    await u.click(await screen.findByText(/Bala a\/l Muthu/));
    expect(fieldNamed('signatoryPersonId').value).toBe('p2');
  });
});

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * CARRIED FORWARD UNTOUCHED THROUGH BOTH RE-POINTINGS, AND r353 CORRECTED THE REASON WHY.
 *
 * r352 found that `lib/tab-save-dom.ts` `diffTab` SKIPPED the searchable field's hidden input because it
 * could not prove it was user-facing, so a signatory-only edit left the bar reading "No unsaved changes",
 * Save disabled, and the admin's pick thrown away on the next navigation — silently. The fix was two
 * functions recognising the searchable-field SHAPE (`input[role="combobox"]` beside the hidden input) plus
 * `fieldLabel` on the component.
 *
 * ⚠️ THE JUSTIFICATION FOR KEEPING THIS WAS ONCE STATED WRONGLY AND THE CORRECTION IS THE REASON IT STAYS.
 * The claim was "the personnel guards depend on it". r353 checked: they do not. The dom file THIS file
 * descends from was the ONLY exercise of `hiddenInputIsUserFacing` and `controlDisplay` anywhere in the
 * repo. So deleting these four cases because the screen that found the defect moved twice would leave a
 * live fix — still read by the personnel tab-save bar — with no coverage at all. They are tested directly,
 * against the component's REAL rendered markup rather than a hand-built div, because the whole point of the
 * original case was that the shape and the walker have to agree.
 */
describe('§4 the searchable field is still legible to the tab-save walker (carried forward from r352)', () => {
  function mountField(fieldLabelProp?: string) {
    return wrap(
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
      />,
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

  /**
   * AND THE BODY EDITOR STILL DECLARES THE CAPTION. `fieldLabel` is passed on the real screen, so the
   * change summary the walker builds says "Authorised signatory" rather than a humanised column name.
   */
  it('the body editor passes fieldLabel, so the walker has a caption to print', () => {
    mountBody('edit');
    expect(
      document.querySelector('input[name="signatoryPersonId"]')!.getAttribute('data-field-label'),
    ).toBe(org.authoritySignatory);
  });
});
