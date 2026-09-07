/**
 * e440991b (plan revision 2) — THE ROUTE INTO REPROCESSING, and the account of what it did.
 *
 * The reporter's rejection was not about the calculation. On production `payroll_reprocess_job` holds
 * 35 completed jobs across 10 runs, the most recent this week, and 25 of them corrected exactly one
 * person: the engine works and is in weekly use. What was missing was the way in — the selection panel
 * sat at the very BOTTOM of the 1,286-line payroll run screen, below the Recalculation History card,
 * and the Payroll Process list had no reprocess action at all.
 *
 * WHAT THIS FILE PINS, and why each one could regress silently:
 *
 *   1. The list row offers Reprocess for a PROCESSED run and only with multi-cycle on. The gate is
 *      source-asserted because the alternative — an action the destination refuses — is exactly the
 *      dead end the ticket was about.
 *   2. `reprocessEligibility` refuses a draft run, a closed run, a closed pay period and a caller
 *      without payroll.reprocess.selective, AND `reprocessSelectedEmployees` refuses the same caller.
 *      That pairing is the point: the page's refusal is a SECOND SURFACE, never the guard, so both
 *      halves are asserted and the service half is asserted on the error it actually throws.
 *   3. An employment id belonging to another company, posted to the action, selects NOTHING. This is
 *      the assertion that keeps the new screen from becoming a way to widen a run by editing a form.
 *   4. The results panel's net-before/net-after come from the STORED snapshots the run wrote at the
 *      time, not from a fresh calculation — proven on the case where the two would disagree.
 *   5. No poller. `reprocessSelectedEmployees` enqueues AND runs inline, so a percentage bar over
 *      /api/payroll/reprocess-job would be drawing a background worker that does not exist.
 *   6. The idempotency token is minted ONCE PER MOUNT and the review step does not remint it — a
 *      double confirm must reuse the job, not enqueue a second one.
 *
 * Page-level assertions are source-text checks (the house idiom for server components — cf.
 * test/payroll-run-screen-e440991b.test.ts); everything about refusals and figures runs against a real
 * run in the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  PayrollPermissionDeniedError,
  createBatch,
  generatePayslips,
  getReprocessJob,
  reprocessEligibility,
  reprocessSelectedEmployees,
} from '../core/payroll';
import { setPayrollPermissionGrant } from '../core/payroll-permissions-admin';
import { listRecomputeDisclosure } from '../core/payroll-view';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
/** Source with comments stripped — a comment DESCRIBING a control must never satisfy a guard for it. */
const code = (rel: string) =>
  fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const LIST_PAGE = code('app/payroll/page.tsx');
const RUN_PAGE = code('app/payroll/[batchId]/page.tsx');
const REPROCESS_PAGE = code('app/payroll/[batchId]/reprocess/page.tsx');
const REPROCESS_FORM = code('app/payroll/[batchId]/reprocess/reprocess-form.tsx');
const ACTIONS = code('app/payroll/actions.ts');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')) as Record<string, never>;
const msg = (dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN);

