/**
 * f3ae3245 — the Fixed Transaction redesign: static wiring assertions (source-assertion convention, cf.
 * test/pay-components-split-page.test.ts).
 *
 * The genuinely risky behaviour on this surface already has behavioural DB tests: effective-dated
 * versioning in test/fixed-transaction.test.ts, the paid-item removal guard in
 * test/fixed-transaction-paid-guard.test.ts. What this file pins is the plumbing the redesign introduces
 * — and, just as importantly, the three things it deliberately did NOT do, each of which is a decision
 * someone reading "make it match Individual Transaction" would otherwise reverse by accident.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXED = join(__dirname, '..', 'app', 'payroll', 'transactions', 'fixed');
const INDIVIDUAL = join(__dirname, '..', 'app', 'payroll', 'transactions', 'individual');
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

/**
 * Source with block and line comments removed.
 *
 * Needed for the "no raw toFixed" assertion, and the reason is worth stating: the redesigned list's own
 * doc comment QUOTES the `Number(amount).toFixed(2)` it replaced, so a plain substring search over the
 * whole file matches the explanation rather than any code. An assertion that a comment can trip is an
 * assertion that will eventually be silenced by deleting the comment.
 */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const listSrc = read(FIXED, 'page.tsx');
const detailSrc = read(FIXED, '[id]', 'page.tsx');
const rowsSrc = read(FIXED, 'fixed-list.tsx');
const actionsSrc = read(FIXED, 'actions.ts');
const workspaceSrc = read(INDIVIDUAL, 'txn-workspace.tsx');
const panelSrc = read(__dirname, '..', 'components', 'collapsible-employee-panel.tsx');
const permsSrc = read(__dirname, '..', 'lib', 'permissions.ts');

describe('f3ae3245 — the employee panel is a SIDE panel, and the collapse is built once', () => {
  it('both transaction screens use the same collapsible panel component', () => {
    // "Built once and used on both" was the whole sequencing argument for doing these two items in one
    // round. Two copies of a collapse control is the outcome that argument existed to prevent.
    expect(listSrc).toContain('CollapsibleEmployeePanel');
    expect(workspaceSrc).toContain('CollapsibleEmployeePanel');
    expect(panelSrc).toContain("'use client'");
  });

  it('each screen persists its own collapse choice, so collapsing one does not collapse the other', () => {
    expect(listSrc).toContain("FIXED_PANEL_COOKIE = 'txn_fixed_panel'");
    expect(read(INDIVIDUAL, 'page.tsx')).toContain("INDIVIDUAL_PANEL_COOKIE = 'txn_individual_panel'");
  });

  it('the panel takes only plain data and ReactNodes — no closure crosses the server boundary', () => {
    // The Fixed page is a SERVER component. A function passed to a client component from one returns a
    // 500 on every request while tsc, the suite and the render check all stay green; that has shipped
    // from this repo before. The panel therefore exposes no callback prop at all, and the assertion is
    // that its prop type mentions none.
    const props = panelSrc.slice(panelSrc.indexOf('}: {'), panelSrc.indexOf('}) {'));
    expect(props).not.toMatch(/=>\s*void/);
    expect(props).not.toMatch(/on[A-Z]\w*\??:/);
  });
});

