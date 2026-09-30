/**
 * Item 15e5bd93 REVISION 4 (r370) — THE STATUTORY SETUP, DRIVEN THROUGH REAL EVENTS, ON ONE SCREEN.
 *
 * ⚠️ THIS FILE HAS NOW BEEN RE-POINTED THREE TIMES AND THE REPORTER CONTESTED ALL THREE SUBJECTS.
 * It was `test/15e5bd93-statutory-workspace.dom.test.tsx` (r352: a rail plus a workspace inside the
 * Statutory tab, one Save). r353 re-pointed it at a dedicated screen of eight always-visible cards, each
 * read-only until its own Edit was pressed. r355 re-pointed it at a TABLE of one row per body plus a
 * per-body screen, which is the reporter's own ASCII sketch. The reporter has now called that per-body
 * screen "an unnecessary intermediate page".
 *
 * ⚠️ AND THE FOURTH ROUND IS THE FIRST ONE THAT MEASURED THE SCREEN INSTEAD OF RE-READING THE WORDS.
 * Rendered at 1280 / 1024 / 820 CSS px, the r355 list laid its table out 42–322px wider than its
 * container: the body description carried `truncate`, whose `white-space: nowrap` fixes a cell's
 * min-content at the whole 132-character string, so the first column measured 786px of a ~1000px table,
 * the `Action` heading rendered as "AC" and the Edit link was not painted at all. A green suite did not
 * catch any of it, because every case here asserted what was in the markup and none asserted what could
 * not be. §6 is the answer to that and is new.
 *
 * So it now mounts ONE component, which is the shape of the thing being tested:
 *   · `StatutorySetupScreen` — the whole screen. A read-only identity card, then every statutory body as
 *     its own card with every field already open, inside one `TabSaveScope` with one Save.
 *
 * ── EVERY r355 CLAIM, AND WHAT BECAME OF IT ───────────────────────────────────────────────────────
 *
 *  (1) "draws all eight bodies in the controlled set's order, as table rows" — KEPT AS A CLAIM ABOUT
 *      CARDS. The exact set and the exact order still hold. §1.
 *
 *  (2) "holds no field, no form and nothing that can expand" — REVERSED, and the reversal IS the round.
 *      The contest's words are that a View step and an Edit step are both a click between arriving and
 *      changing something. Every field on every body is now mounted and editable on arrival, and §1
 *      asserts exactly that: eight forms, and each body's full posted set already in the document.
 *
 *  (3) "every row offers a live View and a live Edit" — REVERSED. There is nothing to open: §1 asserts
 *      that no View or Edit affordance exists anywhere on the screen and that no `?mode=` link is built.
 *
 *  (4) "reads Payment Setup off the record and Status off what is actually contributing", and "HRD Corp
 *      can read Configured and Inactive at the same time" — RETIRED WITH THE TABLE, NOT SILENTLY
 *      DROPPED. Both columns belonged to the table. r355's answer to the reporter was honest and is
 *      quoted forward here: Payment Setup meant a `company_statutory_authority` row exists, Status meant
 *      the body is actually contributing. Each card now carries ONE word meaning the first of those, for
 *      all eight bodies alike, still derived through the one shared `statutoryRowStatus`. HRD Corp's
 *      second fact is the Contribution Rate select on its own card, where it is CHOSEN — §3 pins that it
 *      is still there, so the fact did not leave the screen.
 *
 *  (5) "Cancel is a link back to the list, never a button inside the form it would submit" — REPLACED by
 *      §5. There is no list to go back to and no per-body form to cancel. Cancel LEAVES the screen, and
 *      leaving with something unsaved asks first, with the reporter's own three buttons.
 *
 *  (6) THE PACK FLAG. `filingCountry`, not `country`, because a hidden `country` beside a visible postal
 *      `country` was overwritten with "Malaysia" and posted into `packFor()`. §3 keeps the DOM half, and
 *      it matters MORE here than it did on the per-body page: eight visible postal `country` selects now
 *      share one save scope. §2 pins the general form of that hazard for every hidden input on the
 *      screen.
 *
 *  (7) §4 IS CARRIED FORWARD UNCHANGED IN CLAIM, for the third time and for the reason r353 established:
 *      the dom file this one descends from is the ONLY exercise of `hiddenInputIsUserFacing` and
 *      `controlDisplay` anywhere in the repo. It keeps its number as well as its claims.
 *
 * ⚠️ IT MOUNTS THE REAL COMPONENTS, not stand-ins shaped like them — including the real `TabSaveScope`,
 * because "one Save writes only the bodies you touched" is a property of the walker, the scope and the
 * markup agreeing, and a hand-built div could not reproduce it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

// vi.mock factories are hoisted above every other statement in the file, so anything they close over has
// to be hoisted with them — vi.hoisted is how this repo does that (test/personnel-tab-save.dom.test.tsx).
const { refresh, push, toastSuccess, toastError } = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
/**
 * `next/link` AS A PLAIN ANCHOR, AND THAT IS THE RIGHT STAND-IN HERE RATHER THAN A CONVENIENCE.
 *
 * The App Router's Link reads a router CONTEXT this render has no provider for, and what is under test
 * is not Link: the scope's unsaved guard is a capture-phase listener on `document` that matches
 * `a[href]` and knows nothing about which component emitted it (components/tab-save-scope.tsx). An
 * `<a href>` is therefore the exact surface the guard sees in a browser. The NAVIGATION it performs once
 * the guard allows it is asserted through the mocked `router.push`, which is where Link would end up.
 */
