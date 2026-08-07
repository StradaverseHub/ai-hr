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
    expect(PAGE).toMatch(/const TABS = \['fixed', 'individual', 'history', 'grid', 'outstanding'\] as const;/);
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
    expect(TABLE).toContain('<SubLines lines={b.componentsByBucket.wage}');
    expect(TABLE).toContain('<SubLines lines={b.componentsByBucket.ot}');
    expect(TABLE).toContain('<SubLines lines={b.componentsByBucket.bonus}');
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