describe('e440991b — every message key the new screens read actually exists', () => {
  /**
   * A 200 IS NOT A RENDER CHECK. `MISSING_MESSAGE` passes tsc, passes the suite and passes `next build`
   * — r134 shipped a screen reading a namespace that never had its keys and every page rendered the key
   * name to the operator. test/i18n-coverage.test.ts check C cannot help here: it skips any file that
   * reads more than one namespace, and the new page deliberately reads TWO (payroll.batch for its own
   * copy, payroll.list for the six summary labels the Payroll Process list already owns). So the keys
   * are resolved here, per namespace, by the alias each is read through.
   */
  it('the reprocess page: t(…) resolves in payroll.batch and tl(…) in payroll.list', () => {
    const missing: string[] = [];
    for (const [, key] of REPROCESS_PAGE.matchAll(/\bt\(\s*'([a-z][a-zA-Z0-9]*)'/g)) {
      if (msg(`payroll.batch.${key}`) === undefined) missing.push(`payroll.batch.${key}`);
    }
    for (const [, key] of REPROCESS_PAGE.matchAll(/\btl\(\s*'([a-z][a-zA-Z0-9]*)'/g)) {
      if (msg(`payroll.list.${key}`) === undefined) missing.push(`payroll.list.${key}`);
    }
    // The one DYNAMIC lookup on the page — the run-type label — resolved for every value the enum can
    // hold, because a missing branch here shows up only on the cycle nobody tested with.
    for (const rt of ['regular', 'off_cycle', 'bonus', 'adjustment']) {
      if (msg(`payroll.list.runType.${rt}`) === undefined) missing.push(`payroll.list.runType.${rt}`);
    }
    // And the statutory line labels the moved disclosure renders through STATUTORY_LINE_LABEL.
    for (const [, key] of REPROCESS_PAGE.matchAll(/'(line[A-Z][a-zA-Z0-9]*)'/g)) {
      if (msg(`payroll.batch.${key}`) === undefined) missing.push(`payroll.batch.${key}`);
    }
    expect(missing, missing.join(', ')).toEqual([]);
  });

  it('the row action and the header action have their copy', () => {
    // The list page reads two namespaces too, so check C skips it as well.
    for (const key of ['reprocessAction', 'reprocessHeaderAction', 'recalcBannerAction']) {
      expect(msg(`payroll.batch.${key}`), `payroll.batch.${key} is missing`).toBeTruthy();
    }
  });
});

describe('e440991b — the way in: the Payroll Process list', () => {
  it('offers Reprocess on a PROCESSED row, pointing at the dedicated screen', () => {
    expect(LIST_PAGE, 'the list still has no reprocess action').toMatch(/\/payroll\/\$\{b\.id\}\/reprocess/);
    expect(LIST_PAGE).toContain("tb('reprocessAction')");
  });

  it('and only for a processed run with multi-cycle on — the gates the destination re-asserts', () => {
    // A draft has no payslips and a closed run is immutable; multi-cycle is the module the whole
    // selective-reprocess path sits behind. Offering the link outside those is offering a dead end.
    expect(LIST_PAGE).toMatch(/b\.status === 'processed' && multiCycleOn && \(/);
    // The flag was not read on this screen at all before, because there was nothing to gate.
    expect(LIST_PAGE).toContain("isModuleEnabledOrFalse(s, 'multi_cycle_payroll')");
  });
});

describe('e440991b — the way in: the payroll run screen', () => {
  it('Reprocess is in the HEADER now, not at the bottom of the page', () => {
    expect(RUN_PAGE).toContain("t('reprocessHeaderAction')");
    expect(RUN_PAGE).toMatch(/\/payroll\/\$\{batch\.id\}\/reprocess/);
    expect(RUN_PAGE).toMatch(/batch\.status === 'processed' && multiCycleOn && slips\.length > 0 && \(/);
  });

  it('the selection panel and the Recalculation History card are OFF this screen', () => {
    expect(RUN_PAGE, 'the selection panel is still rendered here').not.toContain('ReprocessPanel');
    expect(RUN_PAGE, 'the disclosure card is still rendered here').not.toContain("t('disclosureTitle')");
    expect(RUN_PAGE, 'the run screen still reads the disclosure').not.toContain('listRecomputeDisclosure');
    expect(
      fs.existsSync(path.join(ROOT, 'app/payroll/[batchId]/reprocess-panel.tsx')),
      'the old panel file survived',
    ).toBe(false);
  });

  it('but MOVED, not deleted — the new page is the disclosure’s reader now', () => {
    // r168b held this card back from point 4 with a finding that still stands: it renders
    // `payroll_employee_result_history`, NOT domain events, so the Audit Trail does not carry it and
    // deleting it would destroy the only account of why a statutory figure moved on a re-run.
    expect(REPROCESS_PAGE).toContain('listRecomputeDisclosure');
    expect(REPROCESS_PAGE).toContain("t('disclosureTitle')");
  });

  it('the recalculation banner survives and now LINKS to the screen that clears it', () => {
    // The banner and the disabled Close are live controls, not history: without them a run can be
    // closed owing a recalculation, publishing figures the system already knows are stale.
    expect(RUN_PAGE).toContain("t('recalcBannerTitle'");
    expect(RUN_PAGE).toContain("t('closeBlockedRecalc')");
    expect(RUN_PAGE).toMatch(/needsRecalc \?\s*\(?\s*<Button type="button" variant="secondary" disabled/);
    expect(RUN_PAGE).toContain("t('recalcBannerAction')");
  });
});

describe('e440991b — the new screen refuses before it offers', () => {
  it('shape-checks the id, so /payroll/<not-a-uuid>/reprocess is a 404 and not a 500', () => {
    expect(REPROCESS_PAGE).toMatch(/if \(!UUID_RE\.test\(batchId\)\) notFound\(\);/);
  });

  it('re-asserts the module gate, so the route does not exist where the button does not', () => {
    expect(REPROCESS_PAGE).toMatch(/if \(!isModuleEnabledOrFalse\(s, 'multi_cycle_payroll'\)\) notFound\(\);/);
  });

  it('reads the three service-side refusals and names each one on screen', () => {
    expect(REPROCESS_PAGE).toContain('reprocessEligibility(s, { batchId })');
    expect(REPROCESS_PAGE).toContain('!eligibility.permitted');
    expect(REPROCESS_PAGE).toContain('!eligibility.processed');
    expect(REPROCESS_PAGE).toContain('eligibility.periodClosed');
    // Refused ⇒ the selection form is not rendered at all, not merely disabled.
    expect(REPROCESS_PAGE).toMatch(/if \(refusal\) \{/);
  });

  it('carries the pre-ticked stale employments through to the new screen (49e7e0a2)', () => {
    expect(REPROCESS_PAGE).toContain('batch.recalcEmploymentIds');
    expect(REPROCESS_PAGE).toContain('preselectedIds={preselectedIds}');
  });
});

describe('e440991b — progress is reported honestly', () => {
  it('the submit has a pending state and the page has NO poller over the job-status route', () => {
    expect(REPROCESS_FORM).toContain('useFormStatus');
    expect(REPROCESS_FORM).toMatch(/const \{ pending \} = useFormStatus\(\);/);
    // reprocessSelectedEmployees enqueues AND runs inline, so the submit is synchronous: there is no
    // background worker to poll and no fraction to report. A bar here would be a drawing of a system
    // that does not exist.
    for (const src of [REPROCESS_PAGE, REPROCESS_FORM]) {
      expect(src).not.toContain('setInterval');
      expect(src).not.toContain('reprocess-job');
      expect(src).not.toContain('useEffect');
    }
  });

  it('the idempotency token is minted once per mount and the review step cannot remint it', () => {
    // The review block is rendered from the same state inside the SAME form, so confirming IS the
    // submit that was reviewed. A separate confirm step with its own mount would hand the service a
    // fresh key and a double confirm would enqueue a second job — the guard this token exists for.
    expect(REPROCESS_FORM).toContain('name="idempotencyKey"');
    expect(
      REPROCESS_FORM.match(/useState\(\(\) =>\s*\n?\s*typeof crypto/g) ?? [],
      'the key is minted in more than one place',
    ).toHaveLength(1);
    // No setter is destructured: nothing in the component can replace the token after mount.
    expect(REPROCESS_FORM).toMatch(/const \[idempotencyKey\] = useState\(/);
    expect(REPROCESS_FORM).not.toContain('setIdempotencyKey');
    expect(REPROCESS_FORM.match(/<form\b/g) ?? [], 'a second form would be a second mount').toHaveLength(1);
  });

  it('the action returns to the new screen carrying the job id, not a one-line toast on the run screen', () => {
    expect(ACTIONS).toContain('const back = `/payroll/${batchId}/reprocess`;');
    // b372e923 BUILDS THE DESTINATION THROUGH A LOCAL `to()` HELPER — it re-attaches the Payroll Process
    // list's filter query on the way, which a hand-concatenated template literal was silently dropping.
    // So what is pinned here is the DECISION this case was always about (success carries the job id;
    // refusals land back on the SELECTION screen, never on the run) rather than the concatenation that
    // expressed it. Both are driven end to end against a real run, through the real action, in
    // test/payroll-reprocess-result-link-b372e923.test.ts.
    const start = ACTIONS.indexOf('export async function reprocessSelectedAction');
    const next = ACTIONS.indexOf('export async function', start + 1);
    const body = ACTIONS.slice(start, next === -1 ? undefined : next);
    expect(start, 'reprocessSelectedAction is gone').toBeGreaterThan(-1);
    expect(body).toMatch(/redirect\(\s*to\(\{\s*job:\s*jobId\s*\}\)\s*\)/);
    expect(body, 'refusals must land back on the selection, not on the run screen').toMatch(
      /redirect\(\s*to\(\{\s*error:/,
    );
    expect(body, 'a redirect to the run screen came back').not.toMatch(/redirect\(\s*`\/payroll\/\$\{batchId\}`/);
  });
});

// ────────────────────────────────── against a real run ──────────────────────────────────

/**
 * ONE DB lifecycle for the whole file. Two sibling describes each owning a `beforeAll`/`afterAll` pair
 * looks symmetrical and is not: vitest fires the first describe's `afterAll` before the second describe
 * runs, so `closeAll()` tears the pool down underneath it and every later test dies on
 * `write CONNECTION_ENDED` — a failure that reads like a database problem and is a fixture problem.
 */
describe('e440991b — against a real run', () => {
  let base: Base;
  let a: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // Selective reprocessing sits behind multi_cycle_payroll; entitledCtx must be built AFTER the
    // grant, because a session snapshot is a point-in-time read exactly as it is in production.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    a = await entitledCtx(base);
  });
  afterAll(async () => {
    await closeAll();
  });

  describe('the refusals', () => {
    async function hire(
      ctx: SessionContext,
      name: string,
      ic: string,
      salary: number,
      companyId?: string,
      deptId?: string,
    ) {
      const e = await hireEmployee(ctx, {
        person: {
          fullName: name,
          primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test`,
        },
        companyId: companyId ?? base.companyId,
        departmentId: deptId ?? base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(ctx, {
        employmentId: e.employmentId,
        basicSalary: salary,
        monthlyAllowance: 0,
        effectiveFrom: '2026-01-01',
      });
      await setStatutoryProfileMY(ctx, { personId: e.personId, icNumber: ic });
      return e;
    }

    async function processedRun(period = '2026-05') {
      const e = await hire(a, `Subject ${period}`, '900101011234', 3000);
      const b = await createBatch(a, {
        companyId: base.companyId,
        payPeriod: period,
      });
      await generatePayslips(a, { batchId: b.batchId });
      return { batchId: b.batchId, employmentId: e.employmentId };
    }

    it('a DRAFT run is not reprocessable — there are no payslips to recompute', async () => {
      await hire(a, 'Draft Subject', '900101011234', 3000);
      const b = await createBatch(a, {
        companyId: base.companyId,
        payPeriod: '2026-05',
      });
      const el = await reprocessEligibility(a, { batchId: b.batchId });
      expect(el).not.toBeNull();
      expect(el!.processed, 'a draft run was reported as reprocessable').toBe(false);
      // …and the service says so too, on the error the page's copy is keyed to.
      await expect(
        reprocessSelectedEmployees(a, {
          batchId: b.batchId,
          employmentIds: [randomUUID()],
        }),
      ).rejects.toThrow(/processed/i);
    });

    it('a CLOSED run is not reprocessable — a closed run is immutable', async () => {
      const { batchId } = await processedRun();
      await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));
      const el = await reprocessEligibility(a, { batchId });
      expect(el!.processed, 'a closed run was reported as reprocessable').toBe(false);
    });

    it('a CLOSED PAY PERIOD blocks it even while the run itself still says "processed"', async () => {
      // This is the refusal that is invisible on the run row: the batch is still `processed`, so a screen
      // that only looked at batch.status would offer the button and the service would throw on submit.
      const { batchId, employmentId } = await processedRun();
      const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
      await owner.db
        .update(schema.payPeriod)
        .set({ status: 'closed' })
        .where(eq(schema.payPeriod.id, batch.payPeriodId));

      const el = await reprocessEligibility(a, { batchId });
      expect(el!.processed, 'the run status should be untouched by closing the period').toBe(true);
      expect(el!.periodClosed, 'a closed pay period was not reported').toBe(true);
      await expect(
        reprocessSelectedEmployees(a, {
          batchId,
          employmentIds: [employmentId],
        }),
      ).rejects.toThrow(/pay period is closed/i);
    });

    it('a caller WITHOUT payroll.reprocess.selective is refused by the read AND by the service', async () => {
      const { batchId, employmentId } = await processedRun();
      // The per-company narrowing the override table exists for: hr_admin keeps every other payroll
      // permission and loses this one, for this company only.
      await setPayrollPermissionGrant(a, {
        companyId: base.companyId,
        permissionKey: 'payroll.reprocess.selective',
        role: 'hr_admin',
        allowed: false,
      });

      const el = await reprocessEligibility(a, { batchId });
      expect(el!.permitted, 'the page would have offered the form').toBe(false);
      // The page's refusal is a second surface. THIS is the guard, and it is asserted on the error the
      // action maps to "You do not have permission to reprocess payroll" — not on any throw at all, which
      // a fixture dying earlier would also produce.
      await expect(
        reprocessSelectedEmployees(a, {
          batchId,
          employmentIds: [employmentId],
        }),
      ).rejects.toBeInstanceOf(PayrollPermissionDeniedError);
      // Nothing was enqueued: a refusal must not leave a job row behind for the results panel to find.
      expect(await owner.db.select().from(schema.payrollReprocessJob)).toHaveLength(0);
    });

    it('an employment id from ANOTHER COMPANY, posted to the action, selects nothing', async () => {
      const { batchId } = await processedRun();
      const [other] = await owner.db
        .insert(schema.company)
        .values({ tenantId: base.tenantId, legalName: 'Other Sdn Bhd' })
        .returning({ id: schema.company.id });
      const [otherDept] = await owner.db
        .insert(schema.department)
        .values({ tenantId: base.tenantId, companyId: other.id, name: 'Ops' })
        .returning({ id: schema.department.id });
      const outsider = await hire(a, 'Outside Company', '900101015555', 5000, other.id, otherDept.id);

      // The form posts employment ids; a hand-edited post carrying somebody else's company would
      // otherwise widen this run's recompute to an employee it does not pay.
      await expect(
        reprocessSelectedEmployees(a, {
          batchId,
          employmentIds: [outsider.employmentId],
        }),
      ).rejects.toThrow(/belong to this run/i);
      // No payslip was written for the outsider, and the run's own payslip count is untouched.
      const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
      expect(slips).toHaveLength(1);
      expect(slips.every((s) => s.employmentId !== outsider.employmentId)).toBe(true);
    });
  });

  describe('the result: net pay before and after, off the stored snapshots', () => {
    it('the completed job names its own selection, and the disclosure it wrote reports the real net move', async () => {
      const e = await hireEmployee(a, {
        person: { fullName: 'Net Move', primaryEmail: 'netmove@acme.test' },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 3000,
        monthlyAllowance: 0,
        effectiveFrom: '2026-01-01',
      });
      await setStatutoryProfileMY(a, {
        personId: e.personId,
        icNumber: '900101011234',
      });
      const untouched = await hireEmployee(a, {
        person: { fullName: 'Untouched', primaryEmail: 'untouched@acme.test' },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(a, {
        employmentId: untouched.employmentId,
        basicSalary: 3000,
        monthlyAllowance: 0,
        effectiveFrom: '2026-01-01',
      });
      await setStatutoryProfileMY(a, {
        personId: untouched.personId,
        icNumber: '900101012222',
      });

      const b = await createBatch(a, {
        companyId: base.companyId,
        payPeriod: '2026-05',
      });
      await generatePayslips(a, { batchId: b.batchId });
      const netOf = async (employmentId: string) => {
        const [row] = await owner.db
          .select()
          .from(schema.payslip)
          .where(and(eq(schema.payslip.batchId, b.batchId), eq(schema.payslip.employmentId, employmentId)));
        return row;
      };
      const before = await netOf(e.employmentId);

      // The divergence case: raise the salary and reprocess ONLY this employee. A results panel that
      // recomputed the figures — or that read the superseded first calculation — would disagree with the
      // payslip it claims to describe.
      await setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 4200,
        monthlyAllowance: 0,
        effectiveFrom: '2026-05-01',
      });
      const job = await reprocessSelectedEmployees(a, {
        batchId: b.batchId,
        employmentIds: [e.employmentId],
        reason: 'salary correction',
      });
      expect(job.status).toBe('completed');

      const after = await netOf(e.employmentId);
      expect(after.version, 'the run was not actually reprocessed').toBeGreaterThan(before.version);

      // The job read the results panel uses: it must carry the SELECTION and the instant it was enqueued,
      // because that window is how the panel tells this job's history rows from every earlier one.
      const stored = await getReprocessJob(a, job.jobId);
      expect(stored).not.toBeNull();
      expect(stored!.batchId).toBe(b.batchId);
      expect(stored!.employmentIds).toEqual([e.employmentId]);
      expect(stored!.createdAt).toBeInstanceOf(Date);
      expect((stored!.result as { reprocessed?: number }).reprocessed).toBe(1);

      const rows = await listRecomputeDisclosure(a, { batchId: b.batchId });
      const mine = rows.filter((r) => stored!.employmentIds.includes(r.employmentId) && r.at >= stored!.createdAt);
      expect(mine, 'the window that separates this job’s rows from earlier ones caught nothing').toHaveLength(1);
      // netBefore / netAfter are the SNAPSHOTS this run wrote, not a recomputation: they equal the two
      // payslip rows read straight from the table, on either side of the reprocess.
      expect(mine[0].diff.netBefore).toBeCloseTo(Number(before.netPay), 2);
      expect(mine[0].diff.netAfter).toBeCloseTo(Number(after.netPay), 2);
      expect(mine[0].diff.netChanged, 'a real pay move was reported as unchanged').toBe(true);
      expect(mine[0].reason).toBe('salary correction');

      // …and nobody else's payslip was recomputed, which is the promise the review step makes on screen.
      const other = await netOf(untouched.employmentId);
      expect(other.version).toBe(1);
      expect(Number(other.netPay)).toBeCloseTo(Number((await netOf(untouched.employmentId)).netPay), 2);
    });

    it('a second identical submit reuses the SAME job — the review step must not mint a new key', async () => {
      const e = await hireEmployee(a, {
        person: { fullName: 'Double Submit', primaryEmail: 'double@acme.test' },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 3000,
        monthlyAllowance: 0,
        effectiveFrom: '2026-01-01',
      });
      await setStatutoryProfileMY(a, {
        personId: e.personId,
        icNumber: '900101011234',
      });
      const b = await createBatch(a, {
        companyId: base.companyId,
        payPeriod: '2026-05',
      });
      await generatePayslips(a, { batchId: b.batchId });

      // The per-mount token the form posts. Confirming twice posts it twice, which is exactly what a
      // double-clicked confirm looks like from the server's side.
      const key = randomUUID();
      const first = await reprocessSelectedEmployees(a, {
        batchId: b.batchId,
        employmentIds: [e.employmentId],
        idempotencyKey: key,
      });
      const second = await reprocessSelectedEmployees(a, {
        batchId: b.batchId,
        employmentIds: [e.employmentId],
        idempotencyKey: key,
      });
      expect(second.jobId).toBe(first.jobId);
      expect(await owner.db.select().from(schema.payrollReprocessJob)).toHaveLength(1);
      // One recompute, not two: the payslip advanced exactly one version.
      const [slip] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, b.batchId));
      expect(slip.version).toBe(2);
    });
  });
});
