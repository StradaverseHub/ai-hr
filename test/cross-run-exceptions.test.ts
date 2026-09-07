/**
 * ADR-0074 r245 — the exceptions queue across every run.
 *
 * ⚠️ THE MEASUREMENT THIS UNBLOCKS IS THE REASON IT EXISTS. 81 flagged verdicts were live and unresolved
 * across 23 batches on production and not one had ever been dispositioned, because the only place to
 * resolve one was that batch's own screen. `falsePositiveRate`, `mttrSeconds` and `impliedOperators` all
 * stay NULL until a human decides — so a queue nobody can practically work is a queue that keeps the
 * Control Tower's headline unprintable.
 *
 * These cases pin the four properties that are invisible to types and to a 200: WHICH verdicts the reader
 * selects, that resolving goes through the ONE action (so r238's ledger stamp cannot be forgotten on one
 * screen), that the cap announces itself, and that the screen did not quietly become a second control
 * tower.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { openExceptionsAcrossRuns, resolveAnomalyVerdict } from '../core/payroll-anomaly';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const PAGE = read('app/control-tower/exceptions/page.tsx');
const ACTIONS = read('app/payroll/actions.ts');

let b: Base;
let a: SessionContext;

async function makeEmp(name: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

async function makeBatch(period: string) {
  const [pp] = await owner.db
    .insert(schema.payPeriod)
    .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'open' })
    .returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      payPeriodId: pp.id,
      payPeriod: period,
      batchDate: `${period}-28`,
      status: 'processed',
    })
    .returning({ id: schema.payrollBatch.id });
  return batch.id;
}

/** A verdict written straight in: this reader's contract is "read whatever the evaluator left". */
async function verdict(
  batchId: string,
  employmentId: string,
  over: Partial<typeof schema.payrollAnomalyVerdict.$inferInsert> = {},
) {
  const [v] = await owner.db
    .insert(schema.payrollAnomalyVerdict)
    .values({
      tenantId: b.tenantId,
      batchId,
      employmentId,
      disposition: 'review',
      detectorsRun: ['net-swing'],
      detectorsSkipped: [],
      ...over,
    })
    .returning({ id: schema.payrollAnomalyVerdict.id });
  return v.id;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
});