vi.mock('next/link', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : String(href)} {...rest}>
      {children}
    </a>
  ),
}));

import messages from '../messages/en.json';
import { StatutorySetupScreen } from '../components/statutory-setup-screen';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import { controlDisplay, fieldLabel, hiddenInputIsUserFacing, isMirrorInput } from '../lib/tab-save-dom';
import { EmployeeSearchField } from '../components/employee-search-field';
import { __resetUnsavedGuards } from '../lib/unsaved-changes';
import type { TabSaveResult } from '../lib/tab-save-sections';

const org = messages.admin.organization as Record<string, string>;
const noop = () => undefined;
const BACK_HREF = '/admin/organization/c1?tab=statutory';

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
  // The postal country a body's card renders as a VISIBLE select — the value that would be copied over a
  // hidden input of the same name if the pack flag were still called `country`.
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

/** THE WHOLE SCREEN. One mount, because there is one screen. */
function mountScreen(over: Record<string, unknown> = {}, save?: (fd: FormData) => Promise<TabSaveResult>) {
  const props = {
    companyId: 'c1',
    filingCountry: 'MY',
    statutory: IDENTITY,
    statutoryAuthorities: [SAVED_EPF],
    bankProfiles: [BANK],
    signatories: SIGNATORIES,
    stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
    backHref: BACK_HREF,
    actions: {
      saveStatutoryScreen: save ?? (async () => ({ ok: true, saved: [] })),
      setStatutoryAuthority: noop,
      removeStatutoryAuthority: noop,
    },
    ...over,
  };
  return wrap(<StatutorySetupScreen {...(props as Parameters<typeof StatutorySetupScreen>[0])} />);
}

