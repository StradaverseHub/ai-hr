import { describe, expect, it } from 'vitest';
import { createWorkerComparisonModel } from '../scripts/performance/worker-comparison.mjs';

const identity = { candidateSha: 'a'.repeat(40), controllerSha: 'a'.repeat(40), runId: 123, runAttempt: 1 };
const prerequisite = {
  kind: 'AUTHENTICATED_FULL_DEVELOPMENT_PREFLIGHT_SCOPE_ONLY', releaseEligible: false, source: identity.candidateSha,
  runId: 111, resolveJobId: 112, selectedJobId: 113, artifactId: 114, archiveSha256: '1'.repeat(64),
  captureSha256: '2'.repeat(64), renderedUnionSha256: '3'.repeat(64), harnessSha256: '4'.repeat(64), scenarioSha256: '5'.repeat(64),
};
const host = { effectiveCpus: 4, memoryBytes: 16 * 1024 ** 3, nodeVersion: 'v24.22.1', postgresProfile: 2 };
const seal = { buildId: 'reviewed_build', entries: 10, bytes: 1000, sha256: 'b'.repeat(64) };
const anchorMs = 1000;
const activeEndMs = anchorMs + 6600000;
const settlementEndMs = anchorMs + 6960000;
const finalEndMs = anchorMs + 7080000;
type Cell = { ordinal: number; name: string; scope: string; claimsPerActor: number };
type Profile = Cell & {
  suite: string; workers: number; totalHeapMiB: number; totalPool: number; waiterLimit: number;
  heapMiBPerWorker: number; poolPerWorker: number; buildMode: string; driverMs: number;
  driverSettlementMs: number; rampMs: number | null; holdMs: number; activeMinimumMs: number; oversubscribed: boolean;
};
type Request = { cell: Profile };

function result(cell: Cell) {
  return { kind: 'WORKER_COMPARISON_CELL_V1', scope: cell.scope, passed: true,
    build: { identity, seal, directory: { device: '20', inode: String(100 + cell.ordinal) } },
    fixture: { day: '2026-11-09', actors: 500, tenants: 2, companies: 10, nativeGrants: 544,
      claims: cell.claimsPerActor * 500, attendance: 90000, payslips: 500 } };
}

function settled(ordinal: number) {
  return { kind: 'WORKER_COMPARISON_CELL_SETTLEMENT_V1', ...identity, ordinal, settledForReuse: true,
    directChildrenClosed: true, processFamilyEmpty: true, postgresBirthAbsent: true, portsAbsent: true,
    runtimeBuildRetired: true, focusedDirectoryRetired: true };
}

function model() {
  let time = anchorMs;
  const trace: string[] = [];
  const options = {
    identity, prerequisite, host, anchorMs, now: () => time,
    observeCell: ({ cell }: { cell: Cell }) => { trace.push('observe:' + cell.name); return result(cell); },
    settledForReuse: ({ cell }: { cell: Cell }) => { trace.push('settled:' + cell.name); return settled(cell.ordinal); },
    verifySeed: ({ deadlineMs }: { deadlineMs: number }) => { trace.push('verify:' + deadlineMs); return seal; },
    retireSeed: () => {
      trace.push('retire');
      return { kind: 'WORKER_COMPARISON_SEED_RETIREMENT_V1', ...identity, retired: true, privateDirectoryRetired: true };
    },
  };
  return { trace, options, setTime: (value: number) => { time = value; } };
}

