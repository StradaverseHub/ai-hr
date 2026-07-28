/**
 * Record relationship explorer (deec1691) — the generated half of the requested dependency explorer.
 *
 * Two properties are worth pinning, and neither is "the query returns rows":
 *
 *   1. IT IS GENERATED, NOT AUTHORED. Nothing about the topology is written down in this repo, so the
 *      test asserts against pg_catalog and against the packs' own `satelliteTables` declarations rather
 *      than against a hand-written expected map. A hard-coded parent list would be exactly the stale
 *      artefact the plan refused to build, reproduced in the test suite.
 *   2. IT IS OPERATOR-ONLY. The request asked for this on tenant System Settings; schema topology in a
 *      multi-tenant product is information disclosure, so the gate and the PLACEMENT are both asserted —
 *      the placement by reading the source tree, because a future page under app/admin would compile and
 *      pass every other test here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { describeTableRelationships, listSchemaTables } from '../core/schema-explorer';
import { NotOperatorError } from '../core/operator';
import { listPacks, type ModulePack } from '../packs/registry';
import '../packs/register-all';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

async function operatorCtx(base: Base): Promise<SessionContext> {
  const [opUser] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: base.tenantId, workosUserId: `op_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: base.tenantId, appUserId: opUser.id, companyId: null, role: 'operator' });
  return {
    tenantId: base.tenantId,
    userId: opUser.id,
    roles: ['operator'],
    grants: [{ role: 'operator', companyId: null }],
  };
}

describe('deec1691 — record relationship explorer', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('reads BOTH directions of every foreign key from the live catalog', async () => {
    const op = await operatorCtx(await seedBase());
    const employment = await describeTableRelationships(op, 'employment');
    expect(employment).not.toBeNull();
    expect(employment!.primaryKey).toEqual(['id']);

    // The expectation is derived from pg_catalog, not typed out: whatever the schema currently says
    // about employment is what the explorer must say. This is the property the whole feature rests on.
    const expected = (await owner.db.execute(
      sql`
        select src.relname as from_table, tgt.relname as to_table
          from pg_constraint c
          join pg_class src on src.oid = c.conrelid
          join pg_class tgt on tgt.oid = c.confrelid
          join pg_namespace sn on sn.oid = src.relnamespace
         where c.contype = 'f' and sn.nspname = 'public'
           and (src.relname = 'employment' or tgt.relname = 'employment')`,
    )) as unknown as { from_table: string; to_table: string }[];

    expect(employment!.references.map((e) => e.toTable).sort()).toEqual(
      expected.filter((e) => e.from_table === 'employment').map((e) => e.to_table).sort(),
    );
    expect(employment!.referencedBy.map((e) => e.fromTable).sort()).toEqual(
      expected.filter((e) => e.to_table === 'employment').map((e) => e.from_table).sort(),
    );
    // Sanity that the schema under test is the one we think it is — an employment IS pointed at by
    // the leave ledger and the payslip, which is the "which records hang off this one" question the
    // reporter actually asked.
    expect(employment!.referencedBy.map((e) => e.fromTable)).toEqual(
      expect.arrayContaining(['leave_request', 'payslip']),
    );
    // Every edge carries the referential action, so "what happens to the children" is answerable
    // without opening a migration.
    expect(employment!.references.every((e) => e.onDelete.length > 0)).toBe(true);
  });

  it('shows a self-referencing table on BOTH sides rather than hiding the cycle', async () => {
    const op = await operatorCtx(await seedBase());
    const dept = await describeTableRelationships(op, 'department');
    expect(dept!.references.map((e) => e.toTable)).toContain('department');
    expect(dept!.referencedBy.map((e) => e.fromTable)).toContain('department');
  });

  it('takes module ownership from the packs own satelliteTables declarations, both directions', async () => {
    const op = await operatorCtx(await seedBase());
    const rows = await listSchemaTables(op);
    const owned = new Map(rows.map((r) => [r.table, r.moduleCode]));

    // Forward: every table a registered pack declares (and that actually exists) is reported as that
    // pack's. This is what makes the "related module" column real rather than guessed.
    for (const pack of listPacks('module') as ModulePack[]) {
      for (const decl of pack.satelliteTables ?? []) {
        if (!owned.has(decl.table)) continue; // declared but not in this schema — not this test's business
        expect(owned.get(decl.table), `${decl.table} is declared by the ${pack.id} pack`).toBe(pack.id);
      }
    }

    // Reverse: an unclaimed table reports NO module rather than a plausible-looking guess. person and
    // employment are the shared spine (ADR-0080 D5) and belong to no pack.
    expect(owned.get('person')).toBeNull();
    expect(owned.get('employment')).toBeNull();
    // …and a pack-owned one is not left unclaimed.
    expect(owned.get('leave_request')).toBe('leave');
    expect(owned.get('attendance_punch')).toBe('attendance');
  });

  it('returns null for a name that is not a table, and never builds SQL from it', async () => {
    const op = await operatorCtx(await seedBase());
    expect(await describeTableRelationships(op, 'no_such_table')).toBeNull();
    // The name arrives from a query string. Bound, not interpolated — so this is a miss, not a syntax
    // error and not a second statement.
    expect(await describeTableRelationships(op, `x'; drop table employment; --`)).toBeNull();
    expect(await owner.db.select().from(schema.employment)).toBeDefined();
  });

  it('refuses a non-operator — including a group admin, who is not an operator', async () => {
    const base = await seedBase();
    const adminCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['group_admin'],
      grants: [{ role: 'group_admin', companyId: null }],
    };
    await expect(listSchemaTables(adminCtx)).rejects.toBeInstanceOf(NotOperatorError);
    await expect(describeTableRelationships(adminCtx, 'employment')).rejects.toBeInstanceOf(NotOperatorError);
  });

  it('is mounted on the operator plane ONLY — no admin or settings screen reads it', () => {
    // Read-the-file, the same ratchet the module-catalog suite applies to migrations. The request asked
    // for this under System Settings; the plan refused because it exposes the product's schema topology
    // to a customer administrator. That refusal is a placement decision, so it is pinned by placement —
    // a page under app/admin would type-check and pass every other test in this file.
    const root = path.resolve(__dirname, '..');
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('core/schema-explorer')) {
          importers.push(path.relative(root, p).split(path.sep).join('/'));
        }
      }
    };
    for (const d of ['app', 'components']) walk(path.join(root, d));

    expect(
      importers.filter((f) => !f.startsWith('app/operator/')),
      'core/schema-explorer describes the schema topology of a multi-tenant product. It belongs to the ' +
        'operator plane (app/operator/**) and must never be reachable by a tenant administrator — see ' +
        'the header of core/schema-explorer.ts.',
    ).toEqual([]);
    expect(importers, 'the explorer page itself must still exist').toContain('app/operator/schema/page.tsx');
  });
});