const cardOf = (authority: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-statutory-card="${authority}"]`);
  expect(el, `${authority} has a card`).not.toBeNull();
  return el!;
};
const formOf = (authority: string): HTMLFormElement => {
  const el = document.querySelector<HTMLFormElement>(`form[data-statutory-form="${authority}"]`);
  expect(el, `${authority} has a form`).not.toBeNull();
  return el!;
};
const fieldIn = (authority: string, name: string): HTMLInputElement => {
  const el = cardOf(authority).querySelector<HTMLInputElement>(`[name="${name}"]`);
  expect(el, `${authority} carries ${name}`).not.toBeNull();
  return el!;
};
const saveButton = (where: 'top' | 'bar') =>
  document.querySelector<HTMLButtonElement>(`[data-tab-save-submit="${where}"]`)!;
const cancelLink = (where: 'top' | 'bar') =>
  document.querySelector<HTMLAnchorElement>(`[data-tab-save-leave="${where}"]`)!;

/** The thirteen names one body's card posts towards its own row, plus its filing control where it has one. */
const PAYMENT_NAMES = [
  'accountNo',
  'bankProfileId',
  'addressLine1',
  'addressLine2',
  'addressLine3',
  'city',
  'state',
  'postcode',
  'country',
  'phone',
  'email',
  'signatoryPersonId',
];

/**
 * jsdom implements no navigation, so an anchor the guard DELIBERATELY lets through (the clean case)
 * would print "Not implemented: navigation" and leave the document on the same page anyway. This
 * listener is on the BUBBLE phase, i.e. strictly after the scope's own capture-phase guard has had the
 * event, so it can neither hide the guard firing nor stand in for it: when the screen is dirty the guard
 * has already called `preventDefault()` AND `stopPropagation()`, and this never runs at all.
 */
const swallowNavigation = (e: MouseEvent) => e.preventDefault();

beforeEach(() => {
  document.body.innerHTML = '';
  __resetUnsavedGuards();
  document.addEventListener('click', swallowNavigation);
  refresh.mockClear();
  push.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

afterEach(() => {
  document.removeEventListener('click', swallowNavigation);
});

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 one screen: identity on top, every body a card, every field already open', () => {
  it('draws all eight bodies in the controlled set’s order, as cards', () => {
    mountScreen();
    expect(
      [...document.querySelectorAll('[data-statutory-card]')].map((c) => c.getAttribute('data-statutory-card')),
      'every SUPPORTED body, in the controlled set’s own order, nothing filtered and nothing sliced',
    ).toEqual([...STATUTORY_AUTHORITIES]);
    // EIS keeps its own card immediately after SOCSO and its own record: its PAYMENT account genuinely
    // differs from SOCSO's on this tenant, so merging them would strand EIS's account with no editor.
    const ids = [...document.querySelectorAll('[data-statutory-card]')].map((c) =>
      c.getAttribute('data-statutory-card'),
    );
    expect(ids[ids.indexOf('socso') + 1], 'the very next card').toBe('eis');
  });

  /**
   * ⚠️ THE CLAIM THIS ITEM WAS CONTESTED THREE TIMES OVER, AND THE ONE THIS ROUND REVERSES. r352 put the
   * fields in the tab behind a rail; r353 put them behind eight Edit buttons; r355 put them behind a
   * table row's Edit link and a page load. The reporter's latest words: the drill-in is "an unnecessary
   * intermediate page". So every field of every body is mounted and editable on arrival.
   *
   * Asserted as the EXACT posted set per body rather than "some inputs exist", because a card rendering
   * two of its thirteen boxes would pass a looser check.
   */
  it('mounts every field of every body at once — no View step, no Edit step, nothing to expand', () => {
    mountScreen();
    for (const a of STATUTORY_AUTHORITIES) {
      const card = cardOf(a);
      expect(card.querySelector('form[data-statutory-form]'), `${a} has its form open`).not.toBeNull();
      for (const name of PAYMENT_NAMES) fieldIn(a, name);
    }
    // EPF, SOCSO and LHDN also carry their own filing number; HRD Corp its rate.
    expect(fieldIn('epf', 'epfEmployerNo')).toBeTruthy();
    expect(fieldIn('socso', 'socsoEmployerCode')).toBeTruthy();
    expect(fieldIn('lhdn', 'lhdnEmployerNo')).toBeTruthy();
    expect(fieldIn('hrdf', 'hrdfStatus')).toBeTruthy();
    // Nothing folds and nothing is refused: no disabled control anywhere on the screen.
    expect(document.querySelectorAll('details'), 'nothing folds').toHaveLength(0);
    expect(document.querySelectorAll('[aria-expanded="false"]:not([role="combobox"])')).toHaveLength(0);
    expect(document.querySelectorAll('input[disabled], select[disabled], textarea[disabled]')).toHaveLength(0);
  });

  /**
   * ⚠️ REVERSES r355's "every row offers a live View and a live Edit". Those two links opened
   * `…/statutory/<body>?mode=view|edit`, the page the reporter contested. Both the affordances AND the
   * route they addressed are gone, and the address is asserted absent as well as the link: a Back link
   * left pointing at a deleted route is a 404 nobody notices until a reader presses it.
   */
  it('offers no View, no Edit and no address with a body in it', () => {
    mountScreen();
    expect(document.querySelectorAll('[data-statutory-view-link]'), 'no View').toHaveLength(0);
    expect(document.querySelectorAll('[data-statutory-edit-link]'), 'no Edit').toHaveLength(0);
    for (const a of [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]) {
      expect(a.getAttribute('href'), 'no link addresses the deleted per-body route').not.toMatch(
        /\/statutory\/[a-z]/,
      );
      expect(a.getAttribute('href'), 'and nothing carries a mode').not.toContain('mode=');
    }
    expect(document.body.textContent, 'and no caption from the page that is gone').not.toContain(
      org.statutoryBodyViewCaption,
    );
  });

  /**
   * ONE WORD PER CARD, AND WHAT IT MEANS. r355 drew two columns and the plan told the reporter what each
   * one was: Payment Setup = a `company_statutory_authority` row exists; Status = the body is actually
   * contributing. Both belonged to the table. Each card now says Set up / Not set up, meaning the first
   * of those, identically for all eight — so a shared caption says only what is true of every member
   * (CLAUDE.md §8).
   */
  it('gives each card one status word, meaning the same thing for every body', () => {
    mountScreen();
    const word = (a: string) =>
      (cardOf(a).querySelector(`[data-statutory-card-status="${a}"]`)?.textContent ?? '').trim();
    expect(word('epf'), 'EPF has a payment record').toBe(org.statutoryCardSetUp);
    for (const a of STATUTORY_AUTHORITIES.filter((x) => x !== 'epf')) {
      expect(word(a), a).toBe(org.statutoryCardNotSetUp);
    }
    /**
     * ⚠️ HRD CORP IS THE BODY THE OLD SECOND COLUMN EXISTED FOR, AND ITS FACT IS STILL ON THE SCREEN —
     * as the control that DECIDES it rather than as a derived pill. The identity row says 'mandatory',
     * so the levy is charged, and the card's own select says so and can change it.
     */
    expect(word('hrdf'), 'no payment record, so the one word says so').toBe(org.statutoryCardNotSetUp);
    expect(fieldIn('hrdf', 'hrdfStatus').value, 'while the contributing fact is the rate, and it is here').toBe(
      'mandatory',
    );
    // No status word is a switch or a link — the same claim r353 and r355 made, unchanged.
    for (const label of [org.statutoryCardSetUp, org.statutoryCardNotSetUp]) {
      for (const el of screen.queryAllByText(label)) {
        expect(el.closest('button'), `${label} is a statement, not a switch`).toBeNull();
        expect(el.closest('a'), `${label} is not a link either`).toBeNull();
      }
    }
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0);
  });

  /**
   * THE IDENTITY CARD, AT THE TOP, READ-ONLY. Six facts: SSM, MyInvois and the four filing identifiers.
   * Asserted as an EXACT ordered list of captions, because a substring check would pass on a card that
   * rendered two of them.
   */
  it('prints the statutory identity at the top, with the four filing identifiers and no input', () => {
    mountScreen();
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
     * ⚠️ READ-ONLY HERE AND EDITABLE PER BODY — the decision this flow has made since r353. These four
     * live on `company_statutory_my` and are edited inside each body's card through MY_FILING_FIELD
     * (r226). Two editable copies would be two doors onto one column and whichever was saved second
     * would win.
     */
    expect(card!.querySelectorAll('input, select, textarea'), 'the card holds no writer').toHaveLength(0);
    // It is ABOVE the first body card, which is the whole of "identity stays at the top".
    expect(
      card!.compareDocumentPosition(cardOf('epf')) & Node.DOCUMENT_POSITION_FOLLOWING,
      'identity first',
    ).toBeTruthy();
  });

  it('names what is not set on the identity card instead of rendering an empty gap', () => {
    mountScreen({ statutory: null });
    const card = document.querySelector<HTMLElement>('[data-statutory-identity]')!;
    expect(
      new Set([...card.querySelectorAll('dd')].map((d) => (d.textContent ?? '').trim())),
      'every absent fact says so in words, including HRD Corp’s rate',
    ).toEqual(new Set([org.authorityValueNotSet]));
    for (const band of [org.hrdfNotRegistered, org.hrdfMandatory, org.hrdfOptional]) {
      expect(card.textContent, `an absent identity row is never read as ${band}`).not.toContain(band);
    }
  });

  /** The empty state for a company with no bank accounts, carried through every shape of this screen. */
  it('warns when there is no bank account to route a statutory payment from', () => {
    mountScreen({ bankProfiles: [] });
    expect(screen.getByText(org.authoritiesNoBankAccounts)).toBeTruthy();
  });

  /**
   * "Clear this authority" DELETES the body's row — bucket (b) of
   * docs/audits/65b22c00-organization-save-classification.md. It is a form of its own OUTSIDE the section
   * marker, so the screen-wide Save can never appear to cover it, and it appears only where there IS a
   * row.
   */
  it('Clear is its own form, outside the saved section, only on a body that HAS a record', () => {
    mountScreen();
    const clear = document.querySelector<HTMLFormElement>('[data-statutory-clear="epf"]');
    expect(clear, 'EPF has a row, so it can be cleared').not.toBeNull();
    expect(clear!.hasAttribute('data-save-section'), 'and the screen Save does not own it').toBe(false);
    expect(clear!.contains(formOf('epf')), 'nor is it nested in the saved form').toBe(false);
    expect(within(clear!).getByRole('button', { name: org.authorityClear })).toBeTruthy();
    expect(clear!.querySelector('[name="id"]')!.getAttribute('value')).toBe('sa1');
    expect(clear!.querySelector('[name="authority"]')!.getAttribute('value')).toBe('epf');
    expect(clear!.querySelector('[name="returnTo"]')!.getAttribute('value')).toBe('statutory-setup');
    expect(document.querySelector('[data-statutory-clear="ptptn"]'), 'a body with no row has nothing to clear').toBeNull();
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * ⚠️ THE LOAD-BEARING SECTION OF THIS ROUND.
 *
 * The reporter asked for "one Save button for the entire Statutory Payment Setup screen… Save all
 * changes together… remain on the same screen". The danger in granting it is precise and silent: a Save
 * that wrote all eight bodies would CREATE a `company_statutory_authority` row for every one of them and
 * flip every "Not set up" card to "Set up" — eight statutory bodies registered because somebody fixed a
 * postcode. A green test that passed while all eight were written would be the worst outcome this round
 * could ship.
 *
 * So the payload is read, not described. The server half runs against a real database in
 * test/organization-statutory-card-save.test.ts.
 */
describe('§2 one Save for the whole screen, and it writes ONLY the bodies you touched', () => {
  it('offers exactly one Save above the cards and one below, and no second Save anywhere', () => {
    mountScreen();
    expect(saveButton('top'), 'Save at the top, because the screen is eight bodies long').toBeTruthy();
    expect(saveButton('bar'), 'and again at the foot').toBeTruthy();
    expect(document.querySelectorAll('[data-tab-save-submit]'), 'exactly two, both the same Save').toHaveLength(2);
    for (const where of ['top', 'bar'] as const) {
      expect(saveButton(where).textContent).toContain(org.statutoryScreenSave);
      expect(saveButton(where).disabled, 'nothing to save yet').toBe(true);
    }
    // No per-card Save survived the fold-in: the eight forms carry no submit button of their own.
    for (const a of STATUTORY_AUTHORITIES) {
      expect(
        formOf(a).querySelectorAll('button[type="submit"], input[type="submit"]'),
        `${a} has no Save of its own`,
      ).toHaveLength(0);
    }
  });

  it('writes ONLY the body that was touched, and names no other section in the payload', async () => {
    const u = userEvent.setup();
    const seen: FormData[] = [];
    const save = vi.fn(async (fd: FormData) => {
      seen.push(fd);
      return { ok: true, saved: ['epf'] };
    });
    mountScreen({}, save);

    await u.clear(fieldIn('epf', 'accountNo'));
    await u.type(fieldIn('epf', 'accountNo'), 'ACC-9');
    await waitFor(() => expect(saveButton('bar').disabled).toBe(false));
    await u.click(saveButton('bar'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const fd = seen[0];
    expect(fd.get('sections'), 'ONE body named, and it is the one that was typed in').toBe('epf');
    expect(fd.get('companyId'), 'the record identity arrives ONCE, at the top level').toBe('c1');
    expect(fd.get('section.epf.accountNo'), 'carrying what is on screen').toBe('ACC-9');
    /**
     * ⚠️ THE ASSERTION THAT FAILS IF A SAVE EVER WRITES EVERYTHING. Not "socso is absent" — every other
     * body, checked by name, because a payload carrying seven untouched bodies would create seven rows.
     */
    for (const a of STATUTORY_AUTHORITIES.filter((x) => x !== 'epf')) {
      expect(
        [...fd.keys()].filter((k) => k.startsWith(`section.${a}.`)),
        `${a} was not touched, so nothing of it may be in the payload`,
      ).toEqual([]);
    }
  });

  it('names both bodies when both were touched, and still nothing else', async () => {
    const u = userEvent.setup();
    const seen: FormData[] = [];
    const save = vi.fn(async (fd: FormData) => {
      seen.push(fd);
      return { ok: true, saved: ['epf', 'lhdn'] };
    });
    mountScreen({}, save);

    await u.type(fieldIn('lhdn', 'city'), 'Putrajaya');
    await u.type(fieldIn('epf', 'phone'), '9');
    await waitFor(() => expect(saveButton('top').disabled).toBe(false));
    await u.click(saveButton('top'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const named = String(seen[0].get('sections')).split(',');
    expect(new Set(named), 'the two bodies that moved').toEqual(new Set(['epf', 'lhdn']));
    expect(seen[0].get('section.lhdn.city')).toBe('Putrajaya');
    for (const a of STATUTORY_AUTHORITIES.filter((x) => x !== 'epf' && x !== 'lhdn')) {
      expect([...seen[0].keys()].filter((k) => k.startsWith(`section.${a}.`)), a).toEqual([]);
    }
  });

  /**
   * ⚠️ THE r226 DATA-LOSS SHAPE, GENERALISED AND PINNED FOR THE WHOLE SCREEN.
   *
   * `lib/tab-save-dom.ts` `syncCarriedValues` copies a VISIBLE control's value into any HIDDEN input of
   * the same name in another section, immediately before the payload is built. That is what turned a
   * hidden `country` on the registrations card into "Malaysia" and killed every identity save in r352,
   * and this screen puts EIGHT visible postal `country` selects into one scope. The rename to
   * `filingCountry` is the fix; this asserts the general property, so a hidden input added later under a
   * name some other card shows visibly cannot slip through.
   */
  it('no hidden input on this screen is a mirror of another card’s visible control', () => {
    mountScreen();
    const root = document.body;
    const hidden = [...document.querySelectorAll<HTMLInputElement>('input[type="hidden"][name]')];
    expect(hidden.length, 'there are hidden inputs to check').toBeGreaterThan(0);
    for (const el of hidden) {
      expect(
        isMirrorInput(root, el),
        `${el.name} in ${el.closest('[data-statutory-card]')?.getAttribute('data-statutory-card')} would be overwritten by another card's visible control of the same name`,
      ).toBe(false);
    }
  });

  it('a failed save keeps the reader on the screen and says which body did not commit', async () => {
    const u = userEvent.setup();
    const save = vi.fn(async () => ({
      ok: false,
      saved: [],
      failedSection: 'epf',
      error: 'Choose a signatory who is an active employee of this company',
    }));
    mountScreen({}, save);
    await u.type(fieldIn('epf', 'accountNo'), 'X');
    await waitFor(() => expect(saveButton('bar').disabled).toBe(false));
    await u.click(saveButton('bar'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Still here, still eight cards, and the refusal is on the screen that holds the boxes it is about.
    expect(document.querySelectorAll('[data-statutory-card]')).toHaveLength(STATUTORY_AUTHORITIES.length);
    expect(screen.getByRole('alert').textContent).toContain('active employee of this company');
    expect(push, 'a refusal navigates nowhere').not.toHaveBeenCalled();
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 what each body’s card actually submits', () => {
  /**
   * CARRIED FORWARD FROM r352, THROUGH r353 AND r355, UNCHANGED IN SUBSTANCE: the pack flag must be
   * `filingCountry` and must NOT be `country`. `country` is the body's own visible postal address field
   * on the same card, carrying a country NAME from the ISO list. Both live here at once with different
   * values, which is the whole condition the rename exists for; without it every identity save died with
   * "No statutory pack for Malaysia". The server half runs against a real database in
   * test/organization-statutory-card-save.test.ts.
   */
  it('posts filingCountry=MY as a hidden flag, beside a visible postal country that is not it', () => {
    mountScreen();
    const form = formOf('epf');
    const flag = form.querySelector<HTMLInputElement>('input[name="filingCountry"]')!;
    expect(flag, 'the pack flag is on the card').not.toBeNull();
    expect(flag.type).toBe('hidden');
    expect(flag.value, 'an ISO code, which is what packFor() takes').toBe('MY');
    const postal = form.querySelector<HTMLSelectElement>('select[name="country"]')!;
    expect(postal, 'and the postal country is a VISIBLE select').not.toBeNull();
    expect(postal.value, 'holding a country NAME, which packFor() would reject').toBe('Malaysia');
    expect(flag.name).not.toBe(postal.name);
  });

  it('a body with no filing control posts no pack flag at all', () => {
    mountScreen();
    const form = formOf('ptptn');
    expect(form.querySelector('[name="filingCountry"]'), 'nothing to write towards the identity row').toBeNull();
    for (const n of ['epfEmployerNo', 'socsoEmployerCode', 'lhdnEmployerNo', 'hrdfStatus']) {
      expect(form.querySelector(`[name="${n}"]`), n).toBeNull();
    }
    // …and it still posts every payment field, so its own row is written whole.
    expect(form.querySelector('[name="accountNo"]')).not.toBeNull();
  });

  it('every card carries the company and the body it writes, and the return marker for Clear', () => {
    mountScreen();
    for (const a of STATUTORY_AUTHORITIES) {
      const form = formOf(a);
      const hidden = (n: string) => form.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value;
      expect(hidden('companyId'), a).toBe('c1');
      expect(hidden('authority'), `${a} names the body this card writes`).toBe(a);
      // app/admin/actions.ts `fromStatutorySetupScreen` compares against this exact literal.
      expect(hidden('returnTo'), a).toBe('statutory-setup');
    }
  });

  /**
   * ⚠️ THE SERVER TAKES THE BODY FROM THE SECTION ID, NOT FROM THIS INPUT, and the reason is visible
   * here: there are now EIGHT hidden `authority` copies in one payload, which is eight chances for a
   * crafted request to point one body's write at another body's row. The input still exists because a
   * refused Clear needs it (`removeCompanyStatutoryAuthorityAction` keys the delete off the row id).
   */
  it('gives each card its own section marker, matching its body', () => {
    mountScreen();
    expect(
      [...document.querySelectorAll('[data-save-section]')].map((f) => f.getAttribute('data-save-section')),
      'one saved section per body, in order, and nothing else on the screen carries the marker',
    ).toEqual([...STATUTORY_AUTHORITIES]);
    for (const a of STATUTORY_AUTHORITIES) {
      expect(formOf(a).getAttribute('data-save-section'), a).toBe(a);
    }
  });

  it('HRD Corp posts its registration RATE, under a Registration heading and not a filing one', () => {
    mountScreen();
    const card = cardOf('hrdf');
    const band = card.querySelector<HTMLSelectElement>('select[name="hrdfStatus"]')!;
    expect(band, 'the rate select').not.toBeNull();
    expect(band.value, 'pre-selected from what is on file').toBe('mandatory');
    expect(card.textContent).toContain(org.authorityRegistrationSection);
    /**
     * ⚠️ ASSERTED ON THE CARD, NOT ON THE DOCUMENT. Every body is on this screen now, so EPF's card
     * legitimately shows the filing heading; the claim is that HRD CORP's card does not, which is what
     * it always meant.
     */
    expect(card.textContent, 'never captioned as a filed-form number').not.toContain(org.authorityFilingSection);
  });

  it('EIS says out loud that it files under SOCSO’s code, instead of showing an empty box', () => {
    mountScreen();
    const card = cardOf('eis');
    expect(card.textContent).toContain(org.authorityEisSharesSocso);
    expect(formOf('eis').querySelector('[name="socsoEmployerCode"]'), 'no second control over one column').toBeNull();
    // And exactly ONE control over that column exists on the whole screen — SOCSO's own.
    expect(document.querySelectorAll('[name="socsoEmployerCode"]'), 'one owner, one editor').toHaveLength(1);
  });

  /**
   * A DEPARTED SIGNATORY STAYS POSTED. `EmployeeSearchField` drops a value that is not in its own option
   * list, which would have turned "edit the phone number" into "clear the authorised signatory" — so the
   * stored person is injected as an option and the hidden input keeps posting their id.
   */
  it('keeps a signatory who has since LEFT selectable rather than silently clearing them', () => {
    mountScreen({ signatories: [SIGNATORIES[1]] });
    expect(fieldIn('epf', 'signatoryPersonId').value, 'still on record').toBe('p1');
    /**
     * AND THE HALF THAT TELLS THE OPERATOR. The searchable field shows its selection as the VALUE of its
     * `[role="combobox"]` input, not as text — so this is read off that input. A `textContent` check
     * would have passed on a field showing an empty box beside a hidden id, which is exactly the state
     * that reads as "nobody is appointed".
     */
    const combo = cardOf('epf').querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(combo.value, 'named as kept on record, not shown blank').toContain(org.authoritySignatoryFormer);
  });

  it('a signatory pick reaches the hidden input the form submits', async () => {
    const u = userEvent.setup();
    mountScreen({ statutoryAuthorities: [{ ...SAVED_EPF, signatoryPersonId: null }] });
    const combo = cardOf('epf').querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await u.type(combo, 'Bala');
    await u.click(await screen.findByText(/Bala a\/l Muthu/));
    expect(fieldIn('epf', 'signatoryPersonId').value).toBe('p2');
  });
});

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * CARRIED FORWARD UNTOUCHED THROUGH THREE RE-POINTINGS, AND r353 CORRECTED THE REASON WHY.
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
 * repo. So deleting these four cases because the screen that found the defect moved three times would
 * leave a live fix — still read by the personnel tab-save bar — with no coverage at all. They are tested
 * directly, against the component's REAL rendered markup rather than a hand-built div, because the whole
 * point of the original case was that the shape and the walker have to agree.
 *
 * ⚠️ AND IT IS NO LONGER ONLY THE PERSONNEL BAR THAT DEPENDS ON IT. This screen now has a consolidated
 * Save of its own, so a signatory-only edit on any of eight cards is exactly the r352 defect again.
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
   * AND EVERY BODY CARD STILL DECLARES THE CAPTION. `fieldLabel` is passed on the real screen, so the
   * change summary the walker builds says "Authorised signatory" rather than a humanised column name —
   * on all eight cards, not only the first.
   */
  it('every body card passes fieldLabel, so the walker has a caption to print', () => {
    mountScreen();
    for (const a of STATUTORY_AUTHORITIES) {
      expect(fieldIn(a, 'signatoryPersonId').getAttribute('data-field-label'), a).toBe(org.authoritySignatory);
    }
  });

  /** A signatory-only edit makes the screen dirty — the r352 defect, executed on this screen. */
  it('a signatory pick alone is enough to enable the one Save', async () => {
    const u = userEvent.setup();
    mountScreen({ statutoryAuthorities: [{ ...SAVED_EPF, signatoryPersonId: null }] });
    expect(saveButton('bar').disabled, 'nothing changed yet').toBe(true);
    const combo = cardOf('epf').querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await u.type(combo, 'Bala');
    await u.click(await screen.findByText(/Bala a\/l Muthu/));
    await waitFor(() => expect(saveButton('bar').disabled, 'the pick is an unsaved change').toBe(false));
  });
});

