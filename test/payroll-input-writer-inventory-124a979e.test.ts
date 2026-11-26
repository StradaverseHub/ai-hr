/**
 * Board 124a979e (plan item 10) — THE PAYROLL INPUT WRITER INVENTORY.
 *
 * Every place that saves a payroll input must flag the processed runs it makes stale (Reprocess Required), or the
 * change sits under a run that still looks settled: the CP38, fixed item, Zakat, tax and payroll policy gaps this item
 * closed were each a writer nobody had listed. This test lists them. It parses core/, localization/ and packs/ and
 * finds every write to the tables (and the one column) the payroll engine reads as an employee's inputs:
 *   employee_cp38, employment_pay_component, compensation, employee_statutory_my, payroll_individual_txn,
 *   employment_tax_selection_my, tp1_relief, employee_tp3, and employment.payroll_policy_id
 * through drizzle (`.insert(t)` / `.update(t)` / `.delete(t)`) or raw SQL (`insert into` / `update` / `delete from`).
 *
 * Each write must sit in a top-level function that calls a mark helper (MARKERS below), or appear on the reviewed
 * EXEMPT list with the reason it needs none. A new writer that does neither fails here, before release. An exemption
 * whose writer no longer exists fails too, so the list only describes what is there.
 *
 * Static: it proves a writer CALLS a marker, not that the mark is right. The behaviour is pinned by the owners'
 * tests (test/change-detect-124a979e.test.ts, test/3244584c-reprocess-eligibility.test.ts and the rest).
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TABLES: Record<string, string> = {
  employeeCp38: 'employee_cp38', employmentPayComponent: 'employment_pay_component', compensation: 'compensation',
  employeeStatutoryMy: 'employee_statutory_my', payrollIndividualTxn: 'payroll_individual_txn',
  employmentTaxSelectionMy: 'employment_tax_selection_my', tp1Relief: 'tp1_relief', employeeTp3: 'employee_tp3',
};
const RAW = new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?(${Object.values(TABLES).join('|')})\\b`, 'i');
const RAW_POLICY = /update\s+(public\.)?employment\s+(\w+\s+)?set[^;]*payroll_policy_id/i;

/** The mark helpers, and the owner wrappers that call them (each wrapper's own body calls one of the helpers). */
const MARKERS = [
  'markRunsAffectedByEmploymentChangeTx', 'markRunsAffectedByEmploymentWindowsTx', 'markBatchNeedsRecalc', 'markBatchesNeedRecalcTx',
  'markHistoryAffectedPayrollTx', 'markRunsAffectedByPayComponentTx', 'markWorkforcePayrollInputsChangedTx',
  'withMovementPayrollWindowsTx', // core/workforce-payroll-invalidation.ts: the Movement planner's window mark
  'markPayrollRunsForCompensationTx', 'markPayrollRunsForCompensationSetTx', // core/comp.ts
  'markPayrollRunsForEmploymentChangeTx', // core/org.ts
  'markFixedItemWindowsTx', // core/pay-components.ts (124a979e)
  'markTp3YearsTx', // core/tp3.ts (124a979e)
  'finishStatutoryProfileWriteMYTx', // localization/my/statutory.ts (3244584c / 124a979e)
  'markWindowsTx', // core/cp38.ts (038c304b / bc6b5490): the CP38 writers' category 'cp38' mark
];

/** `file#function#table` → why this writer needs no mark of its own. Reviewed 26 Nov 2026 (124a979e). */
const EXEMPT: Record<string, string> = {
  'core/back-pay.ts#cancelBackPayRun#payroll_individual_txn': 'back pay is cancelled only while its target run is a DRAFT (no payslip to be stale)',
  'core/payroll-individual-txn.ts#insertIndividualTxnsTx#payroll_individual_txn': 'back pay posting: the caller asserts the target run is DRAFT before inserting',
  'core/payroll-processing-job.ts#discardRun#payroll_individual_txn': 'payroll kernel bookkeeping: discarding a processing job releases the rows it attached',
  'core/payroll.ts#markIndividualTxnsConsumed#payroll_individual_txn': 'payroll kernel bookkeeping: processing stamps the rows it paid',
  'core/payroll.ts#releaseIndividualTxnsConsumed#payroll_individual_txn': 'payroll kernel bookkeeping: reprocess/removal releases rows a payslip no longer pays',
  'core/payroll.ts#teardownDraftChildren#payroll_individual_txn': 'draft teardown detaches rows from a DRAFT run (no payslip to be stale)',
  'packs/payroll/individual-calculation.ts#repriceIndividualLedgerTx#payroll_individual_txn': 'processing-time repricing inside the run being computed; it returns what moved to the run owner',
  'core/movement-history.ts#alignHistoryStartTx#compensation': 'join-date alignment of the first salary record; owned by the movement / information-correction lanes (not reviewed by 124a979e)',
  'core/movement.ts#undoSalaryAfterClosedPayrollTx#compensation': 'movement undo: the Movement planner marks the movement windows (withMovementPayrollWindowsTx)',
  'core/movement.ts#reverseLegTx#employment.payroll_policy_id': 'movement company-transfer reversal: the Movement planner marks the movement windows (withMovementPayrollWindowsTx)',
  'core/pdpa.ts#erasePersonPiiTx#employee_statutory_my': 'PDPA erasure nulls identity/bank PII columns, none of which the payroll calculation reads',
  'core/tax-relief.ts#saveTp1DraftForPersonId#tp1_relief': 'a TP1 draft never feeds payroll; approval (decide) marks',
  'core/tax-relief.ts#submitTp1ForPersonId#tp1_relief': 'a submitted TP1 never feeds payroll until approved; approval (decide) marks',
  'core/tp3.ts#savePreparedTp3Tx#employee_tp3': 'the TP3 form row; payroll reads its projection, marked by projectSeedOntoStatutory',
  'core/tp3.ts#deleteTp3#employee_tp3': 'the TP3 form row; withdrawing its projection is marked by clearProjectionForYear',
  'localization/my/statutory.ts#setBankProfileMY#employee_statutory_my': 'bank and payee columns only; the payroll calculation reads none of them',
  'localization/my/statutory.ts#setIcProfileMY#employee_statutory_my': 'IC numbers only; no calculation input',
  'localization/my/statutory.ts#setPassportProfileMY#employee_statutory_my': 'passport identity only; no calculation input',
  'localization/my/statutory.ts#setRegistrationNumbersMY#employee_statutory_my': 'EPF/SOCSO/tax registration numbers only; no calculation input',
  'localization/my/statutory.ts#setOthersStatutoryMY#employee_statutory_my': 'HRDF subject flag: outside 124a979e scope (not a 3244584c statutory recalc field); review separately',
  'localization/my/statutory.ts#correctAccidentalHrdfOptOutsMY#employee_statutory_my': 'HRDF opt-out repair script: outside 124a979e scope; review separately',
  'localization/my/tax-selection.ts#initialize#employment_tax_selection_my': 'creates the first selection row for an employment from its existing state (no change of scheme)',
  'localization/my/tax-selection.ts#initializeHiredTaxSelectionMYTx#employment_tax_selection_my': 'a new hire has no processed run to be stale',
  'localization/my/tax-selection.ts#initializeTransferredTaxSelectionMYTx#employment_tax_selection_my': 'company transfer seeds the destination selection; the transfer itself marks (category transfer)',
};

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return sources(rel);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name) ? [rel] : [];
  });
}

