/** Execute the operator's actual SSH stdin on local Postgres; never send anything over SSH. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import * as s from '../db/schema';
import { approveFeedbackPlan, completeFeedbackBuild, setFeedbackPlan, startFeedbackBuild, submitFeedback } from '../core/feedback';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { pgErrorChain, pgSqlState } from '../lib/db-error';
import { markBuildCompleted, markBuildStarted, markDeployed, pushPlan } from '../scripts/improve/remote';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const transport = vi.hoisted(() => ({ run: vi.fn<(command: unknown, args: unknown, options: unknown) => string>() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: transport.run,
}));

let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => {
  transport.run.mockReset();
  // An unexpected process invocation must fail closed, rather than reach any remote host.
  transport.run.mockImplementation(() => { throw new Error('Unexpected operator transport invocation.'); });
  await resetDb();
  base = await seedBase();
});
afterAll(closeAll);

type Binding = { id: string; tenantId: string; reporterEmploymentId: string | null };
const plan = "Fictional operator plan: keep 'quotes', $fb$ and $mv$ as text.";
const buildRef = 'codex/fictional-operator-binding';
const operations = [
  { name: 'push-plan', send: (p: Binding) => pushPlan({ ...p, plan, model: 'fictional-model' }) },
  { name: 'build-start', send: (p: Binding) => markBuildStarted(p) },
  { name: 'build-complete', send: (p: Binding) => markBuildCompleted({ ...p, buildRef }) },
  { name: 'mark-deployed', send: (p: Binding) => markDeployed({ ...p, buildRef }) },
] as const;

function captureSql(send: () => void): string {
  transport.run.mockClear();
  transport.run.mockImplementation(() => '');
  try { send(); } finally {
    transport.run.mockImplementation(() => { throw new Error('Unexpected operator transport invocation.'); });
  }
  expect(transport.run).toHaveBeenCalledTimes(1);
  const [command, args, options] = transport.run.mock.calls[0];
  expect(command).toBe('ssh');
  expect(Array.isArray(args)).toBe(true);
  if (!Array.isArray(args)) throw new Error('No captured SSH argument list.');
  expect(args[args.length - 1]).toContain('-v ON_ERROR_STOP=1 -f -');
  if (!options || typeof options !== 'object' || !('input' in options) || typeof options.input !== 'string') throw new Error('No captured operator SQL stdin.');
  return options.input;
}

/** Like psql -f -, keep the generated BEGIN/COMMIT on one connection, including failure rollback. */
async function runCaptured(text: string): Promise<void> {
  const connection = await owner.client.reserve();
  try { await connection.unsafe(text).simple(); } catch (error) {
    // psql exits on ON_ERROR_STOP. A pooled test connection must instead end its aborted transaction.
    await connection.unsafe('ROLLBACK').simple();
    throw error;
  } finally { connection.release(); }
}

async function report(employed: boolean): Promise<Binding> {
  const employmentId = employed ? (await hireEmployee(adminCtx(base), {
    person: { fullName: 'Fictional Operator Reporter', primaryEmail: 'operator-reporter@fixture.invalid' },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur(),
  })).employmentId : null;
  const item = await submitFeedback(adminCtx(base), {
    reporterEmploymentId: employmentId, category: 'issue', title: 'Fictional operator SQL check', description: 'Only local disposable acceptance records.',
  });
  return { id: item.id, tenantId: base.tenantId, reporterEmploymentId: employmentId };
}

async function snapshot(id: string) {
  const requests = await owner.db.select().from(s.feedbackRequest).where(eq(s.feedbackRequest.id, id)).orderBy(asc(s.feedbackRequest.id));
  const revisions = await owner.db.select().from(s.feedbackPlanRevision).where(eq(s.feedbackPlanRevision.feedbackRequestId, id)).orderBy(asc(s.feedbackPlanRevision.revision), asc(s.feedbackPlanRevision.id));
  const events = await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId, id)).orderBy(asc(s.domainEvent.sequence), asc(s.domainEvent.id));
  return { requests, revisions, events };
}

