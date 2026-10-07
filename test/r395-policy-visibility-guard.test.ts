/**
 * r395 / migration 0515 — GUARD: no policy USING clause may call the per-row visibility functions.
 *
 * `app.can_see_employment(col)` / `app.can_see_person(col)` in a USING clause is evaluated once PER SCANNED
 * ROW, and for a non-admin each call walks the caller's reporting tree and department tree (r394 measured
 * 1.5 s for 1,032 feedback_request rows). 0515 rewrote every such clause to the set form
 * `col = ANY ((SELECT app.visible_employment_ids())::uuid[])`, which is an InitPlan computed once per
 * statement. This file keeps it that way:
 *
 *   1. in the MIGRATED schema, the set of policies whose USING still calls either function is EMPTY — a new
 *      policy written in the per-row form turns this red. WITH CHECK may still call them (evaluated per
 *      inserted/updated row, which is the right cost), and does on 34 policies.
 *   2. the policies 0515 rewrote are exactly the fixture's 57 (test/fixtures/r395-policy-quals.json,
 *      generated from pg_policies before and after 0515), each with the fixture's post-0515 USING text and
 *      its WITH CHECK text UNCHANGED from before 0515.
 *   3. the migration file's ALTER POLICY statements name exactly those 57 and set no WITH CHECK.
 *   4. the set form really is planned as an InitPlan (the `(SELECT …)` wrapper is load-bearing).
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { closeAll, owner } from './harness';

type Policy = { table: string; policy: string; cmd: string; calls: number; oldQual: string; newQual: string; withCheck: string | null };
const FIXTURE = JSON.parse(readFileSync('test/fixtures/r395-policy-quals.json', 'utf8')) as { policies: Policy[] };
const MIGRATION = readFileSync('db/migrations/0515_set_based_visibility.sql', 'utf8');
const key = (t: string, p: string) => `${t}.${p}`;

afterAll(async () => {
  await closeAll();
});

type Row = Record<string, unknown>;
const q = async (text: string, params: unknown[] = []) => (await owner.client.unsafe(text, params as never[])) as unknown as Row[];

describe('r395 — per-row visibility functions are gone from every policy USING clause', () => {
  it('pg_policies: no USING clause calls app.can_see_employment( or app.can_see_person(', async () => {
    const all = await q(`select tablename, policyname, qual, with_check from pg_policies order by tablename, policyname`);
    expect(all.length, 'pg_policies is readable and populated').toBeGreaterThan(200);
    const perRow = all
      .filter((r) => /app\.can_see_(employment|person)\(/.test(String(r.qual ?? '')))
      .map((r) => key(r.tablename as string, r.policyname as string));
    expect(perRow, 'policies whose USING still calls the per-row functions').toEqual([]);
    // WITH CHECK is allowed to (one row per check). It is non-vacuous that some still do.
    const inCheck = all.filter((r) => /app\.can_see_(employment|person)\(/.test(String(r.with_check ?? '')));
    expect(inCheck.length).toBeGreaterThan(0);
  });

  it('the 57 rewritten policies carry the fixture USING text and an UNCHANGED WITH CHECK', async () => {
    expect(FIXTURE.policies.length).toBe(57);
    const live = new Map(
      (await q(`select tablename, policyname, qual, with_check from pg_policies`)).map((r) => [key(r.tablename as string, r.policyname as string), r]),
    );
    for (const p of FIXTURE.policies) {
      const r = live.get(key(p.table, p.policy));
      expect(r, `${key(p.table, p.policy)} exists`).toBeTruthy();
      expect(r!.qual, `${key(p.table, p.policy)} USING`).toBe(p.newQual);
      expect(r!.with_check ?? null, `${key(p.table, p.policy)} WITH CHECK unchanged`).toBe(p.withCheck);
      expect(p.oldQual, `${key(p.table, p.policy)} old USING called a per-row function`).toMatch(/app\.can_see_(employment|person)\(/);
      expect(p.newQual).toMatch(/visible_(employment|person)_ids\(\)/);
    }
  });

  it('the migration ALTERs exactly the fixture policies, USING only', () => {
    const alters = [...MIGRATION.matchAll(/^ALTER POLICY "([a-z0-9_]+)" ON "([a-z0-9_]+)"\n([\s\S]*?);\n--> statement-breakpoint/gm)];
    expect(alters.length).toBe(57);
    const inFile = alters.map((m) => key(m[2], m[1])).sort();
    expect(inFile).toEqual(FIXTURE.policies.map((p) => key(p.table, p.policy)).sort());
    for (const m of alters) {
      expect(m[3], `${m[2]}.${m[1]} sets no WITH CHECK`).not.toMatch(/WITH CHECK/);
      expect(m[3], `${m[2]}.${m[1]} no per-row call left`).not.toMatch(/can_see_(employment|person)/);
      expect(m[3]).toMatch(/^\s+USING \(/);
    }
  });

  it('the set form is an InitPlan (evaluated once per statement), not a per-row call', async () => {
    const plans: string[] = [];
    await owner.client.begin(async (tx) => {
      await tx.unsafe(`select set_config('app.tenant_id', gen_random_uuid()::text, true), set_config('app.user_id', gen_random_uuid()::text, true)`);
      await tx.unsafe(`set local role ai_hr_app`);
      for (const t of ['feedback_request', 'leave_request', 'person', 'employment']) {
        const rows = (await tx.unsafe(`explain (costs off) select * from "${t}"`)) as unknown as Row[];
        plans.push(rows.map((r) => r['QUERY PLAN']).join('\n'));
      }
    });
    for (const p of plans) {
      expect(p).toMatch(/InitPlan/);
      expect(p).toMatch(/ANY \(\$\d+\)|= ANY \(\(InitPlan/);
      expect(p).not.toMatch(/can_see_(employment|person)/);
    }
  });
});
