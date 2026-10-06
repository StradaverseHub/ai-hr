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
    // 4fffe638 — the Edit page's cycle field moved into a client island (cycle-select.tsx) so it can
    // carry the hidden cycleTouched flag, and it now posts a CONFIGURED cycle id, not a run type. Both
    // halves of the contract are pinned: the page renders the island, the island posts both fields.
    const cycleSelectSrc = read(FIXED, 'cycle-select.tsx');
    expect(detailSrc).toContain('<FixedCycleSelect');
    expect(cycleSelectSrc).toContain('name="payrollCycleId"');
    expect(cycleSelectSrc).toContain('name="cycleTouched"');
    expect(actionsSrc).toContain("formData.get('cycleTouched')");
    expect(read(FIXED, 'add-fixed-dialog.tsx')).toContain('name="payrollCycleId" required');
    // The Add list is the employee's OWN company's ACTIVE configured cycles.
    expect(listSrc).toContain('listPayrollCycles(s, selectedEmp.companyId, { activeOnly: true })');
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

/**
 * 009c8a37 — THE HIDE/SHOW CONTROL MOVES ONTO THE DETAIL HEADER LINE, on every screen that carries the
 * employee panel. This file already owns the shell's other structural guard (the no-callback rule above),
 * so the layout contract lives beside it rather than in a seventh place.
 *
 * These are source assertions, and the reason is that the three things that can break are all STRUCTURAL:
 * which branch a node is rendered in, which grid the collapsed state uses, and whether every consumer
 * passes the fallback. jsdom would render them; it computes no layout, so it could not tell you that the
 * collapsed grid still holds 16px back — only that a div exists.
 */
