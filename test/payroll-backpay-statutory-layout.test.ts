/**
 * 6b018920 — Back Pay and Statutory Adjustment are laid out the way the rest of Payroll is.
 *
 * WHAT THE ITEM ACTUALLY WAS, because the board plan got its own premise wrong and a future round will
 * otherwise "fix" the same non-defect again. The plan said both screens "sit in the narrower page frame"
 * and leave "a large empty margin on both sides", and cited `pageWideCls 0` on each as the measurement.
 * That count was `grep -c pageWideCls` — it counts the IDENTIFIER. `pageWideCls` is defined as exactly
 * `'w-full space-y-6'` (components/ui.tsx), and BOTH pages already carried that literal string on every
 * root div. They have rendered at the full window width since they shipped. There was no width defect.
 * The same false negative would fire on any page that inlines the value, so measure the CLASS next time,
 * not the import.
 *
 * So this guard does NOT assert "the page got wider" — nothing did. It asserts the two things that were
 * genuinely inconsistent and are now fixed, plus the one thing the change could plausibly have broken:
 *
 *   1. WIDTH BY THE NAMED CONSTANT. Both pages state their width through `pageWideCls`, not a hand-written
 *      class, and neither carries a page-level `mx-auto max-w-*` cap. Two screens going full-width by two
 *      different means is how one of them silently gets a cap put back on it — the same predicate
 *      test/payroll-txn-view-full-width.dom.test.tsx and test/leave-config-full-width.test.ts use.
 *
 *   2. THE FILTER ARRANGEMENT. Every GET filter form on both screens sits in a <Card>, uses the shared
 *      <Field> for its controls and the shared <Button> to submit — the arrangement transaction-view uses.
 *
 *   3. ⚠️ THE QUERY PARAMS SURVIVED THE MOVE. This is the risk the plan named and the reason this file
 *      exists. Both screens' filters are LIVE: their `name=` attributes are URL params that feed server
 *      reads. Rename or drop one while shuffling JSX and a bookmarked `?company=…&year=…` link silently
 *      stops applying — no error, no 404, no log line, and the page still returns 200. Nothing in the
 *      type system reaches across `?foo=` → `searchParams.foo` → reader argument, so it is pinned here as
 *      source shape across BOTH files, per the contract-between-two-files rule.
 *
 *      The subtlest of these is Statutory Adjustment's State 2 hidden `batch` input. A GET form submits
 *      ONLY its own fields, so if that input were dropped the employee search would rewrite the URL to
 *      `?q=…` with no `?batch=`, the page would fall back to State 1 (pick a run), and searching would
 *      look like it "went back". Also note `company` (URL) maps to `companyId` (reader argument) — the
 *      two names differ deliberately and neither may be tidied to match the other.
 *
 * DELIBERATELY NOT ASSERTED: that app/payroll/transactions/fixed/page.tsx stays narrow. The request cited
 * it as the screen to copy and it was capped at `mx-auto max-w-[100rem]`, so "match Fixed Transaction" and
 * "full width" were two different looks; the approved plan resolved that by following transaction-view and
 * explicitly leaving Fixed Transaction alone as a possible follow-on the reporter had to ask for. Pinning
 * it narrow here would have had to be deleted the day that follow-on landed, and a guard that must be
 * deleted to make progress is the "two tests asserting opposite things" trap. The decision was recorded,
 * not enforced — AND THE FOLLOW-ON LANDED: 152fea7f standardised every Payroll screen, Fixed Transaction
 * included, onto `pageWideCls`. These two screens were already there and did not move; the note is kept
 * because it is the reason this file has no such assertion to update.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BACK_PAY = 'app/payroll/back-pay/page.tsx';
const STATUTORY = 'app/payroll/statutory-adjustment/page.tsx';
const READER = 'core/payroll.ts';
const PAGES = [BACK_PAY, STATUTORY] as const;

/** Every string-literal / template-literal className VALUE in a source file. */
const classNames = (src: string) =>
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);

/** The source of every `<form method="GET">…</form>` on a page. Server-action forms are excluded on
 *  purpose — their `name=` values are FormData keys, not URL params, and are a different contract. */
