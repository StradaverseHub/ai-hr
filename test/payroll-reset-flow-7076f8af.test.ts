/**
 * 7076f8af — "Reset Payroll Screen and Payroll Process Flow Redesign".
 *
 * The reported defect, reproduced exactly: Reset Payroll on a processed run dropped the operator on
 * `/payroll/<id>`, one long screen carrying Generate Payslips, Payroll Inputs, Import Pay Components (CSV)
 * and Payslips — and calling itself "Step 3 of 3". Two facts made it worse than a wrong link. The payslip
 * list on that screen is EMPTY at the moment you arrive, because resetting deletes the run's payslips. And
 * walking the guided flow yourself did not help: the resume path ended by handing you back to the same
 * screen, so repointing one button would have produced a loop.
 *
 * WHAT THIS FILE PINS, and why each could regress in silence:
 *
 *   1. THE DESTINATION. **REVERSED BY THE REPORTER ON ITEM 65e2d5de, AND THE CASE IS UPDATED RATHER THAN
 *      DELETED.** This round's answer was `resumeHref` — the guided run flow — and it did fix the reported
 *      defect (the run screen is empty right after a reset). The reporter then asked for the opposite:
 *      "Payroll Process → Reset Payroll → Confirm → Submit → Payroll Process". Landing inside Continue
 *      Progress is a workflow they did not ask to enter, and the LIST is where the run's new Draft status
 *      is visible. So the success redirect now composes `payrollListReturnTo` over the posted `from`.
 *      What survives from the original case, unchanged and still load-bearing, is the NEGATIVE half: it
 *      must never go back to the long run screen, which was the defect 7076f8af was raised for.
 *      Still source-asserted, because the alternative is a redirect nobody notices until an operator is
 *      standing on the wrong screen again.
 *   2. THE FLOW IS TERMINAL. resumeRunAction ends on `/payroll/process/result`, not on `/payroll/<id>`,
 *      and it goes through the same generatePayslips + summarize + encodeRunGroupResult the multi-company
 *      run uses — so the result page renders a resumed run with no change of its own.
 *   3. THE PAYLOAD a resumed run produces, built from a REAL run in the database: one company row, the
 *      engine's own payslip count, and a FAILED run reported as a reason row rather than a thrown page.
 *   4. THE TWO RELOCATED CARDS are gone from the run screen and present on their new hosts — asserted on
 *      source with COMMENTS STRIPPED, because this file's subject is a set of comments describing exactly
 *      the controls it is checking for.
 *   5. THE GUARDS. Both new routes are registered in lib/permissions.ts (reverse completeness), and the
 *      payroll fly-out gains NO row (the screens hang off the Transactions hub's cards).
 *   6. The double "Step 3 of 3" is gone, and its key with it, in all six catalogues.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createBatch, generatePayslips, resetProcessedBatch, updateBatchScope } from '../core/payroll';
import {
  decodeRunGroupResult,
  encodeRunGroupResult,
  reasonForError,
  summarize,
  type CompanyOutcome,
} from '../core/payroll-run-group';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { payrollPack } from '../packs/payroll';
import en from '../messages/en.json';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setSetting, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
/** Source with comments stripped — a comment DESCRIBING a control must never satisfy a guard for it. */
const code = (rel: string) =>
  fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAYROLL_ACTIONS = code('app/payroll/actions.ts');
const PROCESS_ACTIONS = code('app/payroll/process/actions.ts');
const RUN_SCREEN = code('app/payroll/[batchId]/page.tsx');
const HUB = code('app/payroll/transactions/page.tsx');
const WIZARD = code('app/payroll/process/wizard.tsx');
const PROCESS_PAGE = code('app/payroll/process/page.tsx');
const PANEL = code('app/payroll/adjustments-panel.tsx');
const STEP_SELECTION = code('app/payroll/process/steps/step-selection.tsx');

let icSeq = 0;
const nextIc = () => `9102020${String(10000 + icSeq++).slice(-5)}`;