// ── §5 ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * LEAVING WITH SOMETHING UNSAVED — the reporter's own list, in their own words: "If there are unsaved
 * changes, display a confirmation… Options: Save & Leave / Discard & Leave / Cancel."
 *
 * ⚠️ WHAT THIS DOES NOT CLAIM. `beforeunload` (armed by the scope) covers a closed tab, a reload and a
 * typed address, and it CANNOT carry three buttons or be worded — the browser draws its own two-choice
 * prompt. That route offers leave-or-stay only, and saying so is better than implying the browser's
 * dialog is ours.
 */
describe('§5 Cancel and Back leave, and leaving with unsaved work asks first', () => {
  it('offers Cancel beside each Save, as a LINK back to the company’s Statutory tab', () => {
    mountScreen();
    for (const where of ['top', 'bar'] as const) {
      const cancel = cancelLink(where);
      expect(cancel, `Cancel at the ${where}`).not.toBeNull();
      expect(cancel.tagName, 'a link, so the scope’s anchor guard owns the unsaved case').toBe('A');
      expect(cancel.getAttribute('href'), 'back to the tab this screen was opened from').toBe(BACK_HREF);
      expect(cancel.textContent).toContain(org.statutoryScreenCancel);
      expect(cancel.closest('form'), 'and never inside a form it could submit').toBeNull();
    }
    // Discard-and-stay is NOT drawn on the approved mockup and is not invented: discarding is the
    // prompt's middle button, which is where the reporter put it.
    expect(screen.queryByRole('button', { name: messages.components.tabSave.discardChanges })).toBeNull();
  });

  it('lets Cancel through untouched when nothing has been changed', async () => {
    const u = userEvent.setup();
    mountScreen();
    await u.click(cancelLink('bar'));
    expect(screen.queryByRole('dialog'), 'nothing to lose, nothing to ask').toBeNull();
  });

  it('asks before Cancel throws an edit away, with the reporter’s three choices', async () => {
    const u = userEvent.setup();
    mountScreen();
    await u.type(fieldIn('socso', 'city'), 'Shah Alam');
    await waitFor(() => expect(saveButton('bar').disabled).toBe(false));

    await u.click(cancelLink('top'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(org.statutoryUnsavedTitle)).toBeTruthy();
    expect(within(dialog).getByText(org.statutoryUnsavedBody)).toBeTruthy();
    expect(
      [...dialog.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()),
      'exactly the three the reporter listed, in their order',
    ).toEqual([org.statutoryUnsavedCancel, org.statutoryUnsavedDiscard, org.statutoryUnsavedSave]);
    // Its words are the screen's own, not the tab bar's "Discard Changes" / "Save Changes".
    expect(dialog.textContent).not.toContain(messages.components.tabSave.discardChanges);
    expect(push, 'and nothing has navigated while the question is open').not.toHaveBeenCalled();
  });

  it('Cancel in the dialog leaves the reader where they are, with the edit intact', async () => {
    const u = userEvent.setup();
    mountScreen();
    await u.type(fieldIn('socso', 'city'), 'Shah Alam');
    await u.click(cancelLink('bar'));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: org.statutoryUnsavedCancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(push).not.toHaveBeenCalled();
    expect(fieldIn('socso', 'city').value, 'the typing is still there').toBe('Shah Alam');
  });

  it('Save & Leave writes first and navigates only once the save succeeded', async () => {
    const u = userEvent.setup();
    const save = vi.fn(async () => ({ ok: true, saved: ['socso'] }));
    mountScreen({}, save);
    await u.type(fieldIn('socso', 'city'), 'Shah Alam');
    await u.click(cancelLink('bar'));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: org.statutoryUnsavedSave }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith(BACK_HREF));
  });

  it('Discard & Leave navigates without writing anything', async () => {
    const u = userEvent.setup();
    const save = vi.fn(async () => ({ ok: true, saved: [] }));
    mountScreen({}, save);
    await u.type(fieldIn('socso', 'city'), 'Shah Alam');
    await u.click(cancelLink('bar'));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: org.statutoryUnsavedDiscard }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(BACK_HREF));
    expect(save, 'discard writes nothing').not.toHaveBeenCalled();
  });
});

