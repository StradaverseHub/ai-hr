/** Native Lifecycle hub tile baseline: status, tenant and current company authority before counting. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { client, type SessionContext } from '../db/client';
import { company, itAssetCatalogue, itAssetRequest, itRequisition, lcCase, lcCaseStep } from '../db/schema';
import * as lifecycle from '../packs/lifecycle/service';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);
afterEach(() => vi.restoreAllMocks());

const readTileSources = (ctx: SessionContext) => Promise.all([
  lifecycle.listCases(ctx, 'onboarding'), lifecycle.listCases(ctx, 'offboarding'),
  lifecycle.listRequisitions(ctx, { status: 'open' }), lifecycle.pendingApprovals(ctx),
]);

it('profiles existing tile cardinality with capped active lists and exact current-company approvals', async () => {
  await resetDb();
  const b = await seedBase();
  await setModule(b.tenantId, 'lifecycle', 'active');
  const admin = await entitledCtx(b);
  const [other, denied] = await owner.db.insert(company).values([
    { tenantId: b.tenantId, legalName: 'Fictional agent scope' },
    { tenantId: b.tenantId, legalName: 'Fictional excluded scope' },
  ]).returning();
  const userId = await createAppUser(b.tenantId, null, 'employee');
  const manager: SessionContext = { ...await entitledCtx(b, ['employee']), userId, personId: null, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  await lifecycle.setStaff(admin, { userId, companyId: b.companyId, level: 'manager' });
  await lifecycle.setStaff(admin, { userId, companyId: other.id, level: 'agent' });

  const note = 'Fictional retained details '.repeat(48);
  const makeCase = (kind: 'onboarding' | 'offboarding', companyId: string, number: string, status = 'in_progress') => ({
    id: randomUUID(), tenantId: b.tenantId, companyId, kind, number, fullName: 'Fictional case', employeeNo: number,
    status, outcome: kind === 'onboarding' ? 'pending' : 'accepted', notes: note,
  });
  const cases = [
    ...Array.from({ length: 1001 }, (_, i) => makeCase('onboarding', b.companyId, `ONB-TILE-${String(i).padStart(5, '0')}`)),
    ...Array.from({ length: 997 }, (_, i) => makeCase('offboarding', b.companyId, `OFB-TILE-${String(i).padStart(5, '0')}`)),
    ...Array.from({ length: 3 }, (_, i) => makeCase('offboarding', other.id, `OFB-AGENT-${i}`)),
    makeCase('offboarding', denied.id, 'OFB-DENIED'), makeCase('onboarding', denied.id, 'ONB-DENIED'),
    makeCase('onboarding', b.companyId, 'ONB-HISTORICAL', 'completed'),
  ];
  for (let offset = 0; offset < cases.length; offset += 250) await owner.db.insert(lcCase).values(cases.slice(offset, offset + 250));
  const steps = cases.filter(row => row.companyId === b.companyId && row.kind === 'onboarding')
    .map(row => ({ tenantId: b.tenantId, caseId: row.id, stepKey: 'laptop_dist', done: true }));
  for (let offset = 0; offset < steps.length; offset += 250) await owner.db.insert(lcCaseStep).values(steps.slice(offset, offset + 250));
  const req = (companyId: string, number: string, status: string, approvalStatus: string) => ({
    tenantId: b.tenantId, companyId, number, kind: 'standalone', status, approvalStatus,
    approvalLevels: approvalStatus === 'pending_l2' ? 2 : 1, fullName: 'Fictional requisition', employeeNo: number, notes: note,
  });
  await owner.db.insert(itRequisition).values([
    req(b.companyId, 'REQ-PENDING', 'open', 'pending'), req(b.companyId, 'REQ-SECOND', 'open', 'pending_l2'),
    req(b.companyId, 'REQ-APPROVED', 'open', 'approved'), req(b.companyId, 'REQ-CANCELLED', 'cancelled', 'pending'),
    req(other.id, 'REQ-AGENT', 'open', 'pending'), req(denied.id, 'REQ-DENIED', 'open', 'pending'),
  ]);
  const [catalogue] = await owner.db.insert(itAssetCatalogue).values({ tenantId: b.tenantId, itemCode: 'TILE_ITEM', itemName: 'Fictional item', category: 'hardware' }).returning();
  const asset = (companyId: string, number: string, status: string) => ({
    tenantId: b.tenantId, companyId, number, status, catalogueId: catalogue.id,
    requesterUserId: userId, fullName: 'Fictional asset requester', justification: note,
  });
  await owner.db.insert(itAssetRequest).values([
    asset(b.companyId, 'AR-REQUESTED', 'requested'), asset(b.companyId, 'AR-SECOND', 'pending_approval'),
    asset(b.companyId, 'AR-APPROVED', 'approved'), asset(other.id, 'AR-AGENT-OWN', 'requested'), asset(denied.id, 'AR-DENIED-OWN', 'requested'),
  ]);

  const nativeBegin = client.begin.bind(client);
  let capture = true;
  const sqlReads: string[] = [];
  vi.spyOn(client, 'begin').mockImplementation(((...args: unknown[]) => {
    const index = args.findIndex(arg => typeof arg === 'function');
    const callback = args[index] as (native: typeof client) => unknown;
    args[index] = (native: typeof client) => callback(new Proxy(native, { get(target, key, receiver) {
      if (key === 'unsafe') return (...query: unknown[]) => {
        if (capture && typeof query[0] === 'string') sqlReads.push(query[0].toLowerCase());
        return Reflect.apply(target.unsafe, target, query);
      };
      return Reflect.get(target, key, receiver);
    } }));
    return Reflect.apply(nativeBegin, client, args);
  }) as typeof client.begin);
  const start = performance.now();
  const reference = await readTileSources(manager);
  const elapsedMs = performance.now() - start;
  capture = false;
  const [onboarding, offboarding, open, pending] = reference;
  expect(onboarding).toHaveLength(1000);
  expect(onboarding.every(row => row.companyId === b.companyId && row.status === 'in_progress')).toBe(true);
  expect(offboarding).toHaveLength(1000);
  expect(offboarding.filter(row => row.companyId === other.id)).toHaveLength(3);
  expect(open.map(row => row.number).sort()).toEqual(['REQ-AGENT', 'REQ-APPROVED', 'REQ-PENDING', 'REQ-SECOND']);
  expect(pending.requisitions.map(row => row.number)).toEqual(['REQ-PENDING', 'REQ-SECOND']);
  expect(pending.assetRequests.map(row => row.number)).toEqual(['AR-REQUESTED', 'AR-SECOND']);
  expect(sqlReads.some(text => text.includes('from "lc_case_step"'))).toBe(true);
  expect(sqlReads.some(text => text.includes('"notes"'))).toBe(true);
  const foreign = await seedBase();
  await setModule(foreign.tenantId, 'lifecycle', 'active');
  expect(await readTileSources(await entitledCtx(foreign))).toEqual([[], [], [], { requisitions: [], assetRequests: [] }]);
  await lifecycle.setStaff(admin, { userId, companyId: b.companyId, level: null });
  const [afterOn, afterOff, afterOpen, afterPending] = await readTileSources(manager);
  expect([afterOn.length, afterOff.length, afterOpen.length, afterPending]).toEqual([0, 3, 1, { requisitions: [], assetRequests: [] }]);
  await lifecycle.setStaff(admin, { userId, companyId: other.id, level: null });
  await expect(lifecycle.listCases(manager, 'onboarding')).rejects.toMatchObject({ code: 'forbidden' });

  const evidence = {
    kind: 'NATIVE_LIFECYCLE_HUB_TILE_BASELINE_ONLY', releaseEligible: false,
    activeVisibleOnboarding: 1001, activeVisibleOffboarding: 1000,
    cappedOnboardingRows: onboarding.length, cappedOffboardingRows: offboarding.length,
    openRequisitionRows: open.length, exactPendingRequisitions: pending.requisitions.length, exactPendingAssets: pending.assetRequests.length,
    applicationRoundTrips: sqlReads.length, materializedDtoBytes: Buffer.byteLength(JSON.stringify(reference)), elapsedMs,
    nativeAuthorityControls: true, providerCalls: 0, limitations: 'Native component on fictional retained data only. No browser or capacity claim.',
  };
  if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR, 'lifecycle-hub-count-profile.json'), JSON.stringify(evidence, null, 2));
}, 300000);