function getForms(src: string): string[] {
  const out: string[] = [];
  const open = /<form method="GET"/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) != null) {
    const end = src.indexOf('</form>', m.index);
    expect(end, 'unterminated <form method="GET">').toBeGreaterThan(m.index);
    out.push(src.slice(m.index, end));
  }
  return out;
}

/** Every `name="…"` inside a chunk of JSX, in document order, de-duplicated. */
const fieldNames = (chunk: string) => [...new Set([...chunk.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]))];

// ───────────────────────────── 1. width, by the named constant ─────────────────────────────

describe('6b018920 · both screens state their width through pageWideCls', () => {
  it.each(PAGES)('%s uses the named constant, not a hand-written width', (page) => {
    const src = read(page);
    expect(src, `${page} must import the shared constant`).toMatch(/\bpageWideCls\b[\s\S]*from '@\/components\/ui'/);
    expect(src, `${page} must open its layout with <div className={pageWideCls}>`).toContain(
      '<div className={pageWideCls}>',
    );
    // The literal the constant expands to must not linger anywhere: leaving one root div on the literal
    // and moving the others to the constant is drift that reads as consistency.
    expect(
      classNames(src).filter((c) => c.trim() === 'w-full space-y-6'),
      `${page} still inlines pageWideCls's value instead of using the constant`,
    ).toEqual([]);
  });

  it.each(PAGES)('%s carries no page-level width cap', (page) => {
    // `mx-auto` AND a `max-w-*` in ONE class string is a centred page-level cap. Inner reading measures
    // that use max-w WITHOUT mx-auto are legitimate and out of reach of this rule by construction.
    const offending = classNames(read(page)).filter((c) => /\bmx-auto\b/.test(c) && /\bmax-w-/.test(c));
    expect(offending, `${page} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual([]);
  });
});

// ───────────────────────────── 2. the filter arrangement ─────────────────────────────

describe('6b018920 · the filter rows use the transaction-view arrangement', () => {
  it.each(PAGES)('%s wraps every GET filter form in a Card and submits with the shared Button', (page) => {
    const src = read(page);
    const forms = getForms(src);
    expect(forms.length, `${page} has no GET filter form left — the filters are live, they cannot vanish`)
      .toBeGreaterThan(0);
    for (const form of forms) {
      // The submit control is the shared primitive, not a hand-rolled `<button className="rounded-lg …">`.
      expect(form, `${page}: a GET filter form still submits with a hand-rolled <button>`).toMatch(
        /<Button type="submit"/,
      );
      expect(form).not.toMatch(/<button type="submit"/);
      // Each control is labelled by the shared <Field>, not a hand-written <label><span>.
      expect(form, `${page}: a GET filter form still hand-writes its labels`).toContain('<Field label=');
      expect(form).not.toMatch(/<label className="text-sm">/);
    }
    // …and each of those forms is inside a Card. Asserted on the rendered nesting rather than by counting:
    // the Card must be the element immediately wrapping the form.
    const wrapped = [...src.matchAll(/<Card className="p-4">\s*<form method="GET"/g)].length;
    expect(wrapped, `${page}: ${forms.length} GET form(s) but only ${wrapped} wrapped in a Card`).toBe(
      forms.length,
    );
  });

  it.each(PAGES)('%s keeps every wide table inside its own horizontal scroll container', (page) => {
    const src = read(page);
    // tableWrapCls is `overflow-x-auto rounded-md border …`, so a table inside one scrolls itself rather
    // than pushing the page sideways. Every <table> on these screens must have one.
    const tables = [...src.matchAll(/<table\b/g)].length;
    const wraps = [...src.matchAll(/<div className=\{tableWrapCls\}>/g)].length;
    expect(tables, `${page} unexpectedly renders no table`).toBeGreaterThan(0);
    expect(wraps, `${page}: ${tables} table(s) but ${wraps} overflow-x wrapper(s)`).toBe(tables);
  });
});

// ───────────────────────── 3. the query params survived the move ─────────────────────────

describe('6b018920 · the live filter params are unchanged', () => {
  it('Back Pay still submits ?company= and still reads it back', () => {
    const src = read(BACK_PAY);
    const forms = getForms(src);
    expect(forms).toHaveLength(1);
    // EXACT set, not a superset: an extra field is as much a change to a bookmarked URL as a missing one.
    expect(fieldNames(forms[0]), 'Back Pay filter param renamed or dropped').toEqual(['company']);
    // The other half of the round trip — the page must actually read it off searchParams.
    expect(src).toMatch(/company\?:\s*string/);
    expect(src, 'the company filter is submitted but never read').toContain('sp.company');
    // The detail state's param, which is a Link href rather than a form field.
    expect(src).toMatch(/run\?:\s*string/);
    expect(src).toContain('sp.run');
    expect(src, 'the history "open" link must keep building ?run=').toMatch(/back-pay\?run=\$\{r\.id\}/);
  });

  it('Statutory Adjustment still submits all four run filters and still reads them back', () => {
    const src = read(STATUTORY);
    const forms = getForms(src);
    expect(forms, 'both the run-filter form and the employee-search form must still exist').toHaveLength(2);

    const [employeeSearch, runFilter] = forms[0].includes('name="q"') ? forms : [forms[1], forms[0]];

    // State 1 — the four run filters, in the order they are rendered.
    expect(fieldNames(runFilter), 'a run filter param was renamed or dropped').toEqual([
      'company',
      'year',
      'month',
      'runType',
    ]);

    // State 2 — the employee search. `batch` is the LOAD-BEARING hidden field: a GET form submits only its
    // own fields, so without it a search rewrites the URL to ?q=… with no ?batch= and the page silently
    // falls back to State 1. That failure is invisible — it returns 200 and simply looks like "it went
    // back" — which is why it is pinned by shape and not left to a render check to notice.
    expect(fieldNames(employeeSearch), 'the employee search dropped its batch context or renamed q').toEqual([
      'batch',
      'q',
    ]);
    expect(
      employeeSearch,
      'the batch field must stay a hidden input carrying the current run id',
    ).toContain('<input type="hidden" name="batch" value={run.batchId} />');

    // Every one of the seven URL params this screen understands is declared on searchParams and read.
    for (const p of ['company', 'year', 'month', 'runType', 'batch', 'employment', 'q']) {
      expect(src, `?${p}= is not declared on searchParams`).toMatch(new RegExp(`${p}\\?:\\s*string`));
      expect(src, `?${p}= is submitted or linked but never read`).toContain(`sp.${p}`);
    }
  });

  it('the page→reader mapping still holds: URL `company` feeds the reader argument `companyId`', () => {
    // The contract crosses two files, so a unit test of either half passes throughout. `company` and
    // `companyId` differ ON PURPOSE — the URL name is the reporter-visible one and the reader's is its
    // own vocabulary. Tidying either to match the other is the silent break this pins.
    const page = read(STATUTORY);
    const reader = read(READER);

    expect(page, 'the run-filter call must map sp.company → companyId').toMatch(
      /listAdjustableBatches\(s,\s*\{[\s\S]*?companyId:\s*sp\.company[\s\S]*?year:\s*sp\.year[\s\S]*?month:\s*sp\.month[\s\S]*?runType:\s*sp\.runType/,
    );
    expect(reader, 'listAdjustableBatches changed the argument names the page passes').toMatch(
      /export function listAdjustableBatches\([\s\S]*?p:\s*\{\s*companyId\?:\s*string;\s*year\?:\s*string;\s*month\?:\s*string;\s*runType\?:\s*string\s*\}/,
    );

    expect(page, 'the employee search must pass the batch id and the q term through').toMatch(
      /listAdjustmentEmployees\(s,\s*\{\s*batchId:\s*run\.batchId,\s*q:\s*sp\.q\s*\}\)/,
    );
    expect(reader, 'listAdjustmentEmployees changed the argument names the page passes').toMatch(
      /export function listAdjustmentEmployees\([\s\S]*?p:\s*\{\s*batchId:\s*string;\s*q\?:\s*string\s*\}/,
    );
  });
});