describe('dormant serial worker comparison', () => {
  it('orders one canonical build and two independently born copies with fixed equal budgets', async () => {
    const { trace, options } = model();
    const profiles: unknown[] = [];
    const scheduler = createWorkerComparisonModel({
      ...options,
      observeCell(request: Request) {
        const c = request.cell;
        profiles.push([c.ordinal, c.name, c.suite, c.workers, c.totalHeapMiB, c.totalPool, c.waiterLimit,
          c.heapMiBPerWorker, c.poolPerWorker, c.buildMode, c.driverMs, c.driverSettlementMs, c.rampMs, c.holdMs,
          c.activeMinimumMs, c.oversubscribed]);
        return options.observeCell(request);
      },
    });
    const report = await scheduler.run();
    expect(profiles).toEqual([
      [1, 'steady-2', 'whole-system', 2, 4096, 16, 2048, 2048, 8, 'comparison-first', 870000, 10000, 10000, 300000, 2560000, false],
      [2, 'steady-4', 'whole-system', 4, 4096, 16, 2048, 1024, 4, 'comparison-copy', 870000, 10000, 10000, 300000, 1660000, false],
      [3, 'functional-8', 'workflow-preflight', 8, 4096, 16, 2048, 512, 2, 'comparison-copy', 600000, 10000, null, 30000, 1390000, true],
    ]);
    expect(trace).toEqual(['observe:steady-2', 'settled:steady-2', 'verify:' + activeEndMs,
      'observe:steady-4', 'settled:steady-4', 'verify:' + activeEndMs,
      'observe:functional-8', 'settled:functional-8', 'verify:' + finalEndMs, 'retire']);
    expect(report).toMatchObject({ complete: true, steadyPairPassed: true, seedSettlement: 'settled',
      releaseEligible: false, buildSeal: seal });
    expect(report.cells[2].scope).toBe('functional-diagnostic-only');
    expect(report.frontiers.outerEndMs - report.frontiers.finalEndMs).toBe(120000);
    await expect(scheduler.run()).rejects.toThrow('cannot reopen');
  });

  it('cannot reopen while an observation is still pending', async () => {
    const { options } = model();
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    const scheduler = createWorkerComparisonModel({ ...options,
      async observeCell(request: Request) {
        await pending;
        return options.observeCell(request);
      },
    });
    const first = scheduler.run();
    await expect(scheduler.run()).rejects.toThrow('cannot reopen');
    release();
    await expect(first).resolves.toMatchObject({ complete: true });
  });

  it('retains a failed measurement and progresses after exact positive cleanup', async () => {
    const { options } = model();
    const report = await createWorkerComparisonModel({ ...options,
      observeCell(request: Request) {
        return { ...options.observeCell(request), passed: request.cell.ordinal !== 1 };
      },
    }).run();
    expect(report.cells.map(row => [row.state, row.settlement])).toEqual([
      ['failed', 'settled'], ['passed', 'settled'], ['passed', 'settled'],
    ]);
    expect(report.cells[0].reason).toBe('measurement');
    expect(report.complete).toBe(false);
    expect(report.steadyPairPassed).toBe(false);
  });

  it('never starts the next cell or retires the seed on ambiguous or stale settlement', async () => {
    for (const refusal of [true, settled(2), { ...settled(1), processFamilyEmpty: false },
      { ...settled(1), postgresBirthAbsent: null }, { ...settled(1), candidateSha: 'c'.repeat(40) }]) {
      const { options, trace } = model();
      const report = await createWorkerComparisonModel({ ...options, settledForReuse: () => refusal }).run();
      expect(trace).toEqual(['observe:steady-2']);
      expect(report.cells[0]).toMatchObject({ state: 'failed', settlement: 'unknown' });
      expect(report.cells.slice(1).every(row => row.state === 'not-entered' && row.reason === 'settlement')).toBe(true);
      expect(report.seedSettlement).toBe('unknown');
    }
  });

  it('refuses reused runtime inodes, stale build identities and changed copy bytes', async () => {
    for (const change of [
      (build: ReturnType<typeof result>['build']) => ({ ...build, directory: { device: '20', inode: '101' } }),
      (build: ReturnType<typeof result>['build']) => ({ ...build, identity: { ...identity, runId: 124 } }),
      (build: ReturnType<typeof result>['build']) => ({ ...build, seal: { ...seal, sha256: 'd'.repeat(64) } }),
    ]) {
      const { options } = model();
      const report = await createWorkerComparisonModel({ ...options,
        observeCell(request: Request) {
          const evidence = options.observeCell(request);
          return request.cell.ordinal === 2 ? { ...evidence, build: change(evidence.build) } : evidence;
        },
      }).run();
      expect(report.cells[1]).toMatchObject({ state: 'failed', reason: 'build-proof', settlement: 'settled' });
      expect(report.cells[2]).toMatchObject({ state: 'not-entered', reason: 'build-proof' });
    }
  });

  it('refuses a new cell below its full original admission budget', async () => {
    const { options, setTime, trace } = model();
    setTime(activeEndMs - 2560000 + 1);
    const report = await createWorkerComparisonModel(options).run();
    expect(trace).toEqual([]);
    expect(report.cells.every(row => row.state === 'not-entered' && row.reason === 'budget')).toBe(true);
  });

  it('retains settlement after active overrun without allowing another cell', async () => {
    const { options, setTime, trace } = model();
    const report = await createWorkerComparisonModel({ ...options,
      observeCell(request: Request) {
        setTime(activeEndMs);
        return options.observeCell(request);
      },
    }).run();
    expect(report.cells[0]).toMatchObject({ state: 'failed', reason: 'active-overrun', settlement: 'settled' });
    expect(report.cells[1]).toMatchObject({ state: 'not-entered', reason: 'active-overrun' });
    expect(trace).toEqual(['observe:steady-2', 'settled:steady-2', 'verify:' + finalEndMs, 'retire']);
  });

  it('does not accept a settlement or seed retirement at its absolute deadline', async () => {
    const first = model();
    const unsettled = await createWorkerComparisonModel({ ...first.options,
      settledForReuse(request: Request) {
        first.setTime(settlementEndMs);
        return first.options.settledForReuse(request);
      },
    }).run();
    expect(unsettled.cells[0].settlement).toBe('unknown');
    expect(first.trace).not.toContain('retire');

    const last = model();
    const late = await createWorkerComparisonModel({ ...last.options,
      retireSeed() {
        last.setTime(finalEndMs);
        return last.options.retireSeed();
      },
    }).run();
    expect(late.seedSettlement).toBe('unknown');
    expect(late.complete).toBe(false);
  });

  it('does not retry a refused seed proof or compare different steady fixture days', async () => {
    const bad = model();
    const held = await createWorkerComparisonModel({ ...bad.options,
      verifySeed(input: { deadlineMs: number }) {
        bad.options.verifySeed(input);
        return { ...seal, bytes: seal.bytes + 1 };
      },
    }).run();
    expect(held.cells[1]).toMatchObject({ state: 'not-entered', reason: 'seed-proof' });
    expect(bad.trace.filter(row => row.startsWith('verify:'))).toHaveLength(1);
    expect(bad.trace).not.toContain('retire');

    const changed = model();
    const report = await createWorkerComparisonModel({ ...changed.options,
      observeCell(request: Request) {
        const evidence = changed.options.observeCell(request);
        return request.cell.ordinal === 2 ? { ...evidence, fixture: { ...evidence.fixture, day: '2026-11-10' } } : evidence;
      },
    }).run();
    expect(report.cells[1]).toMatchObject({ state: 'failed', reason: 'fixture-day', settlement: 'settled' });
    expect(report.cells[2].state).toBe('passed');
    expect(report.steadyPairPassed).toBe(false);
  });

  it('refuses foreign or diagnostic-only prerequisites, wrong host and a regressing clock', async () => {
    const { options, trace } = model();
    expect(() => createWorkerComparisonModel({ ...options, prerequisite: { ...prerequisite, source: 'c'.repeat(40) } })).toThrow(/same-source/);
    expect(() => createWorkerComparisonModel({ ...options, prerequisite: { ...prerequisite, kind: 'functional-diagnostic-only' } })).toThrow(/same-source/);
    expect(() => createWorkerComparisonModel({ ...options, host: { ...host, effectiveCpus: 8 } })).toThrow(/host profile/);
    const result = await createWorkerComparisonModel({ ...options, now: () => anchorMs - 1 }).run();
    expect(trace).toEqual([]);
    expect(result.cells.every(row => row.state === 'not-entered' && row.reason === 'clock')).toBe(true);
  });
});