type Site = { key: string; marks: boolean };
function inventory(): Site[] {
  const out = new Map<string, Site>();
  for (const file of ['core', 'localization', 'packs'].flatMap(sources)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!/insert|update|delete/i.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    // The TOP-LEVEL function (or top-level const) holding the write: a writer's inner `run` closure belongs to it.
    const owner = (n: ts.Node): [string, ts.Node] => {
      let best: [string, ts.Node] = ['<module>', sf];
      for (let p = n.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name && p.parent === sf) best = [p.name.text, p];
        else if (ts.isVariableStatement(p) && p.parent === sf) best = [p.declarationList.declarations[0].name.getText(sf), p];
      }
      return best;
    };
    const visit = (n: ts.Node) => {
      let table: string | null = null;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.arguments.length === 1 && ts.isIdentifier(n.arguments[0])) {
        const verb = n.expression.name.text, arg = n.arguments[0].text;
        if (['insert', 'update', 'delete'].includes(verb) && TABLES[arg]) table = TABLES[arg];
        if (!table && verb === 'update' && arg === 'employment' && ts.isPropertyAccessExpression(n.parent) && n.parent.name.text === 'set'
          && ts.isCallExpression(n.parent.parent) && /payrollPolicyId/.test(n.parent.parent.arguments[0]?.getText(sf) ?? '')) table = 'employment.payroll_policy_id';
      }
      if (!table && (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n))) {
        const t = n.getText(sf);
        const m = t.match(RAW);
        if (m) table = m[3].toLowerCase();
        else if (RAW_POLICY.test(t)) table = 'employment.payroll_policy_id';
      }
      if (table) {
        const [fn, node] = owner(n);
        const body = node.getText(sf);
        const key = `${file.split(path.sep).join('/')}#${fn}#${table}`;
        const marks = MARKERS.some((m) => body.includes(`${m}(`));
        const prior = out.get(key);
        out.set(key, { key, marks: (prior?.marks ?? true) && marks });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

describe('124a979e — every payroll input writer marks the runs it makes stale', () => {
  const sites = inventory();

  it('finds the writers (a scan that finds nothing proves nothing)', () => {
    expect(sites.length).toBeGreaterThan(40);
    for (const key of [
      'core/pay-components.ts#writeEmploymentPayComponent#employment_pay_component',
      'localization/my/statutory.ts#setTaxProfileMY#employee_statutory_my',
      'core/payroll-policy.ts#assignPolicy#employment.payroll_policy_id',
      'core/tax-relief.ts#decide#tp1_relief',
      'core/cp38.ts#setCp38#employee_cp38',
    ]) expect(sites.map((s) => s.key)).toContain(key);
  });

  it('each writer calls a mark helper or is on the reviewed exemption list with a reason', () => {
    const unmarked = sites.filter((s) => !s.marks && !EXEMPT[s.key]).map((s) => s.key);
    expect(unmarked, 'a payroll input writer that neither marks nor is reviewed').toEqual([]);
    for (const [key, reason] of Object.entries(EXEMPT)) expect(reason.length, key).toBeGreaterThan(20);
  });

  it('the exemption list names only writers that exist and do not mark (it only shrinks)', () => {
    const unmarked = new Set(sites.filter((s) => !s.marks).map((s) => s.key));
    expect(Object.keys(EXEMPT).filter((key) => !unmarked.has(key))).toEqual([]);
  });

  it('the CP38 writers mark their own runs (integrated with the CP38 lane, 26 Nov 2026)', () => {
    const cp38 = sites.filter((s) => s.key.startsWith('core/cp38.ts#') && s.key.endsWith('#employee_cp38'));
    expect(cp38.map((s) => s.key)).toEqual(expect.arrayContaining([
      'core/cp38.ts#deleteCp38#employee_cp38', 'core/cp38.ts#setCp38#employee_cp38',
      'core/cp38.ts#terminateCp38#employee_cp38', 'core/cp38.ts#updateCp38#employee_cp38',
    ]));
    expect(cp38.filter((s) => !s.marks).map((s) => s.key)).toEqual([]);
  });
});