describe('f3ae3245 — View/Edit is a dedicated page, not a form inside a table cell', () => {
  it('the row links to the [id] route and no longer unfolds a <details> form in the Action cell', () => {
    expect(rowsSrc).toContain('/payroll/transactions/fixed/${r.id}');
    expect(listSrc).not.toContain('<details');
    expect(listSrc).not.toContain('updateFixedTransactionAction');
    expect(rowsSrc).not.toContain('<details');
  });

  it('the dedicated route is registered in the permissions matrix', () => {
    // test/function-access.test.ts fails the build for a guarded page.tsx with no matrix column — this
    // states the registration at the point a reader is looking at the route.
    expect(permsSrc).toContain("'/payroll/transactions/fixed/[id]'");
    expect(detailSrc).toContain('scopedAdmin');
  });

  it('the detail page carries Edit, Stop and Remove, and scope-guards the employment', () => {
    expect(detailSrc).toContain('updateFixedTransactionAction');
    expect(detailSrc).toContain('endFixedTransactionAction');
    expect(detailSrc).toContain('archiveFixedTransactionAction');
    // RLS isolates tenants, not company scope: an out-of-scope employmentId must not resolve.
    expect(detailSrc).toContain('notFound()');
  });

  it('the effective-dating warning survives onto the new page, MORE prominent than the one line it replaces', () => {
    // This is the single most important sentence on the screen and it had the least room. The redesign
    // would have made the extra rows more visible while explaining them less, which is worse than the
    // cramped version it replaces.
    expect(detailSrc).toContain("fixed.versioningTitle");
    expect(detailSrc).toContain("fixed.versioningBody");
    expect(listSrc).toContain("fixed.versioningNote");
  });

  it('a successful Save returns to the LIST, because the id the user opened is not the id that comes back', () => {
    // updateEmploymentPayComponent closes the edited row and INSERTS a new one, so re-rendering
    // /fixed/[id] afterwards would show a closed historical value and invite a second edit of it.
    const start = actionsSrc.indexOf('export async function updateFixedTransactionAction');
    const body = actionsSrc.slice(start, actionsSrc.indexOf('export async function endFixedTransactionAction'));
    expect(body).toContain("back(employmentId, 'toast=saved')");
    expect(body).not.toContain('/payroll/transactions/fixed/${id}');
  });
});

describe('f3ae3245 — the listing gains search, sorting and paging', () => {
  it('has all three, on the columns that exist', () => {
    expect(rowsSrc).toContain('toggleSort');
    expect(rowsSrc).toContain('PAGE_SIZE');
    expect(rowsSrc).toContain("type=\"search\"");
    for (const key of ['code', 'amount', 'validFrom', 'validTo', 'status']) {
      expect(rowsSrc, `sortable by ${key}`).toContain(`case '${key}'`);
    }
  });

  it('renders money through the currency helper, never a raw toFixed', () => {
    // The old table printed `Number(r.amount).toFixed(2)` — a bare number with no currency, on rows that
    // carry a stored one.
    expect(rowsSrc).toContain('formatMoney(r.amount, r.currency)');
    expect(detailSrc).toContain('formatMoney(row.amount');
    for (const [label, src] of [
      ['fixed-list.tsx', rowsSrc],
      ['page.tsx', listSrc],
      ['[id]/page.tsx', detailSrc],
    ] as const) {
      expect(codeOnly(src), `${label} renders money without a raw toFixed`).not.toContain('toFixed(');
    }
  });
});

describe('f3ae3245 — what the redesign deliberately did NOT do', () => {
  it('does NOT invent Input / Input Type / Input Value / Calculated Amount columns', () => {
    // Those four are the ONE-OFF ledger's quantity/unit (payroll_individual_txn). A recurring item is a
    // flat amount, so there is nothing to calculate and no quantity to enter; empty columns would be
    // worse than absent ones. The sister screen documents the same refusal for the same reason.
    for (const src of [rowsSrc, detailSrc, listSrc]) {
      expect(src).not.toContain('inputType');
      expect(src).not.toContain('calculatedAmount');
      expect(src).not.toContain('inputValue');
    }
  });

  it('does NOT silently reverse ee21508c: Add still opens the modal', () => {
    // "Match Individual Transaction" could be read as making Add inline. That would undo an approved
    // decision of its own, so the modal stays and the reversal is raised rather than assumed.
    expect(listSrc).toContain('FixedToolbar');
    expect(read(FIXED, 'add-fixed-dialog.tsx')).toContain('Dialog.Root');
  });

  it('KEEPS the Payroll Cycle field the request sketch omitted', () => {
    // It is mandatory on Add, so a redesign that dropped it from view would hide a required field.
    expect(rowsSrc).toContain('cycleLabels');
    expect(detailSrc).toContain("name=\"runType\"");
  });

  it('keeps Status derived and two-valued — no draft, no pending, no "removed"', () => {
    // `ended` is computed on the SERVER against the tenant timezone (a browser either side of MYT
    // midnight would call an item ended a day early or late), and superseded rows never reach the list,
    // so "removed" can never render as a status.
    expect(listSrc).toContain('todayInKualaLumpur()');
    expect(listSrc).toContain('r.validTo != null && r.validTo < today');
    expect(rowsSrc).toContain('statusEnded');
    expect(rowsSrc).toContain('statusActive');
  });
});