// ── §6 ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * ⚠️ THE FOUR DEFECTS A GREEN SUITE DID NOT CATCH, AND THE CASES THAT WOULD HAVE.
 *
 * Every one of D1–D6 was in the markup the whole time and every case in this file passed over it,
 * because they all asserted what was PRESENT and none asserted what could not be READ. jsdom computes no
 * layout, so these cannot measure a pixel — what they CAN do is pin the source decisions that produced
 * the measurements, at the two places they were made:
 *
 *   D1  the 132-character body description carried `truncate` (`white-space: nowrap`), which fixed the
 *       first table cell's min-content at 786px of a ~1000px table and pushed the Action column off the
 *       right edge of the page, unpainted.
 *   D2  the status pill had no `whitespace-nowrap`, so "Not set up" wrapped and "UP" rendered outside
 *       the rounded background.
 *   D3  the correspondence address was joined into one line and `truncate`d — the literal "…" the
 *       reporter drew.
 *   D6  four widths for one kind of field (484 / 320 / 648 / 976 at 1280): a postcode box as wide as an
 *       email box.
 *
 * D4 (the `<dl>` that declared a grid and then cancelled it per row) and D5 (no inset inside the Card)
 * are pinned in test/statutory-setup-screen-render.test.ts, at the source, with the removed class
 * strings named.
 */
