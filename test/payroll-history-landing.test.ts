/**
 * 862ed0ad — Transaction View opens on History, and the History breakdown stops asserting something false.
 *
 * Two changes, and the guard for each is about the way it could hurt someone:
 *
 *   1. THE LANDING TAB. Making History the default is one line; making it SAFE was not. The read behind it
 *      was unbounded — every payslip in scope for all time, statutory blob and all — so the approved plan
 *      made bounding a precondition rather than a follow-up. The cap itself is proved against the database
 *      in test/payroll-view.test.ts; what is proved here is that the PAGE uses it, and reports it.
 *
 *   2. THE ITEMISED SECTION. It borrowed the employee payslip's "Recorded items (no cash impact)" heading
 *      and the note "these do not affect your gross or net pay". True for ADR-0025 record-only BIKs; false
 *      since f1564110 Phase 3 merged consumed one-off transactions into the same array. On the screen whose
 *      whole purpose is verification, a heading that misdescribes half the list is worse than no heading.
 *
 * Source-text checks over the server page + client table, the house idiom for module-private structure.
 * Comments are stripped first: a comment RECORDING this change must never be what satisfies a guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGE = code('app/payroll/transaction-view/page.tsx');
const TABLE = code('app/payroll/transaction-view/history-table.tsx');
/** 417d4937 — the derivation behind the table: which buckets make up the Allowances itemisation. */
const BREAKDOWN = code('app/payroll/transaction-view/history-breakdown.ts');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

describe('862ed0ad — History is the tab that opens', () => {
  it('the no-tab default is history', () => {
    expect(PAGE).toMatch(/TABS\.includes\(sp\.tab as Tab\)\s*\?\s*\(sp\.tab as Tab\)\s*:\s*'history'/);
  });

  it('every tab is still reachable by ?tab=, so saved links keep working', () => {
    // Changing the DEFAULT must not narrow the set. A link to ?tab=fixed or ?tab=outstanding — the money
    // that never got paid — has to keep resolving.
    // 080de5cf added 'grid' (the spreadsheet view of the same History data) as a fifth sub-tab. This
    // assertion is exact on purpose: a tab quietly REMOVED breaks saved links, which is the failure it
    // guards, so it is updated deliberately when one is added rather than loosened to a subset match.
    //
    // 6b4ca488 UPDATES IT — it does not relax it — for a SIXTH sub-tab, 'statutory': the working behind
    // EPF, SOCSO, EIS, SKBBK, HRDF and PCB for one payslip, rendered by the same component
    // /payroll/statutory-detail renders. Inserted after 'history' because that is where it sits in the
    // strip; the five tokens that were here are all still present and in their original order, which is
    // the property that keeps every saved ?tab= link resolving.
    expect(PAGE).toMatch(
      /const TABS = \['fixed', 'individual', 'history', 'statutory', 'grid', 'outstanding'\] as const;/,
    );
    // …and the default is UNCHANGED by the addition: History still opens, which is 862ed0ad's point.
    expect(PAGE).toMatch(/: 'history';/);
  });
});

describe('862ed0ad — the landing read is bounded, and says when it bounded something', () => {
  it('the page passes a cap to the History read', () => {
    expect(PAGE).toContain('HISTORY_ROW_CAP');
    expect(PAGE, 'the cap must reach the query, not just the render').toMatch(
      /listProcessedPayslipsAcross\(s, \{[^}]*limit: HISTORY_ROW_CAP \+ 1[^}]*\}\)/,
    );
  });

  it('asks for one row more than it shows, so truncation is detected rather than assumed', () => {
    expect(PAGE).toMatch(/historyRows\.length > HISTORY_ROW_CAP/);
    expect(PAGE).toMatch(/slice\(0, HISTORY_ROW_CAP\)/);
  });

  it('tells the operator when results were cut off', () => {
    // A silent truncation on a verification screen is the failure this exists to prevent: the reader would
    // conclude a payslip does not exist rather than that it is off the end of the list.
    expect(PAGE).toContain("t('view.history.capped'");
    for (const loc of LOCALES) {
      const history = JSON.parse(read(`messages/${loc}.json`)).payroll.transactions.view.history as Record<string, string>;
      expect(history.capped, `view.history.capped missing from ${loc}.json`).toBeTruthy();
      expect(history.capped, `${loc}.json capped must name the cap`).toContain('{cap}');
    }
  });

  it('the report/export caller is NOT capped', () => {
    // core/report-registry.ts pulls the same read for the payroll reports. Clipping THAT would silently
    // produce a short statutory export, which is a far worse failure than a slow screen.
    expect(code('core/report-registry.ts')).not.toContain('limit:');
  });
});

