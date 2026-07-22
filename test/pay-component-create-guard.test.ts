/**
 * 911b2886 — Pay Code maintenance split-screen: the CREATE-mode duplicate guard.
 *
 * upsertPayComponent is deliberately upsert-by-code (the seed depends on that idempotency) with NO
 * uniqueness rejection, and the code lookup has no archivedAt filter — so a create colliding with an
 * existing code would silently overwrite that row's statutory configuration, and a code held by an
 * ARCHIVED row would update the invisible archived row without clearing archivedAt (the black hole).
 * createPayComponent is the service-level guard the dedicated /new screen calls: it refuses both
 * collisions with PayComponentCodeExistsError (carrying the code + an archived flag so the UI can say
 * "reactivate it instead"), and otherwise delegates to the unchanged upsert path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import {
  archivePayComponent,
  createPayComponent,
  listPayComponents,
  PayComponentCodeExistsError,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const input = (code: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  code,
  name: `${code} component`,
  kind: 'allowance',
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  prorates: true,
  ...over,
});

describe('911b2886 — createPayComponent duplicate-code guard', () => {
  let base: Base;
  let a: SessionContext;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    a = adminCtx(base);
  });
  afterAll(async () => {
    await closeAll();
  });

  it('rejects a code held by an existing ACTIVE component (archived flag false)', async () => {
    await upsertPayComponent(a, input('TRANSPORT'));
    await expect(createPayComponent(a, input('TRANSPORT'))).rejects.toThrow(PayComponentCodeExistsError);
    const err = await createPayComponent(a, input('TRANSPORT', { name: 'Would overwrite' })).catch((e) => e);
    expect(err).toBeInstanceOf(PayComponentCodeExistsError);
    expect(err.code).toBe('TRANSPORT');
    expect(err.archived).toBe(false);
    // The guard refused BEFORE any write: the existing row's configuration is untouched.
    const [row] = (await listPayComponents(a)).filter((c) => c.code === 'TRANSPORT');
    expect(row.name).toBe('TRANSPORT component');
  });

  it('rejects a code held by an ARCHIVED component with archived=true (the black-hole case)', async () => {
    const { id } = await upsertPayComponent(a, input('PARKING'));
    await archivePayComponent(a, { id, archived: true });
    const err = await createPayComponent(a, input('PARKING')).catch((e) => e);
    expect(err).toBeInstanceOf(PayComponentCodeExistsError);
    expect(err.code).toBe('PARKING');
    expect(err.archived).toBe(true);
    // The archived row was NOT silently updated / reactivated.
    const rows = await listPayComponents(a, { includeArchived: true });
    const parking = rows.find((c) => c.code === 'PARKING')!;
    expect(parking.archivedAt).not.toBeNull();
  });

  it('succeeds on a fresh code and emits pay-component.created', async () => {
    const { id } = await createPayComponent(a, input('MEAL', { includedInHrdfBase: true }));
    const rows = await listPayComponents(a);
    const meal = rows.find((c) => c.code === 'MEAL')!;
    expect(meal.id).toBe(id);
    expect(meal.includedInHrdfBase).toBe(true);
    expect(await eventTypesFor(base.tenantId, id)).toContain('pay-component.created');
  });

  it('upsertPayComponent still updates-by-code unchanged (seed idempotency contract)', async () => {
    const first = await upsertPayComponent(a, input('PHONE'));
    const second = await upsertPayComponent(a, input('PHONE', { name: 'Phone allowance v2' }));
    expect(second.id).toBe(first.id); // same row, updated in place — no throw, no duplicate
    const rows = await listPayComponents(a);
    expect(rows.filter((c) => c.code === 'PHONE')).toHaveLength(1);
    expect(rows.find((c) => c.code === 'PHONE')!.name).toBe('Phone allowance v2');
    expect(await eventTypesFor(base.tenantId, first.id)).toContain('pay-component.updated');
  });
});