describe('§6 the measured defects: nothing on this screen is held to one line', () => {
  it('no value and no description is truncated (D1, D3)', () => {
    mountScreen();
    const clipped = [...document.querySelectorAll<HTMLElement>('.truncate')];
    expect(
      clipped.map((el) => (el.textContent ?? '').slice(0, 40)),
      'a value or a description held to one line is a value the reader cannot read',
    ).toEqual([]);
    // The long one specifically: SOCSO's description is the string that made the r355 table overflow.
    const desc = cardOf('socso').textContent ?? '';
    expect(desc, 'the whole description is on the card').toContain(org.authorityDesc_socso);
    expect(org.authorityDesc_socso.length, 'and it really is long enough to have caused this').toBeGreaterThan(100);
  });

  it('the status pill cannot break its own text out of itself (D2)', () => {
    mountScreen();
    for (const a of STATUTORY_AUTHORITIES) {
      const pill = cardOf(a).querySelector<HTMLElement>(`[data-statutory-card-status="${a}"]`)!;
      expect(pill.className, `${a}: the pill's text must not wrap out of its own background`).toContain(
        'whitespace-nowrap',
      );
    }
  });

  /**
   * ONE WIDTH PER KIND OF FIELD (D6). Every group on every card lays out in the SAME three-column grid,
   * and a control spans one column or all three — never a second grid with a different column count,
   * which is what gave a postcode the width of an email.
   */
  it('lays every field out on the same three shared column lines (D6)', () => {
    mountScreen();
    for (const a of STATUTORY_AUTHORITIES) {
      const card = cardOf(a);
      const grids = [...card.querySelectorAll<HTMLElement>('[class*="grid-cols"]')];
      expect(grids.length, `${a} lays its groups out in grids`).toBeGreaterThan(0);
      for (const g of grids) {
        expect(g.className, `${a}: one column count for the whole card`).toContain('sm:grid-cols-3');
        expect(g.className, `${a}: no second column count`).not.toMatch(/sm:grid-cols-[124-9]/);
      }
      // Spans of one or three only. A `col-span-2` would put two different widths on one column line.
      for (const el of [...card.querySelectorAll<HTMLElement>('[class*="col-span"]')]) {
        expect(el.className, `${a}: spans of 1 or 3 only`).not.toMatch(/col-span-2(?![0-9])/);
      }
    }
  });

  /**
   * AND THE ACTIONS ARE INSIDE THE PAGE, NOT BEHIND A SCROLLER. r355's Action column was hidden behind
   * `tableWrapCls`'s `overflow-x-auto`, which is why it could be missing with nothing on screen saying
   * so. There is no horizontal scroller on this screen at all, and nothing that could hide a control.
   */
  it('puts no control behind a horizontal scroller (D1)', () => {
    mountScreen();
    expect(document.querySelectorAll('.overflow-x-auto'), 'nothing on this screen scrolls sideways').toHaveLength(0);
    expect(document.querySelectorAll('table'), 'and the table that overflowed is gone').toHaveLength(0);
  });
});