describe('862ed0ad — the itemised section no longer claims "no cash impact"', () => {
  it('the History breakdown uses its own heading and note, not the payslip’s', () => {
    expect(TABLE).toContain("t('view.history.itemsHeading')");
    expect(TABLE).toContain("t('view.history.itemsNote')");
    // Scoped to the two keys that carried the false claim — NOT to the `tSlip` helper, which the section
    // labels above it still legitimately use.
    expect(TABLE, 'still borrowing the payslip heading').not.toContain("tSlip('recordLinesHeading')");
    expect(TABLE, 'still borrowing the payslip note').not.toContain("tSlip('recordLinesNote')");
  });

  /**
   * SUPERSEDED BY 862ed0ad step 2 (r95). This test used to assert the screen says recurring pay items
   * CANNOT be broken out. That was true and worth stating when r91 shipped — there was no stored detail.
   * The kernel now stamps it at generate time, so the screen itemises instead, and the note survives only
   * for runs calculated before the stamp. Asserting the old claim would now pin a statement the product
   * has outgrown.
   */
  it('itemises the figures, and keeps the honest note only for runs that predate the stamp', () => {
    // 417d4937 — UPDATED, NOT DELETED. The Allowances sub-lines were pinned to `componentsByBucket.wage`
    // ALONE, and that is precisely the decision this item reverses: a PCB-exempt allowance (A0040 MEAL
    // ALLOWANCE) is stamped into the `reimburse` bucket, is paid, and is inside the very figure these
    // lines sit under — so itemising `wage` only made it the one allowance with no name on this screen.
    // The claim being pinned is unchanged in kind (the Allowances figure IS itemised from the stamp);
    // only which buckets feed it moved, into `allowanceLines` so both consumers of the derivation get the
    // same list. The `ot` and `bonus` pins below are untouched.
    expect(TABLE).toContain('<SubLines lines={b.allowanceLines}');
    // UPDATED AGAIN, NOT DELETED — and for the third time the claim is unchanged in kind. Which buckets
    // feed the figure is still pinned below; what moved is that the list now goes through the SAME
    // reconciliation gate as Overtime and Bonus, so the one remaining list able to print rows that do not
    // add up to the total above them no longer can. Both halves are asserted: drop either and the guard
    // stops describing the code.
    expect(BREAKDOWN, 'the allowance lines are wage + the PCB-exempt reimburse bucket').toContain(
      '[...byBucket.wage, ...byBucket.reimburse]',
    );
    expect(BREAKDOWN, 'and they are reconciled against the Allowances figure before being handed out').toContain(
      'allowanceLines: reconciled([...byBucket.wage, ...byBucket.reimburse], allowanceNet)',
    );
    // 6b134681 — UPDATED, NOT DELETED, for the same reason as the allowance pin above. The claim is
    // unchanged in kind — Overtime and Bonus ARE itemised from the stamp — but the source moved from the
    // raw kernel bucket to the RECONCILED list, because the figure beside the label is the DISPLAY box
    // (3c473773) and the bucket is the statutory routing. An item declared into the Overtime box but
    // routed to `bonus` printed an itemised row under a zero Bonus total; pinning the raw bucket would
    // pin that. All four payroll result surfaces (this grid, Individual Payslip, the ESS payslip and the
    // printed PDF) now apply the same `payItemLinesReconcile` rule.
    expect(TABLE).toContain('<SubLines lines={b.overtimeLines}');
    expect(TABLE).toContain('<SubLines lines={b.bonusLines}');
    expect(BREAKDOWN, 'the ot/bonus lines are handed out only when they reconcile').toContain(
      'overtimeLines: reconciled(byBucket.ot, disp.overtime)',
    );
    expect(BREAKDOWN).toContain('bonusLines: reconciled(byBucket.bonus, disp.bonus)');
    expect(BREAKDOWN, 'and “reconciled” is the shared predicate, not a local re-implementation').toContain(
      'payItemLinesReconcile(lines, total) ? lines : []',
    );
    // 6b134681 — and every one of those lines is labelled by the PAY ITEM (code + description), not by
    // the box it landed in. The reporter's "B0001 — ANGPOW" read as "Bonus" for exactly this reason.
    expect(TABLE).toContain('payItemLabel(l)');
    // The note is CONDITIONAL on there being nothing stored — not shown beside a breakdown that exists.
    expect(TABLE).toContain("b.detailNotRecorded && b.allowanceNet > 0");
    expect(TABLE).toContain("t('view.history.detailNotRecorded')");
    expect(TABLE, 'the superseded claim is gone').not.toContain('allowanceNotItemised');
  });

  it('the three new keys exist in all six catalogs', () => {
    for (const loc of LOCALES) {
      const history = JSON.parse(read(`messages/${loc}.json`)).payroll.transactions.view.history as Record<string, string>;
      for (const key of ['itemsHeading', 'itemsNote', 'detailNotRecorded']) {
        expect(history[key], `view.history.${key} missing from ${loc}.json`).toBeTruthy();
      }
    }
  });

  it('the employee-facing payslip is deliberately untouched', () => {
    // Same defective wording, different screen and different audience. It is reported, not fixed in
    // passing — an ESS copy change is not what this item approved, and quietly editing what an employee
    // reads about their own pay is not a side effect worth taking.
    expect(code('app/me/payslip/[payslipId]/page.tsx')).toContain("recordLinesHeading");
    for (const loc of LOCALES) {
      const payslip = JSON.parse(read(`messages/${loc}.json`)).me.payslip as Record<string, string>;
      expect(payslip.recordLinesHeading, `me.payslip.recordLinesHeading removed from ${loc}.json`).toBeTruthy();
    }
  });

  it('renders each stored line once, keyed so two items sharing a code both show', () => {
    // The list is keyed by code alone before this change. Two one-off deductions against the same pay item
    // in one month share a code, and React would drop one — losing money from a breakdown whose whole job
    // is to account for the total beside it.
    expect(TABLE).toMatch(/key=\{`\$\{l\.code\}-\$\{i\}`\}/);
  });
});