describe('which verdicts the cross-run queue selects', () => {
  it('gathers flagged, live, unresolved verdicts from EVERY run — the thing no screen could do', () => {
    return (async () => {
      const may = await makeBatch('2026-05');
      const jun = await makeBatch('2026-06');
      const e1 = await makeEmp('Ali');
      const e2 = await makeEmp('Siti');
      await verdict(may, e1, { disposition: 'review' });
      await verdict(jun, e2, { disposition: 'block' });

      const { rows, total } = await openExceptionsAcrossRuns(a);
      expect(total).toBe(2);
      // Worst first: the block outranks the review however much later it was raised.
      expect(rows.map((r) => r.disposition)).toEqual(['block', 'review']);
      // …and each row says WHICH run it came from, which out of its own batch it must.
      expect(rows.map((r) => r.payPeriod).sort()).toEqual(['2026-05', '2026-06']);
    })();
  });

  it('excludes what is not outstanding work: superseded, resolved, and auto-cleared', async () => {
    const may = await makeBatch('2026-05');
    const e = await makeEmp('Ali');
    // Superseded — what the system believed before the last re-evaluation. Stamping a judgement on a
    // reading nobody is looking at would put a decision against a superseded row into the metrics.
    await verdict(may, e, { supersededAt: new Date() });
    // Already decided — belongs to its run's history, not to a work queue.
    await verdict(may, await makeEmp('Siti'), { resolvedAt: new Date(), resolution: 'accepted' });
    // Auto-cleared. Raising a false negative needs the whole run in front of you, so that affordance
    // stays per-run; a cross-run list of everything cleared would be thousands of rows nobody must act on.
    await verdict(may, await makeEmp('Chen'), { disposition: 'auto_clear' });

    expect((await openExceptionsAcrossRuns(a)).total).toBe(0);
  });

  it('orders equal severities oldest-first, because the metric it unblocks is how long they wait', async () => {
    const may = await makeBatch('2026-05');
    const older = await verdict(may, await makeEmp('Ali'), { computedAt: new Date('2026-05-01T00:00:00Z') });
    const newer = await verdict(may, await makeEmp('Siti'), { computedAt: new Date('2026-06-01T00:00:00Z') });
    const { rows } = await openExceptionsAcrossRuns(a);
    expect(rows.map((r) => r.verdictId)).toEqual([older, newer]);
  });

  it('caps, and REPORTS the cap rather than showing a subset silently', async () => {
    const may = await makeBatch('2026-05');
    for (let i = 0; i < 4; i++) await verdict(may, await makeEmp(`p${i}`));
    const { rows, total, cappedOut } = await openExceptionsAcrossRuns(a, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(total, 'the true figure survives the cap').toBe(4);
    expect(cappedOut).toBe(true);
    expect((await openExceptionsAcrossRuns(a, { limit: 99 })).cappedOut).toBe(false);
  });

  it('a decision made here leaves the queue, which is what makes the backlog finishable', async () => {
    const may = await makeBatch('2026-05');
    const v = await verdict(may, await makeEmp('Ali'));
    await resolveAnomalyVerdict(a, { verdictId: v, resolution: 'false_positive' });
    expect((await openExceptionsAcrossRuns(a)).total).toBe(0);
    const [row] = await owner.db
      .select()
      .from(schema.payrollAnomalyVerdict)
      .where(eq(schema.payrollAnomalyVerdict.id, v));
    expect(row.resolution).toBe('false_positive');
  });
});

describe('one action, and one row shape', () => {
  it('the page posts to the SAME resolve action the per-run queue uses', () => {
    // ⚠️ A second copy of that action would be a second place r238's ledger stamp — which hangs off
    // resolveAnomalyVerdict — could be forgotten. The screens differ only in where they land afterwards.
    expect(code(PAGE)).toContain("import { resolveAnomalyAction } from '@/app/payroll/actions'");
    expect(code(PAGE)).toContain('action={resolveAnomalyAction}');
    expect(code(PAGE), 'and says where to come back to').toContain('name="returnTo" value="tower"');
    // ⚠️ SCOPED TO THIS ACTION'S BODY, and the first version of this case was not — it searched the whole
    // file for `redirect(${back}` and matched the REPROCESS action, which builds its own `back` from a
    // batch id server-side and is perfectly safe. A guard that names a common variable has to say which
    // function it means, or it fails on innocent code and teaches people to loosen it.
    const body = code(ACTIONS).slice(
      code(ACTIONS).indexOf('export async function resolveAnomalyAction'),
      code(ACTIONS).indexOf('export async function', code(ACTIONS).indexOf('export async function resolveAnomalyAction') + 10),
    );
    expect(body, 'the return target comes from an allowlist').toContain('RESOLVE_RETURNS as readonly string[]');
    // r253 — the same claim against the shape that can also carry the Payroll Process filter selection:
    // the Payroll branch of `home` is now `withPayrollFrom(…)` and the append goes through the one
    // helper. The tower branch is unchanged, and the negative assertion below is what pins that the
    // posted `returnTo` still never reaches a redirect.
    expect(body, 'and the redirect uses the derived value').toContain("redirect(withQueryParam(home, 'toast'");
    expect(
      /redirect\(`?\$?\{?back\b/.test(body),
      'the raw form value must never reach a redirect in this action',
    ).toBe(false);
  });

  it('did not become a second control tower', () => {
    // It is a working queue. The metrics strip, the circuit breaker and the re-evaluate button all live
    // on screens that own them; duplicating any of them is how two screens start disagreeing.
    const c = code(PAGE);
    for (const notHere of ['anomalyMetrics', 'evaluateCircuitBreaker', 'evaluateAnomaliesAction', 'narrateAnomalyAction']) {
      expect(c.includes(notHere), `${notHere} belongs to the per-run screen, not here`).toBe(false);
    }
  });
});