async function hire(b: Base, name: string, opts: { basic?: number } = {}) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@reset.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  // A hire with NO compensation is the pre-processing BLOCKER the reporter's flow will hit most often.
  if (opts.basic != null) {
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: opts.basic,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
  }
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

describe('7076f8af — Reset lands in the run flow, and the run flow ends', () => {
  it('1. resetAction composes its success destination from payrollListAfterReset (65e2d5de reversed 7076f8af)', () => {
    // The reporter's new destination: the Payroll Process LIST, as they left it. The posted `from` is
    // untrusted, so it is whitelisted by shape rather than followed — see lib/return-to.ts.
    //
    // `payrollListAfterReset`, NOT the bare `payrollListReturnTo`, and the difference is the whole point
    // of the destination: reset is offered on PROCESSED runs only, so a "Status: Processed" filter is the
    // one the operator is most likely holding when they press it, and this action makes the run DRAFT.
    // Following the query verbatim lands them on a list the row has just dropped out of. Behaviour pinned
    // in test/payroll-draft-resume.test.ts a3; the CALL is pinned here because a helper nobody calls fixes
    // nothing.
    // r253 added `withPayrollFrom` (the action redirects now carry the selection too), so the import is
    // matched by NAME rather than as one exact line — the claim is "every destination in this file comes
    // out of the whitelist module", not "the import fits on 100 columns".
    expect(PAYROLL_ACTIONS).toMatch(
      /import \{[\s\S]*?\badjustmentReturnTo\b[\s\S]*?\bpayrollListAfterReset\b[\s\S]*?\bpayrollListReturnTo\b[\s\S]*?\bwithPayrollFrom\b[\s\S]*?\bwithQueryParam\b[\s\S]*?\} from '@\/lib\/return-to'/,
    );
    expect(PAYROLL_ACTIONS).toMatch(/const back = payrollListAfterReset\(String\(formData\.get\('from'\) \?\? ''\)\);/);
    expect(PAYROLL_ACTIONS).toMatch(/redirect\(withQueryParam\(back, 'toast', t\('resetDone'\)\)\)/);
    // The 7076f8af destination is gone with the decision it implemented — resumeHref is no longer read
    // here at all (the list row's Continue link is still its caller, in app/payroll/page.tsx).
    expect(PAYROLL_ACTIONS).not.toMatch(/resumeHref/);
    // THE ORIGINAL DEFECT, still pinned negatively and still the reason this case exists: whatever the
    // destination becomes, it must never be the long run screen whose payslip list a reset has emptied.
    expect(PAYROLL_ACTIONS).not.toMatch(/redirect\(`\/payroll\/\$\{batchId\}\?toast=\$\{encodeURIComponent\(t\('resetDone'\)\)\}`\)/);
  });

  it('1b. both reset forms post the filter selection, or the destination cannot honour it', () => {
    // The contract lives between TWO files (the form posts `from`, the action whitelists it), and a test
    // of either half alone passes while the operator loses their filters — rule 17's generalisation.
    //
    // 9f8cd608 MOVED ONE OF THE TWO FORMS, and this case follows it rather than being deleted. The LIST's
    // reset form used to sit inside the ⋯ row menu, which is a `position: fixed` panel that closes on any
    // scroll — so its ConfirmSubmit, owned by that subtree, unmounted as it opened and the button appeared
    // to do nothing. The form now lives on app/payroll/[batchId]/reset, and the list's job shrinks to
    // handing that screen the filter query as `?from=…`; the screen posts it on. The chain is asserted
    // end to end here, because a break anywhere along it costs the operator their filters just the same.
    const LIST = code('app/payroll/page.tsx');
    const RESET_SCREEN = code('app/payroll/[batchId]/reset/page.tsx');
    expect(LIST, 'the row action carries the filter query to the reset screen').toMatch(
      /href=\{`\/payroll\/\$\{b\.id\}\/reset\?from=\$\{fromQuery\}`\}/,
    );
    expect(LIST).toContain('const fromQuery = encodeURIComponent(dashboardHref(filters));');
    expect(RESET_SCREEN, 'the screen whitelists what it was handed, by shape').toContain(
      'const back = payrollListReturnTo(sp.from);',
    );
    expect(RESET_SCREEN, 'and posts it on, so payrollListAfterReset has something to honour').toContain(
      '<input type="hidden" name="from" value={from} />',
    );
    expect(RESET_SCREEN).toMatch(/<form action=\{resetAction\}/);
    expect(RUN_SCREEN).toMatch(/<form action=\{resetAction\}>/);
    expect(RUN_SCREEN).toContain('<input type="hidden" name="from" value={backHref} />');
  });

  it('2. resumeRunAction is terminal: it generates and lands on the result page, never back on the run screen', () => {
    expect(PROCESS_ACTIONS).toMatch(/export async function resumeRunAction/);
    // It calculates …
    expect(PROCESS_ACTIONS).toMatch(/await generatePayslips\(s, \{ batchId \}\)/);
    // … wraps the outcome in the EXISTING run-group shape and ends on the shared result page …
    expect(PROCESS_ACTIONS).toMatch(/summarize\(batch\.payPeriod, startedAt, new Date\(\)\.toISOString\(\), \[outcome\]\)/);
    /**
     * UPDATED BY d75b0c11, NOT WEAKENED. The destination is unchanged — `/payroll/process/result` with
     * the encoded run-group payload, which is the whole claim this line makes. What is appended is the
     * operator's filter selection, so the result screen's Back (which has read `?from=` since 9066bd6c
     * and never once received one, because a redirect is the only way onto this page) returns the
     * Payroll Process list AS IT WAS LEFT rather than to the current period.
     *
     * `resultFromSuffix` is EMPTY when nothing was carried, so a run started without a selection still
     * produces the byte-identical redirect this case used to pin. Pinning the trailing backtick would
     * forbid the fix, so the assertion moves to the prefix plus the suffix call.
     */
    expect(PROCESS_ACTIONS).toMatch(
      /redirect\(`\/payroll\/process\/result\?r=\$\{encodeRunGroupResult\(result\)\}\$\{resultFromSuffix\(formData\.get\('from'\)\)\}`\)/,
    );
    // … and the old hand-back is gone.
    expect(PROCESS_ACTIONS).not.toMatch(/redirect\(`\/payroll\/\$\{batchId\}\?from=process`\)/);
  });

  it('2b. the generation stays inside a try so a failed run renders as a reason row, not a thrown page', () => {
    const body = PROCESS_ACTIONS.slice(PROCESS_ACTIONS.indexOf('export async function resumeRunAction'));
    expect(body).toMatch(/reason: reasonForPayrollError\(e\)/);
    expect(body).toMatch(/status: 'failed'/);
  });

  it('6. the run screen no longer calls itself "Step 3 of 3", and the key is gone from every catalogue', () => {
    expect(RUN_SCREEN).not.toMatch(/fromWizard/);
    expect(RUN_SCREEN).not.toMatch(/step3Title/);
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      expect(dict.payroll.batch.step3Title, `${loc} still carries step3Title`).toBeUndefined();
    }
  });

  it('6b. the run’s terminal button is renamed to the words the wizard already uses, in all six catalogues', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      // Renamed to the EXISTING payroll.process.processPayroll wording, not to a second casing and not to
      // "Payroll Process" (which already names the menu row, the run list and the flow).
      expect(dict.payroll.batch.generatePayslips).toBe(dict.payroll.process.processPayroll);
    }
    expect(en.payroll.batch.generatePayslips).toBe('Process Payroll');
  });
});

