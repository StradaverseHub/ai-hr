import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { clockingImportJobHandler, getClockingImportJob, startClockingImportJob } from '../core/attendance-clocking-import-job';
import { bulkJobWaitingTx } from '../core/bulk-job';
import { runBulkJobTick } from '../core/bulk-job-worker';
import { withTenant } from '../db/client';
import { BUILTIN_MAPPING_ID } from '../lib/clocking-file';
import { buildAttendanceFixture } from './helpers/attendance-bulk-fixture';
import { closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';

const draft = readFileSync(new URL('./fixtures/clocking-import-tenant-queue.sql', import.meta.url), 'utf8');
const tick = () => runBulkJobTick(owner.client, { handlers: [clockingImportJobHandler] });

beforeAll(migrateTestDb);
afterAll(closeAll);

it('admits a second file behind a retained import and processes both in order', async () => {
  await resetDb();
  const base = await seedBase();
  const fixture = await buildAttendanceFixture(base, { employees: 8 });
  const ctx = fixture.ctx;
  const older = await startClockingImportJob(ctx, {
    mappingId: BUILTIN_MAPPING_ID,
    text: fixture.uncodedFile,
    fileName: 'clocking-first.csv',
    fileBytes: Buffer.byteLength(fixture.uncodedFile),
  });
  let installed = false;
  try {
    await owner.client.unsafe(draft);
    installed = true;
    await expect(owner.client.unsafe(draft)).rejects.toMatchObject({ code: '55000' });
    const followUp = {
      mappingId: fixture.codedMappingId,
      text: fixture.codedFile,
      fileName: 'clocking-second.csv',
      fileBytes: Buffer.byteLength(fixture.codedFile),
      operationKey: randomUUID(),
    };
    const newer = await startClockingImportJob(ctx, followUp);
    expect(newer.existing).toBe(false);
    expect(newer.job.id).not.toBe(older.job.id);
    const retry = await startClockingImportJob(ctx, followUp);
    expect([retry.existing, retry.job.id]).toEqual([true, newer.job.id]);

    const waiting = () => withTenant(ctx, tx => bulkJobWaitingTx(tx, newer.job.id));
    expect(await waiting()).toBe(true);
    const preparing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const firstWorker = runBulkJobTick(owner.client, {
      handlers: [{
        ...clockingImportJobHandler,
        async prepare(session, job) {
          expect(job.id).toBe(older.job.id);
          preparing.resolve();
          await resume.promise;
          return clockingImportJobHandler.prepare(session, job);
        },
      }],
    });
    try {
      await Promise.race([
        preparing.promise,
        firstWorker.then(() => { throw new Error('First worker did not prepare the older import'); }),
      ]);
      expect(await tick()).toBe(false);
      expect((await getClockingImportJob(ctx, newer.job.id)).state).toBe('queued');
    } finally {
      resume.resolve();
      await firstWorker;
    }

    for (const id of [older.job.id, newer.job.id]) {
      for (let step = 0; step < 1000; step++) {
        if ((await getClockingImportJob(ctx, id)).state === 'completed') break;
        expect(await tick()).toBe(true);
      }
      const job = await getClockingImportJob(ctx, id);
      expect(job.state).toBe('completed');
      expect(job.result?.imported).toBeGreaterThan(0);
      expect(job.result?.runId).toBeTruthy();
      if (id === older.job.id) {
        expect((await getClockingImportJob(ctx, newer.job.id)).state).toBe('queued');
        expect(await waiting()).toBe(false);
      }
    }

    const [summary] = await owner.client`
      select count(*)::int as runs, count(distinct r.id)::int as distinct_runs
      from clocking_import_run r where r.tenant_id=${base.tenantId}::uuid
        and r.file_name in ('clocking-first.csv','clocking-second.csv') and r.imported_lines>0
    `;
    expect(summary).toEqual({ runs: 2, distinct_runs: 2 });
  } finally {
    if (installed) {
      const restored = await owner.client`
        update bulk_job_kind set exclusive='tenant' where kind='clocking_import'
          and exclusive='tenant_queue' returning exclusive
      `;
      expect([...restored]).toEqual([{ exclusive: 'tenant' }]);
    }
  }
  // Allow the existing populated fixture and real worker to finish both files on a shared CI host.
}, 180_000);
