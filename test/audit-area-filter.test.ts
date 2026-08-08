/**
 * f1b994e3 — the Audit Trail's AREA (module) filter, and the promise that makes it trustworthy.
 *
 * The reporter asked for the Leave Config audit page to be folded into the one central Audit Trail.
 * There was never a second store: both pages read the same append-only domain_event ledger through the
 * same `auditWhere` predicate. What the leave page had that the central page did not was a filter — and
 * it built that filter from its OWN hardcoded eight-aggregate list, which is exactly how it came to
 * disagree with the module chip rendered on every row: it hid 404 real leave rows and listed job-grade
 * rows the chip calls Organization.
 *
 * So the property worth pinning is not "the filter works" but "the filter and the chip are the same
 * statement". Both now read AGGREGATE_MODULE, and the first test below asserts the agreement for EVERY
 * aggregate type in that map, one seeded row each — a new mapping cannot be added on one side only.
 *
 * Three more properties, each a way this could quietly hurt someone:
 *   - `leave` really does reach the six aggregate types the old page could not show (they are the bulk
 *     of the 404 invisible rows, including the newest leave-config changes on production);
 *   - `other` is the RESIDUAL bucket — an unmapped type must be findable, not merely un-chipped, which
 *     is why auditWhere expresses it as the complement rather than as an empty IN-list;
 *   - an out-of-set `?module=` is IGNORED (the whole log), never narrowed to nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { withTenant } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { auditEvents, auditEventsCount } from '../core/read';
import {
  MAPPED_AGGREGATE_TYPES,
  MODULE_KEYS,
  aggregateTypesForModule,
  isModuleKey,
  moduleKeyOf,
  type ModuleKey,
} from '../lib/audit-format';

let b: Base;

/** Aggregate types with NO mapping — they must chip `other` AND be found by the Other area. */
const UNMAPPED = ['feedback-item', 'notice', 'made-up-aggregate'] as const;

/** One event per aggregate type, so every type in the map is represented exactly once. */
const SEEDED = [...MAPPED_AGGREGATE_TYPES, ...UNMAPPED];

async function seedOneEventPerAggregateType(ctx: ReturnType<typeof adminCtx>) {
  await withTenant(ctx, async (tx) => {
    for (const aggregateType of SEEDED) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType,
        aggregateId: randomUUID(),
        eventType: `${aggregateType}.updated`,
        actor: actorOf(ctx),
        payload: {},
      });
    }
  });
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('f1b994e3 — Audit Trail Area filter', () => {
  it('the Area filter and the module chip agree for EVERY aggregate type in the map', async () => {
    const ctx = adminCtx(b);
    await seedOneEventPerAggregateType(ctx);

    // What each area returns, as aggregate types.
    const found = new Map<ModuleKey, string[]>();
    for (const m of MODULE_KEYS) {
      const rows = await auditEvents(ctx, { module: m, limit: 500 });
      found.set(
        m,
        rows.map((r) => r.aggregateType).sort(),
      );
    }

    // 1. Every type the map knows is returned by ITS OWN area and by no other — i.e. the area that
    //    finds a row is always the area the row's chip prints.
    for (const type of SEEDED) {
      const chip = moduleKeyOf(type);
      for (const m of MODULE_KEYS) {
        const inArea = found.get(m)!.includes(type);
        expect(inArea, `${type} chips ${chip} but area ${m} ${inArea ? 'returns' : 'omits'} it`).toBe(
          m === chip,
        );
      }
    }

    // 2. Every seeded row is reachable from exactly one area — no row is orphaned by the filter.
    const total = [...found.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(SEEDED.length);
  });

  it('leave reaches the six aggregate types the retired page could never show', async () => {
    const ctx = adminCtx(b);
    await seedOneEventPerAggregateType(ctx);
    const rows = await auditEvents(ctx, { module: 'leave', limit: 500 });
    const types = new Set(rows.map((r) => r.aggregateType));
    // The 394 invisible production rows sat in these six. holiday / holiday-group were already mapped
    // and only the page's hardcoded list gated them, so they are asserted here too.
    for (const t of [
      'scheme-leave-entitlement',
      'leave-ledger',
      'leave-approval-template',
      'scheme-leave-combined-limit',
      'leave-shared-group',
      'holiday-group-holiday',
      'holiday',
      'holiday-group',
    ]) {
      expect(types.has(t), `Leave must reach ${t}`).toBe(true);
    }
    // job-grade STAYS Organization. The retired leave page listed grade changes; the central page has
    // always CHIPPED them Organization, so honouring the mapping removes a contradiction.
    expect(types.has('job-grade')).toBe(false);
    expect(moduleKeyOf('job-grade')).toBe('organization');
    const orgTypes = (await auditEvents(ctx, { module: 'organization', limit: 500 })).map((r) => r.aggregateType);
    expect(orgTypes).toContain('job-grade');
  });

  it('`other` is the residual bucket — unmapped types are findable, not just un-chipped', async () => {
    const ctx = adminCtx(b);
    await seedOneEventPerAggregateType(ctx);
    const rows = await auditEvents(ctx, { module: 'other', limit: 500 });
    expect(rows.map((r) => r.aggregateType).sort()).toEqual([...UNMAPPED].sort());
    // aggregateTypesForModule('other') is honestly empty — the complement, not an IN-list, is what makes
    // the area work. If auditWhere ever "simplified" to inArray([]) this count would collapse to 0.
    expect(aggregateTypesForModule('other')).toEqual([]);
    expect(await auditEventsCount(ctx, { module: 'other' })).toBe(UNMAPPED.length);
  });

  it('an out-of-set ?module= is IGNORED, not narrowed to nothing', async () => {
    const ctx = adminCtx(b);
    await seedOneEventPerAggregateType(ctx);
    // This is what the page does with the raw query param: anything not a ModuleKey becomes undefined.
    for (const raw of ['leaves', 'LEAVE', 'payroll ', '', 'undefined', "leave' or 1=1--"]) {
      expect(isModuleKey(raw), `${raw} must not pass as an area`).toBe(false);
    }
    const chosen = isModuleKey('leaves') ? ('leaves' as ModuleKey) : undefined;
    const rows = await auditEvents(ctx, { module: chosen, limit: 500 });
    // The whole log, not an empty page — the leave page's treatment of an out-of-set ?type=.
    expect(rows.length).toBe(SEEDED.length);
    expect(isModuleKey('leave')).toBe(true);
  });

  it('every named area owns at least one aggregate type (an empty IN-list would match nothing)', () => {
    for (const m of MODULE_KEYS) {
      const types = aggregateTypesForModule(m);
      if (m === 'other') expect(types).toEqual([]);
      else expect(types.length, `area ${m} resolves to no aggregate types`).toBeGreaterThan(0);
    }
    // The sets partition the map: no type belongs to two areas, none is missed.
    const union = MODULE_KEYS.flatMap((m) => aggregateTypesForModule(m)).sort();
    expect(union).toEqual([...MAPPED_AGGREGATE_TYPES].sort());
  });
});
