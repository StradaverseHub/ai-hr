/**
 * e78fd03d (r340) — THE SELECTION COMES OFF THE MAIN PAGE.
 *
 * "Remove the existing Company, Year, Payroll Month + SHOW button selection area from the main Payment
 * Submission page." That is claim A of the item and it is an ABSENCE, so it is asserted as one: the
 * rendered screen must carry no `<form>`, no `<select>` and no SHOW submit, and the source must not have
 * quietly kept a second route to the same thing.
 *
 * The POP-UP's own half — that clicking Download opens it, that it asks for company, year and month, that
 * Cancel closes it, and that a `'month-cycle'` format and only a `'month-cycle'` format also gets a Pay
 * cycle control — is `test/r340-payment-submission-download-modal.dom.test.tsx`, which needs a real DOM.
 * The modal mounts on OPEN and its content sits in a `Dialog.Portal`, so none of it is in the server HTML
 * this file renders; asserting it here would be asserting nothing (the r334/cbfa8b0b lesson).
 *
 * ⚠️ NO DATABASE, and the mocks are the sibling seam test's, for its reasons. The screen's only read is
 * `listCompanies`; the registry reaches `db/client` through the Borang A loader, which is why this file is
 * in the NODE project rather than beside the DOM half.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const COMPANY = '11111111-2222-3333-4444-555555555555';

vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => ({ s: {}, scopeIds: [COMPANY] })) }));
vi.mock('@/core/read', () => ({
  listCompanies: vi.fn(async () => [{ id: COMPANY, name: 'Acme Sdn Bhd', archivedAt: null }]),
}));
// Identity translator, so the assertions read as keys rather than as prose a catalogue edit would break.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
  getLocale: vi.fn(async () => 'en'),
}));

import PaymentSubmissionPage from '../app/payroll/payment-submission/page';
import { SUBMISSION_FORMATS, formatsInGroup } from '../app/payroll/payment-submission/registry';

/** Every value of one prop anywhere in a rendered tree (the seam test's walker, same reason). */
function propValues(node: unknown, prop: string, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) propValues(n, prop, acc);
    return acc;
  }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    const v = el.props[prop];
    if (typeof v === 'string') acc.push(v);
    for (const child of Object.values(el.props)) propValues(child, prop, acc);
  }
  return acc;
}

/** Every intrinsic element type in a rendered tree ('div', 'form', 'select', …). */
function elementTypes(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) elementTypes(n, acc);
    return acc;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.type === 'string') acc.push(el.type);
  if (el.props) for (const child of Object.values(el.props)) elementTypes(child, acc);
  return acc;
}

const render = () => PaymentSubmissionPage({ searchParams: Promise.resolve({ companyId: COMPANY }) });

const SRC = readFileSync(new URL('../app/payroll/payment-submission/page.tsx', import.meta.url), 'utf8');
// Comments legitimately describe the control that was removed and quote the field names it submitted, so
// the guard reads the CODE only — the same technique the sibling seam test needs for the same reason.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('e78fd03d (A) — the Year / Payroll month / SHOW area is gone from the page', () => {
  it('renders no form and no select at first paint', async () => {
    const types = elementTypes(await render());
    // A sanity floor: if the walk sees nothing, every absence below is vacuous.
    expect(types.length, 'the walk must actually see the page').toBeGreaterThan(5);
    expect(types, 'the filter form is gone — the selection lives in the pop-up').not.toContain('form');
    expect(types, 'and with it every select that was on the page').not.toContain('select');
  });

  it('none of the three fields the old form submitted is a control on the page itself', async () => {
    const named = propValues(await render(), 'name');
    for (const field of ['year', 'month', 'companyId']) {
      expect(named, `${field} must not be reachable without opening a pop-up`).not.toContain(field);
    }
  });

  it('the SHOW submit is removed from the code, not merely hidden', () => {
    expect(CODE, 'the SHOW button is gone entirely').not.toContain("t('show')");
    // …and nothing kept a GET form on the page as a second route to the same selection.
    expect(CODE).not.toContain('method="get"');
  });

  it('still offers exactly one download affordance per AVAILABLE format, and names the reason for the rest', async () => {
    const tree = await render();
    const available = SUBMISSION_FORMATS.filter((f) => f.available).map((f) => f.id);
    const unavailable = SUBMISSION_FORMATS.filter((f) => !f.available).map((f) => f.id);
    // Compared against the registry rather than against a written list, so adding a format re-aims this.
    expect(propValues(tree, 'data-download').sort()).toEqual([...available].sort());
    expect(propValues(tree, 'data-unavailable').sort()).toEqual([...unavailable].sort());
    expect(available.length, 'a screen with nothing downloadable would satisfy the equality above').toBeGreaterThan(0);
  });

  it('hands the pop-up the FORMAT’s own declaration of what to ask for, not a branch on the shelf', () => {
    expect(CODE, 'the modal reads periodKind off the registry entry').toContain('periodKind={f.periodKind}');
    // If the screen decided this itself it would have to name a kind, a group or an id to decide it with.
    expect(CODE).not.toContain("'month-cycle'");
    expect(CODE).not.toContain('governmentStatutory');
  });

  /**
   * ⚠️ r372 (item f022dd70) UPDATED THIS GUARD, IT DID NOT DELETE IT, AND THE DECISION IT PINS SPLIT IN
   * TWO RATHER THAN BEING REVERSED.
   *
   * It used to read "NO format in the shipped registry declares the cycle kind", with `'month-cycle'`
   * the only cycle kind there was. That kind is a MANDATORY SINGLE choice for a file that MOVES MONEY,
   * and the thing the original decision declined was a picker with no bank file behind it. BOTH HALVES OF
   * THAT ARE STILL TRUE and both are still asserted below.
   *
   * What r372 added is a DIFFERENT kind — `'month-runs'`, a multi-select that defaults to every run and
   * sends NO parameter when everything is ticked — declared by the three GOVERNMENT statutory formats,
   * which file a return rather than pay anybody. Asserted as an exact set, so a fourth format inheriting
   * it by accident fails here rather than quietly growing a control.
   */
  it('the salary shelf is still empty, and no format declares the money-moving single-cycle kind', () => {
    expect(formatsInGroup('salary'), 'a cycle picker with no file behind it is what this plan declined').toEqual([]);
    expect(
      SUBMISSION_FORMATS.filter((f) => f.periodKind === 'month-cycle').map((f) => f.id),
      'a format declaring the mandatory single-cycle kind needs a salary payment file behind it first',
    ).toEqual([]);
  });

  it('the three GOVERNMENT statutory formats declare the multi-run kind, and nothing else does', () => {
    expect(SUBMISSION_FORMATS.filter((f) => f.periodKind === 'month-runs').map((f) => f.id).sort()).toEqual(
      formatsInGroup('governmentStatutory').map((f) => f.id).sort(),
    );
    // Not vacuous: the shelf has to have something on it for the equality above to say anything.
    expect(formatsInGroup('governmentStatutory').length).toBeGreaterThan(0);
  });
});