describe.each([{ label: 'employment-backed', employed: true }, { label: 'NULL-employment account', employed: false }])('operator binding SQL: $label', ({ employed }) => {
  it('executes all four real mutators, retaining plan history and exactly one correctly bound event per change', async () => {
    const binding = await report(employed);
    await setFeedbackPlan(adminCtx(base), { feedbackId: binding.id, plan: 'Original fictional plan.' });
    const original = await snapshot(binding.id);
    await runCaptured(captureSql(() => operations[0].send(binding)));
    const planned = await snapshot(binding.id);
    expect(planned.requests[0]).toMatchObject({ status: 'planned', plan, planModel: 'fictional-model', planRevision: 2, reporterEmploymentId: binding.reporterEmploymentId, reporterUserId: base.adminUserId });
    expect(planned.revisions).toHaveLength(2);
    expect(planned.revisions.find(r => r.revision === 1)).toMatchObject({ plan: 'Original fictional plan.', outcome: 'superseded' });
    expect(planned.revisions.find(r => r.revision === 2)).toMatchObject({ plan, outcome: null });
    expect(planned.events).toHaveLength(original.events.length + 1);

    await approveFeedbackPlan(adminCtx(base), { feedbackId: binding.id });
    const approved = await snapshot(binding.id);
    for (const [operation, status, eventType] of [
      [operations[1], 'building', 'feedback.build.started'],
      [operations[2], 'done', 'feedback.build.completed'],
      [operations[3], 'deployed', 'feedback.deployed'],
    ] as const) {
      const before = await snapshot(binding.id);
      await runCaptured(captureSql(() => operation.send(binding)));
      const after = await snapshot(binding.id);
      expect(after.requests[0].status).toBe(status);
      if (status !== 'building') expect(after.requests[0].buildRef).toBe(buildRef);
      expect(after.revisions).toEqual(approved.revisions);
      expect(after.events).toHaveLength(before.events.length + 1);
      expect(after.events.filter(e => !before.events.some(old => old.id === e.id))).toMatchObject([{ tenantId: base.tenantId, eventType, actorType: 'agent', subjectEmploymentId: binding.reporterEmploymentId }]);
    }
    const final = await snapshot(binding.id);
    expect(final.requests[0].decidedAt).not.toBeNull();
    const drafted = planned.events.filter(e => !original.events.some(old => old.id === e.id));
    expect(drafted).toMatchObject([{ eventType: 'feedback.plan.drafted', actorType: 'agent', subjectEmploymentId: binding.reporterEmploymentId }]);
  });

  it.each(operations)('$name refuses changed tenant or reporter before any request, history or event write', async operation => {
    const binding = await report(employed);
    await setFeedbackPlan(adminCtx(base), { feedbackId: binding.id, plan: 'Retain this exact fictional history.' });
    await approveFeedbackPlan(adminCtx(base), { feedbackId: binding.id });
    if (operation.name === 'build-complete' || operation.name === 'mark-deployed') await startFeedbackBuild(adminCtx(base), { feedbackId: binding.id });
    if (operation.name === 'mark-deployed') await completeFeedbackBuild(adminCtx(base), { feedbackId: binding.id, buildRef: 'original-fictional-build' });
    const foreign = await seedBase();
    const before = await snapshot(binding.id);
    const mismatches: Binding[] = [
      { ...binding, tenantId: foreign.tenantId },
      { ...binding, reporterEmploymentId: randomUUID() },
      ...(employed ? [{ ...binding, reporterEmploymentId: null }] : []),
    ];
    for (const mismatched of mismatches) {
      const error = await runCaptured(captureSql(() => operation.send(mismatched))).then(() => null, (error: unknown) => error);
      expect(pgSqlState(error)).toBe('P0001');
      expect(pgErrorChain(error).some(e => e.message === 'Feedback reporter binding changed')).toBe(true);
      expect(await snapshot(binding.id)).toEqual(before);
    }
  });
});
