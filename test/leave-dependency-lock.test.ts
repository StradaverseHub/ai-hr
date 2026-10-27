/** Authored two-connection DB acceptance; UNRUN until the coordinated runtime window. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type Tx } from '../db/client';
import { lockLeaveDependenciesTx, lockLeaveDependencyConfigurationTx, lockLeaveDependencyReadConfigurationTx,lockLeaveReadOnlySourceConfigurationTx,lockLeaveReadOnlySourceDependenciesTx, LeaveDependencyUnavailable } from '../core/leave-dependency-lock';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const signal = () => {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
describe('participating leave dependency locks, not universal fencing', () => {
  let base: Base;
  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => { await resetDb(); base = await seedBase(); });
  afterAll(async () => { await closeAll(); });
  async function held(acquire: (tx: Tx) => Promise<void>, check: () => Promise<void>) {
    const ready = signal(), release = signal();
    // This watchdog bounds the test's owned transaction even if an assertion/handshake fails.
    const timer = setTimeout(() => { ready.reject(new Error('owned lock handshake timed out')); release.resolve(); }, 10_000);
    const holder = withTenant(adminCtx(base), async tx => { await acquire(tx); ready.resolve(); await release.promise; });
    void holder.catch(ready.reject);
    try { await ready.promise; await check(); }
    finally { release.resolve(); clearTimeout(timer); await holder; }
  }
  it('refuses a competing same-employment command and permits a different subject', async () => {
    const subject = randomUUID(), other = randomUUID(), ctx = adminCtx(base);
    await held(tx => lockLeaveDependenciesTx(tx, base.tenantId, [subject]), async () => {
      await expect(withTenant(ctx, tx => lockLeaveDependenciesTx(tx, base.tenantId, [subject])))
        .rejects.toThrow(LeaveDependencyUnavailable);
      await withTenant(ctx, tx => lockLeaveDependenciesTx(tx, base.tenantId, [other]));
    });
    await withTenant(ctx, tx => lockLeaveDependenciesTx(tx, base.tenantId, [subject]));
  });
  it('keeps configuration exclusive against an existing participant until rollback/commit', async () => {
    await held(tx => lockLeaveDependenciesTx(tx, base.tenantId, [randomUUID()]), async () => {
      await expect(withTenant(adminCtx(base), tx => lockLeaveDependencyConfigurationTx(tx, base.tenantId)))
        .rejects.toThrow(LeaveDependencyUnavailable);
    });
    await withTenant(adminCtx(base), tx => lockLeaveDependencyConfigurationTx(tx, base.tenantId));
  });
  it('keeps new participants out while a configuration writer owns the barrier', async () => {
    await held(tx => lockLeaveDependencyConfigurationTx(tx, base.tenantId), async () => {
      await expect(withTenant(adminCtx(base), tx => lockLeaveDependenciesTx(tx, base.tenantId, [randomUUID()])))
        .rejects.toThrow(LeaveDependencyUnavailable);
    });
  });
  it('treats accepted UUID case aliases as the SAME subject in both holder directions', async()=>{
    const subject='abcdefab-cdef-4abc-8def-abcdefabcdef',ctx=adminCtx(base);
    for(const upperHolder of [false,true]){
      const heldSubject=upperHolder?subject.toUpperCase():subject,competing=upperHolder?subject:subject.toUpperCase();
      await held(tx=>lockLeaveDependenciesTx(tx,base.tenantId,[heldSubject]),async()=>{
        await expect(withTenant(ctx,tx=>lockLeaveDependenciesTx(tx,base.tenantId.toUpperCase(),[competing]))).rejects.toThrow(LeaveDependencyUnavailable);
        await withTenant(ctx,tx=>lockLeaveDependenciesTx(tx,base.tenantId,[randomUUID()]));
      });
      await withTenant(ctx,tx=>lockLeaveDependenciesTx(tx,base.tenantId.toUpperCase(),[competing,heldSubject]));
    }
  });
  it('uses one physical configuration key for accepted uppercase tenant aliases in all entry phases',async()=>{
    const lower=base.tenantId.toLowerCase(),upper=base.tenantId.toUpperCase(),ctx=adminCtx(base);
    for(const holderTenant of [lower,upper])await held(tx=>lockLeaveDependencyConfigurationTx(tx,holderTenant),async()=>{
      for(const tenant of [lower,upper]){
        await expect(withTenant(ctx,tx=>lockLeaveDependencyReadConfigurationTx(tx,tenant))).rejects.toThrow(LeaveDependencyUnavailable);
        await expect(withTenant(ctx,tx=>lockLeaveDependencyConfigurationTx(tx,tenant))).rejects.toThrow(LeaveDependencyUnavailable);
        await expect(withTenant(ctx,tx=>lockLeaveDependenciesTx(tx,tenant,[randomUUID()]))).rejects.toThrow(LeaveDependencyUnavailable);
      }
    });
    await withTenant(ctx,tx=>lockLeaveDependencyReadConfigurationTx(tx,upper));
  });
  async function readonlySource<T>(read:(tx:Tx)=>Promise<T>){return withTenant(adminCtx(base),async tx=>{await tx.execute(sql`set transaction read only`);return read(tx);});}
  it('lets actual read-only source readers share exact subject keys while refusing ordinary exclusive writers and configuration writers',async()=>{
    const subject=randomUUID(),other=randomUUID();
    await held(async tx=>{await tx.execute(sql`set transaction read only`);await lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId,[subject]);},async()=>{
      await readonlySource(tx=>lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId,[subject]));
      await expect(withTenant(adminCtx(base),tx=>lockLeaveDependenciesTx(tx,base.tenantId,[subject]))).rejects.toThrow(LeaveDependencyUnavailable);
      await withTenant(adminCtx(base),tx=>lockLeaveDependenciesTx(tx,base.tenantId,[other]));
      await expect(withTenant(adminCtx(base),tx=>lockLeaveDependencyConfigurationTx(tx,base.tenantId))).rejects.toThrow(LeaveDependencyUnavailable);
    });
    await withTenant(adminCtx(base),tx=>lockLeaveDependenciesTx(tx,base.tenantId,[subject]));
  });
  it('keeps read-only source readers out of actual ordinary employment and configuration writer intervals, using the same canonical UUID aliases',async()=>{
    const subject='abcdefab-cdef-4abc-8def-abcdefabcdef';
    await held(tx=>lockLeaveDependenciesTx(tx,base.tenantId,[subject]),async()=>{
      await expect(readonlySource(tx=>lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId.toUpperCase(),[subject.toUpperCase()]))).rejects.toThrow(LeaveDependencyUnavailable);
      await readonlySource(tx=>lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId,[randomUUID()]));
    });
    await held(tx=>lockLeaveDependencyConfigurationTx(tx,base.tenantId),async()=>{
      await expect(readonlySource(tx=>lockLeaveReadOnlySourceConfigurationTx(tx,base.tenantId.toUpperCase()))).rejects.toThrow(LeaveDependencyUnavailable);
      await expect(readonlySource(tx=>lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId,[subject]))).rejects.toThrow(LeaveDependencyUnavailable);
    });
  });
  it('preserves disjoint actual transaction-mode contracts: source-read helpers refuse writable, ordinary writers still refuse read-only, and no helper changes mode',async()=>{
    const id=randomUUID();
    await expect(withTenant(adminCtx(base),tx=>lockLeaveReadOnlySourceConfigurationTx(tx,base.tenantId))).rejects.toThrow(LeaveDependencyUnavailable);
    await expect(withTenant(adminCtx(base),tx=>lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId,[id]))).rejects.toThrow(LeaveDependencyUnavailable);
    for(const acquire of [lockLeaveDependencyReadConfigurationTx,lockLeaveDependencyConfigurationTx])await expect(readonlySource(tx=>acquire(tx,base.tenantId))).rejects.toThrow(LeaveDependencyUnavailable);
    await expect(readonlySource(tx=>lockLeaveDependenciesTx(tx,base.tenantId,[id]))).rejects.toThrow(LeaveDependencyUnavailable);
    await readonlySource(async tx=>{await lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId,[id]);const [mode]=await tx.execute<{readonly:string}>(sql`select current_setting('transaction_read_only') as readonly`);expect(mode.readonly).toBe('on');});
  });
  it('rolls earlier partial source-read ownership back when a later ordered employment is busy',async()=>{
    const [first,last]=[randomUUID(),randomUUID()].sort();
    await held(tx=>lockLeaveDependenciesTx(tx,base.tenantId,[last]),async()=>{
      await expect(readonlySource(tx=>lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId,[last,first,last]))).rejects.toThrow(LeaveDependencyUnavailable);
      // A shared first-subject lock leaked from the failed source reader would refuse this writer.
      await withTenant(adminCtx(base),tx=>lockLeaveDependenciesTx(tx,base.tenantId,[first]));
    });
  });
  it('refuses malformed/foreign read-only source ownership without widening the actual carrier or snapshot',async()=>{
    for(const [tenant,ids] of [[randomUUID(),[randomUUID()]],[base.tenantId,[]],[base.tenantId,['invalid']]] as [string,string[]][]){await expect(readonlySource(tx=>lockLeaveReadOnlySourceDependenciesTx(tx,tenant,ids))).rejects.toThrow(LeaveDependencyUnavailable);}
    await expect(withTenant(adminCtx(base),tx=>lockLeaveReadOnlySourceDependenciesTx(tx,base.tenantId,[randomUUID()]),{readOnlySnapshot:true})).rejects.toThrow(LeaveDependencyUnavailable);
  });
  it('refuses a foreign tenant carrier and empty or malformed subject sets', async () => {
    for (const [tenant, subjects] of [[randomUUID(), [randomUUID()]], [base.tenantId, []],
      [base.tenantId, ['invalid']]] as [string, string[]][]) {
      await expect(withTenant(adminCtx(base), tx => lockLeaveDependenciesTx(tx, tenant, subjects)))
        .rejects.toThrow(LeaveDependencyUnavailable);
    }
  });
});