describe('009c8a37 — one header line, in both panel states, on every screen with the panel', () => {
  const SCREENS: readonly [string, string][] = [
    ['Loans', join(__dirname, '..', 'app', 'admin', 'loans', 'page.tsx')],
    ['Individual Payslip', join(__dirname, '..', 'app', 'payroll', 'individual-payslip', 'page.tsx')],
    ['Transaction View', join(__dirname, '..', 'app', 'payroll', 'transaction-view', 'page.tsx')],
    ['Fixed Transaction', join(FIXED, 'page.tsx')],
    ['Individual Transaction', join(INDIVIDUAL, 'txn-workspace.tsx')],
    ['TP1 Relief', join(__dirname, '..', 'app', 'payroll', 'transactions', 'tp1', 'page.tsx')],
    ['Zakat', join(__dirname, '..', 'app', 'payroll', 'transactions', 'zakat', 'page.tsx')],
  ];

  /** The shell's JSX, from its `return (` to the end of the component. */
  const shellBody = panelSrc.slice(panelSrc.indexOf('}) {'), panelSrc.indexOf('/**\n * One employee row'));

  it('the toggle is no longer a sibling of the employee list — it is in the detail header row', () => {
    // It used to be the FIRST CHILD of the left column, which pushed the list down by its own height
    // (~38px) while the detail card beside it still started at the container top. That offset IS the
    // card-top mismatch the reporter marked in red.
    const panelBranch = shellBody.slice(shellBody.indexOf('{open && '), shellBody.indexOf('<div className="min-w-0 space-y-4">'));
    expect(panelBranch, 'the expanded branch renders the list and nothing else').not.toContain('<button');
    expect(panelBranch).toContain('{panel}');
  });

  it('the collapsed rail is gone AND the collapsed grid drops to a single column', () => {
    // Deleting the rail is not sufficient on its own: an empty auto column plus gap-4 still held 16px
    // back from the detail. The rail's lg:w-10 (40px) plus that gap is the "use the full available
    // width" requirement. (The cap this was originally measured against, `max-w-[100rem]`, is gone —
    // 152fea7f put every Payroll screen on `pageWideCls`, so collapsing now reaches the window edge.
    // That makes the rule below matter MORE, not less: there is no cap left to hide the 56px.)
    expect(panelSrc, 'no vertical rail caption').not.toContain('writing-mode:vertical-rl');
    expect(panelSrc, 'no 40px strip').not.toContain('lg:w-10');
    expect(panelSrc, 'no empty auto column while collapsed').not.toContain('lg:grid-cols-[auto_');
    expect(shellBody, 'collapsed is ONE column, with no left cell rendered at all').toContain('lg:grid-cols-1');
    expect(shellBody).toContain('{open && <div className="min-w-0">{panel}</div>}');
  });

  it('the prop that fed the rail is gone from the shell AND from both screens that passed it', () => {
    expect(panelSrc).not.toContain('collapsedTitle');
    for (const [name, file] of SCREENS) {
      expect(read(file), `${name} must not pass a prop that no longer exists`).not.toContain('collapsedTitle');
    }
  });

  it('renders the header row UNCONDITIONALLY, falling back to the screen name with nobody selected', () => {
    // ALL SEVEN consumers draw no header at all before a person is picked — which is the state the
    // reporter photographed. A row that only appears once someone is selected would leave the control
    // missing on every one of them.
    const headerRow = shellBody.slice(shellBody.indexOf('<Card'), shellBody.indexOf('{children}'));
    expect(headerRow).toContain('detailHeader ?? ');
    expect(headerRow).toContain('{title}');
    expect(headerRow, 'the row is not wrapped in a selection test').not.toContain('&&');
  });

  it('every one of the seven consumers passes the no-selection fallback', () => {
    for (const [name, file] of SCREENS) {
      const src = read(file);
      expect(src, `${name} mounts the shell`).toContain('CollapsibleEmployeePanel');
      expect(src, `${name} must pass title=, or its control vanishes with nobody selected`).toMatch(/\btitle=\{/);
      expect(src, `${name} must lift its header into detailHeader`).toMatch(/\bdetailHeader=\{/);
    }
  });

  it('renders the toggle TWICE — the mobile copy survives collapse', () => {
    // THE TRAP. Below lg the grid stacks in DOM order, so a toggle living only in the detail header lands
    // UNDER the whole employee list; and a toggle rendered only "above the panel" DISAPPEARS the moment
    // you collapse, because the panel branch is not rendered in that state. So there are two copies —
    // and the mobile one is OUTSIDE the `{open && …}` branch, which is what makes it survive.
    expect(shellBody.match(/toggleButton\(/g) ?? [], 'exactly two positions').toHaveLength(2);
    const mobile = shellBody.indexOf('<div className="lg:hidden">{toggleButton(');
    const panelBranch = shellBody.indexOf('{open && ');
    expect(mobile, 'the narrow-viewport copy exists').toBeGreaterThan(-1);
    expect(mobile, 'and it is rendered BEFORE the panel branch, in both states').toBeLessThan(panelBranch);
    expect(shellBody, 'the wide-viewport copy lives in the header row').toContain("toggleButton('hidden shrink-0 lg:flex')");
    // One handler, one cookie key, so the two copies cannot disagree about the state.
    expect((panelSrc.match(/const toggle = \(\) => \{/g) ?? []).length).toBe(1);
  });

  it('carries print:hidden onto the toggle in BOTH positions', () => {
    // A real shipped bug: a stray "Hide employee list" line printed above a payslip letterhead. Both
    // copies come from ONE factory, so the class cannot be on one and not the other — assert that.
    const factory = panelSrc.slice(panelSrc.indexOf('const toggleButton'), panelSrc.indexOf('return ('));
    expect(factory).toContain('print:hidden');
    // …and the header ROW itself is print-hidden on the one screen whose output is a printed payslip.
    expect(read(join(__dirname, '..', 'app', 'payroll', 'individual-payslip', 'page.tsx'))).toContain(
      'headerClassName="print:hidden"',
    );
  });

  it('says out loud that it reverses the rail decision, so the next reader does not revert it', () => {
    // The deleted comment argued the rail "keeps the control in the same place on the page rather than
    // moving it into the workspace header". The answer is that the control is now in the header in BOTH
    // states, which is strictly more stable — and that has to be written down, not just done.
    expect(panelSrc).toMatch(/REVERSES A DOCUMENTED DECISION/);
  });
});