describe('7076f8af — the two relocated cards', () => {
  it('4. both are gone from the run screen', () => {
    expect(RUN_SCREEN).not.toMatch(/ComponentImport/);
    expect(RUN_SCREEN).not.toMatch(/OtInputRow/);
    for (const action of [
      'prefillOvertimeAction',
      'prefillClaimsAction',
      'prefillLoansAction',
      'prefillShiftDifferentialAction',
      'prefillFixedZakatAction',
      'prefillTp1Action',
      'transferAllowancesAction',
    ]) {
      expect(RUN_SCREEN, `${action} still rendered on the run screen`).not.toMatch(new RegExp(action));
    }
  });

  it('4b. the adjustment panel still renders all seven bridges and the input grid — it moved, it was not deleted', () => {
    // Deleting this panel would strand approved overtime, approved claims, loan instalments, shift
    // differential, fixed zakat, declared TP1 relief and attendance allowances with no route to any
    // payslip — and nothing would warn anyone. That is why the item relocates it instead.
    for (const action of [
      'prefillOvertimeAction',
      'prefillClaimsAction',
      'prefillLoansAction',
      'prefillShiftDifferentialAction',
      'prefillFixedZakatAction',
      'prefillTp1Action',
      'transferAllowancesAction',
    ]) {
      expect(PANEL, `${action} missing from the relocated panel`).toMatch(new RegExp(action));
    }
    expect(PANEL).toMatch(/OtInputRow/);
    // Every form posts the screen it was pressed on, so the actions stop yanking the operator to the run.
    expect((PANEL.match(/name="returnTo"/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it('4c. the panel goes to TWO hosts and the CSV import to ONE — they do not travel together', () => {
    // (a) the panel: the wizard's Review step (handed down as a server-rendered NODE, never a closure) …
    expect(PROCESS_PAGE).toMatch(/<PayrollAdjustmentsPanel/);
    expect(WIZARD).toMatch(/adjustmentsPanel\?: React\.ReactNode/);
    expect(WIZARD).toMatch(/step === 2 && adjustmentsPanel/);
    // … and a screen under Transactions.
    expect(code('app/payroll/transactions/adjustments/page.tsx')).toMatch(/<PayrollAdjustmentsPanel/);
    // (b) the CSV import: Transactions ONLY. It must NOT also appear on the Review step.
    expect(code('app/payroll/transactions/import-components/page.tsx')).toMatch(/<ComponentImport/);
    expect(WIZARD).not.toMatch(/ComponentImport/);
    expect(PROCESS_PAGE).not.toMatch(/ComponentImport/);
  });

  it('4d. both are reachable from the Transactions hub cards', () => {
    expect(HUB).toMatch(/href="\/payroll\/transactions\/adjustments"/);
    expect(HUB).toMatch(/href="\/payroll\/transactions\/import-components"/);
  });
});

describe('7076f8af — Step 2 gains a search box and a Payroll Policy column', () => {
  it('3. the search is an eighth FILTER: it feeds the same filtered memo and marks the same touch flag', () => {
    expect(STEP_SELECTION).toMatch(/matchesEmployeeSearch\(e, search\)/);
    // AND-combined inside the SAME predicate as the seven selects (one `filtered` memo, not a second pass).
    const memo = STEP_SELECTION.slice(STEP_SELECTION.indexOf('const filtered'), STEP_SELECTION.indexOf('const anyFilterActive'));
    expect(memo).toMatch(/businessUnitId/);
    expect(memo).toMatch(/matchesEmployeeSearch/);
    // Typing marks the selection touched through the SAME helper the dropdowns use, so an edited
    // selection survives a search instead of being reset to the filtered view.
    expect(STEP_SELECTION).toMatch(/setSearch\(e\.target\.value\);\s*\n\s*markFilterTouch\(\);/);
    // …and a search counts as an active filter, which is what makes materializeToggle keep the edit.
    expect(STEP_SELECTION).toMatch(/search\.trim\(\)/);
  });

  it('4e. the Payroll Policy column renders per employee, with an em dash for the common empty case', () => {
    expect(STEP_SELECTION).toMatch(/payrollPolicyName \?\? '—'/);
    expect(STEP_SELECTION).toMatch(/payrollPolicyColumn/);
    // The client type MIRRORS core/read.ts's row rather than importing it (core/read pulls in db/client).
    expect(STEP_SELECTION).not.toMatch(/from '@\/core\/read'/);
  });
});

/**
 * Every key this round added, resolved by hand.
 *
 * test/i18n-coverage.test.ts check C only scans files that use a SINGLE namespace, and three of this
 * round's screens use two (step-selection.tsx, wizard.tsx, import-components/page.tsx). A key that is
 * missing there is invisible to every automated gate: MISSING_MESSAGE passes tsc, the suite and
 * `next build`, and only appears when a human opens the page. So the keys are listed here explicitly.
 * Check A then guarantees each one exists in all six catalogues.
 *
 * None of them carries an ICU brace, deliberately — a message with `{…}` read through a bare `t()`
 * THROWS at render rather than degrading, and every one of these is read through a bare `t()`.
 */
describe('7076f8af — the new copy resolves', () => {
  const NEW_KEYS = [
    ['payroll.process', 'searchLabel'],
    ['payroll.process', 'searchPlaceholder'],
    ['payroll.process', 'payrollPolicyColumn'],
    ['payroll.process', 'payrollPolicyNone'],
    ['payroll.process', 'adjustmentsTitle'],
    ['payroll.process', 'adjustmentsHint'],
    ['payroll.process', 'reason.PRE_PROCESS_BLOCKED'],
    ['payroll.transactions', 'hub.adjustmentsTitle'],
    ['payroll.transactions', 'hub.adjustmentsDesc'],
    ['payroll.transactions', 'hub.adjustmentsCta'],
    ['payroll.transactions', 'hub.componentImportTitle'],
    ['payroll.transactions', 'hub.componentImportDesc'],
    ['payroll.transactions', 'hub.componentImportCta'],
    ['payroll.transactions', 'adjustments.title'],
    ['payroll.transactions', 'adjustments.subtitle'],
    ['payroll.transactions', 'componentImport.title'],
    ['payroll.transactions', 'componentImport.subtitle'],
    ['payroll.transactions', 'draftPicker.title'],
    ['payroll.transactions', 'draftPicker.choose'],
    ['payroll.transactions', 'draftPicker.selected'],
    ['payroll.transactions', 'draftPicker.noneTitle'],
    ['payroll.transactions', 'draftPicker.noneBody'],
    ['payroll.transactions', 'draftPicker.openRuns'],
  ] as const;

  const at = (dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

  it.each(NEW_KEYS)('%s.%s resolves in every catalogue and formats without arguments', (ns, key) => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      const value = `${ns}.${key}`
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict);
      expect(typeof value, `${loc} missing ${ns}.${key}`).toBe('string');
      expect((value as string).length, `${loc} blank ${ns}.${key}`).toBeGreaterThan(0);
      // A bare t() on a message with an ICU placeholder throws at render — none of these takes arguments.
      expect(value as string, `${loc} ${ns}.${key} carries an ICU placeholder`).not.toMatch(/\{/);
    }
    expect(at(`${ns}.${key}`)).toBeTruthy();
  });

  it('the retired keys are gone from every catalogue, not merely unused', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      // "Step 3 of 3 — Review & process": the run flow is terminal, so there is no third step to be.
      expect(dict.payroll.batch.step3Title).toBeUndefined();
      // "Confirm selection & continue": the resumed run's button now processes, and says so.
      expect(dict.payroll.process.confirmSelectionAndProcess).toBeUndefined();
    }
  });
});

describe('7076f8af — guards', () => {
  it('5. both new routes are registered in lib/permissions.ts (reverse completeness)', () => {
    expect(REGISTERED_ROUTES.has('/payroll/transactions/adjustments')).toBe(true);
    expect(REGISTERED_ROUTES.has('/payroll/transactions/import-components')).toBe(true);
  });

  it('5b. the payroll fly-out gains NO row — the new screens hang off the Transactions hub cards', () => {
    const node = payrollPack.navNodes!.find((n) => n.group === 'admin')!;
    const hrefs = node.children.map((c) => c.href);
    expect(hrefs).not.toContain('/payroll/transactions/adjustments');
    expect(hrefs).not.toContain('/payroll/transactions/import-components');
    // The hub row itself is untouched, so the exact-set guard in test/payroll-flyout-nav.test.ts holds.
    expect(hrefs).toContain('/payroll/transactions');
  });
});

describe('7076f8af — the terminal resume payload, against a real run', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('3a. a reset run resumed and processed produces a one-company SUCCESS payload the result page decodes', async () => {
    const a = adminCtx(base);
    await hire(base, 'Reset Alpha', { basic: 4000 });
    await hire(base, 'Reset Beta', { basic: 3000 });

    // A processed run, then the reporter's Reset. `payroll.reset_enabled` defaults to FALSE in the
    // catalog and seedBase seeds no row, so the gate is granted for this tenant and the context is
    // re-resolved FROM THE DATABASE (`entitledCtx`) — adminCtx's synthetic snapshot is built from
    // process.env and would not see the grant. Same convention as test/payroll-reset.test.ts.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    const gated = await entitledCtx(base);
    await resetProcessedBatch(gated, { batchId, reason: 'Corrections needed' });
    const [afterReset] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(afterReset.status).toBe('draft');
    // Reset deletes the payslips — which is why the screen the reset USED to land on had an empty list.
    const slipsAfterReset = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slipsAfterReset.length).toBe(0);

    // The resume path: re-set the scope (untouched here ⇒ whole company), then calculate. This is the
    // sequence resumeRunAction performs.
    await updateBatchScope(a, { batchId, scope: { employmentIds: [] } });
    const startedAt = new Date().toISOString();
    const gen = await generatePayslips(a, { batchId });
    const payslips = 'payslips' in gen && typeof gen.payslips === 'number' ? gen.payslips : 0;
    const outcome: CompanyOutcome = {
      companyId: base.companyId,
      companyName: 'Acme',
      status: 'succeeded',
      batchId,
      employeesSelected: 2,
      employeesSucceeded: payslips,
    };
    const result = summarize('2026-05', startedAt, new Date().toISOString(), [outcome]);

    expect(result.totalCompanies).toBe(1);
    expect(result.companiesSucceeded).toBe(1);
    expect(result.overallStatus).toBe('succeeded');
    expect(result.totalEmployeesSelected).toBe(2);
    expect(result.totalEmployeesSucceeded).toBe(2);
    expect(result.totalEmployeesFailed).toBe(0);

    // The one-shot transport survives the redirect the action performs.
    const decoded = decodeRunGroupResult(encodeRunGroupResult(result));
    expect(decoded).not.toBeNull();
    expect(decoded!.perCompany).toHaveLength(1);
    expect(decoded!.perCompany[0].batchId).toBe(batchId);
    expect(decoded!.perCompany[0].status).toBe('succeeded');
  });

  it('3b. a run that cannot be processed comes back as a REASON ROW with a name the operator can act on', async () => {
    const a = adminCtx(base);
    await hire(base, 'Paid Person', { basic: 4000 });
    await hire(base, 'No Salary Person'); // no compensation row at all — the pre-processing blocker

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const startedAt = new Date().toISOString();

    // Exactly what resumeRunAction's try/catch does with the throw.
    let outcome: CompanyOutcome;
    try {
      await generatePayslips(a, { batchId });
      outcome = {
        companyId: base.companyId,
        companyName: 'Acme',
        status: 'succeeded',
        batchId,
        employeesSelected: 2,
        employeesSucceeded: 2,
      };
    } catch (e) {
      outcome = {
        companyId: base.companyId,
        companyName: 'Acme',
        status: 'failed',
        batchId,
        employeesSelected: 2,
        employeesSucceeded: 0,
        reason: reasonForError((e as Error).message),
      };
    }

    expect(outcome.status).toBe('failed');
    // Not the catch-all: the blocker is named, and the result page has copy for that name.
    expect(outcome.reason).toBe('PRE_PROCESS_BLOCKED');
    expect(en.payroll.process.reason.PRE_PROCESS_BLOCKED).toBeTruthy();

    const result = summarize('2026-05', startedAt, new Date().toISOString(), [outcome]);
    expect(result.overallStatus).toBe('failed');
    expect(result.totalEmployeesFailed).toBe(2);

    // Fail-closed: a blocked run writes NOTHING and stays a draft, so the operator can fix and retry.
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slips.length).toBe(0);
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(row.status).toBe('draft');
  });
});
