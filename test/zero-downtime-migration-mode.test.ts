/**
 * ADR-0181 — the migration release-mode classifier decides whether a release's pending migrations can
 * run while the previous release keeps serving traffic (`online`), or need the stopped-service window
 * (`maintenance`). Owner decision 15 Nov 2026: code rollback + fix forward; breaking migrations may
 * take an announced window.
 *
 * Every case is executed against the real classifier on SQL written the way this repository writes
 * migrations (drizzle statement breakpoints, dollar-quoted bodies, inline CREATE TABLE checks). The
 * last block parses every committed migration, so a new SQL shape the splitter cannot read fails here
 * rather than in a production window.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM operator script without type declarations
import * as mode from '../scripts/releases/migration-release-mode.mjs';

type Finding = { tag: string; statement: number; rule: string; object: string; annotation: string | null };
type Report = { mode: 'online' | 'maintenance'; findings: Finding[]; notices: Finding[] };

const classify = (pending: string[], history: string[] = []): Report =>
  mode.classifyMigrations(
    pending.map((sql, i) => ({ tag: `9${i}_pending`, sql })),
    history.map((sql, i) => ({ tag: `0${i}_history`, sql })),
  );
const rules = (r: Report) => r.findings.map((f) => `${f.rule}:${f.object}`);

describe('statement splitting', () => {
  it('keeps semicolons and keywords inside bodies, strings and comments out of the outer DDL', () => {
    const s = mode.splitStatements(`
      -- DROP TABLE employment;
      CREATE FUNCTION app.f() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN DROP TABLE employment; END $fn$;
      --> statement-breakpoint
      /* ALTER TABLE person DROP COLUMN name; */
      INSERT INTO t VALUES ('a;b', 'it''s; DROP TABLE x');
      ALTER TABLE "Employment" ADD COLUMN note text`);
    expect(s.map((x: { text: string }) => x.text)).toEqual([
      'CREATE FUNCTION app.f() RETURNS void LANGUAGE plpgsql AS $body$',
      "INSERT INTO t VALUES ('?0', '?1')",
      'ALTER TABLE "employment" ADD COLUMN note text',
    ]);
    expect(s[1].literals).toEqual(['a;b', "it's; DROP TABLE x"]);
    expect(classify([`CREATE FUNCTION app.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DROP TABLE employment; END $$;`]).mode).toBe('online');
  });

  it('attaches a zero-downtime annotation to the next statement only', () => {
    const r = classify([`-- zero-downtime: compatible -- column unread since prod-2026-11-01.1
ALTER TABLE employment DROP COLUMN legacy_code;
ALTER TABLE person DROP COLUMN legacy_name;`]);
    expect(r.findings.map((f) => [f.object, f.annotation])).toEqual([
      ['employment', 'column unread since prod-2026-11-01.1'],
      ['person', null],
    ]);
    expect(r.mode).toBe('maintenance');
  });
});

describe('changes the running release can observe make the release maintenance', () => {
  it.each([
    ['ALTER TABLE employment DROP COLUMN employee_code', 'drop-column:employment'],
    ['ALTER TABLE employment DROP COLUMN IF EXISTS employee_code CASCADE', 'drop-column:employment'],
    ['ALTER TABLE public.employment RENAME COLUMN employee_code TO staff_code', 'rename:employment'],
    ['ALTER TABLE employment RENAME TO employment_v2', 'rename:employment'],
    ['ALTER TABLE employment ALTER COLUMN hired_on TYPE timestamptz', 'change-type:employment'],
    ['ALTER TABLE employment ALTER COLUMN hired_on SET DATA TYPE timestamptz', 'change-type:employment'],
    ['ALTER TABLE employment ALTER COLUMN hired_on SET NOT NULL', 'set-not-null:employment'],
    ['ALTER TABLE employment ADD COLUMN grade text NOT NULL', 'add-required-column:employment'],
    ['ALTER TABLE employment ADD COLUMN token uuid NOT NULL DEFAULT gen_random_uuid()', 'table-rewrite:employment'],
    ["ALTER TABLE employment ADD CONSTRAINT employment_code_ck CHECK (employee_code <> '')", 'validating-constraint:employment'],
    ['ALTER TABLE payslip ADD CONSTRAINT payslip_run_fk FOREIGN KEY (run_id) REFERENCES payroll_run(id)', 'validating-constraint:payslip'],
    ['DROP TABLE IF EXISTS leave_request_legacy', 'drop-table:leave_request_legacy'],
    ['DROP FUNCTION app.visible_employments(uuid)', 'drop-function:app.visible_employments'],
    ['ALTER FUNCTION app.visible_employments(uuid) RENAME TO visible_employments_old', 'rename:app.visible_employments'],
    ['DROP VIEW reporting.headcount', 'drop-view:reporting.headcount'],
  ])('%s', (sql, expected) => {
    const r = classify([sql]);
    expect(rules(r)).toEqual([expected]);
    expect(r.mode).toBe('maintenance');
  });
});

describe('additive and compatible changes stay online', () => {
  it.each([
    'ALTER TABLE employment ADD COLUMN note text',
    "ALTER TABLE employment ADD COLUMN flag boolean NOT NULL DEFAULT false",
    'ALTER TABLE employment ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()',
    'ALTER TABLE employment ALTER COLUMN hired_on DROP NOT NULL',
    'ALTER TABLE employment DROP CONSTRAINT employment_code_ck',
    "ALTER TABLE employment ADD CONSTRAINT employment_code_ck CHECK (employee_code <> '') NOT VALID",
    'ALTER TABLE employment VALIDATE CONSTRAINT employment_code_ck',
    'ALTER TABLE employment ENABLE ROW LEVEL SECURITY',
    'CREATE POLICY p ON employment USING (true)',
    'DROP POLICY IF EXISTS p ON employment',
    'GRANT SELECT ON employment TO ai_hr_app',
  ])('%s', (sql) => {
    const r = classify([sql]);
    expect(r.findings).toEqual([]);
    expect(r.mode).toBe('online');
  });

  it('treats anything on a table created by the same pending set as new', () => {
    const r = classify([
      'CREATE TABLE IF NOT EXISTS public.rewards_ledger (id uuid PRIMARY KEY, amount numeric)',
      'ALTER TABLE rewards_ledger ALTER COLUMN amount SET NOT NULL;\nALTER TABLE rewards_ledger ADD CONSTRAINT r_ck CHECK (amount >= 0);\nALTER TABLE rewards_ledger DROP COLUMN amount;\nCREATE INDEX ON rewards_ledger(id);\nDROP TABLE rewards_ledger;',
    ]);
    expect(r.findings).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it('accepts drop-and-recreate and rename-and-wrap of a function in the same set', () => {
    const r = classify([`DROP FUNCTION app.f(uuid);
CREATE FUNCTION app.f(uuid, boolean) RETURNS int LANGUAGE sql AS $$ select 1 $$;
ALTER FUNCTION app.g(text) RENAME TO g_before_centre;
CREATE FUNCTION app.g(wanted text) RETURNS boolean LANGUAGE sql AS $$ select true $$;`]);
    expect(r.findings).toEqual([]);
  });

  it('ignores session-temporary tables', () => {
    expect(classify(['DROP TABLE pg_temp.attendance_header_policy_reference']).findings).toEqual([]);
  });

  it('reports a blocking index build on an existing table as a notice, not a blocker', () => {
    const r = classify(['CREATE INDEX employment_code_idx ON employment (employee_code)', 'CREATE INDEX CONCURRENTLY e2 ON employment (tenant_id)']);
    expect(r.mode).toBe('online');
    expect(r.notices.map((n) => n.rule)).toEqual(['index-blocks-writes']);
  });
});

describe('constraints that only bite on columns this release adds', () => {
  const added = 'ALTER TABLE overtime_settlement ADD COLUMN coverage_id uuid, ADD COLUMN coverage_kind text;';
  it.each([
    'ALTER TABLE overtime_settlement ADD CONSTRAINT c_fk FOREIGN KEY (coverage_id, tenant_id) REFERENCES coverage(id, tenant_id)',
    'ALTER TABLE overtime_settlement ADD CONSTRAINT c_uq UNIQUE (coverage_id, tenant_id)',
    "ALTER TABLE overtime_settlement ADD CONSTRAINT c_ck CHECK (coverage_kind IN ('a','b'))",
    "ALTER TABLE overtime_settlement ADD CONSTRAINT c_ck CHECK ((coverage_id IS NULL AND coverage_kind IS NULL) OR (coverage_id IS NOT NULL AND tenant_id IS NOT NULL))",
    'ALTER TABLE overtime_settlement ADD CONSTRAINT c_ex EXCLUDE USING gist (tenant_id WITH =, coverage_id WITH =)',
    'ALTER TABLE pay_component ADD CONSTRAINT pc_tenant_uq UNIQUE (id, tenant_id)',
  ])('%s', (sql) => {
    expect(classify([added, sql]).findings).toEqual([]);
  });

  it('still blocks when the constraint bites on existing columns', () => {
    expect(rules(classify([added, 'ALTER TABLE overtime_settlement ADD CONSTRAINT c_fk FOREIGN KEY (coverage_id, tenant_id) MATCH FULL REFERENCES coverage(id, tenant_id)']))).toEqual(['validating-constraint:overtime_settlement']);
    expect(rules(classify([added, 'ALTER TABLE overtime_settlement ADD CONSTRAINT c_uq UNIQUE NULLS NOT DISTINCT (coverage_id)']))).toEqual(['validating-constraint:overtime_settlement']);
    expect(rules(classify([added, "ALTER TABLE overtime_settlement ADD CONSTRAINT c_ck CHECK (coverage_id IS NULL OR tenant_id IS NOT NULL) "]))).toEqual([]);
    expect(rules(classify([added, "ALTER TABLE overtime_settlement ADD CONSTRAINT c_ck CHECK (tenant_id IS NULL OR coverage_id IS NOT NULL)"]))).toEqual(['validating-constraint:overtime_settlement']);
  });
});

describe('a re-added CHECK list is compared with the definition the running release has', () => {
  const history = [`CREATE TABLE teras_loop_level (id uuid PRIMARY KEY, level int, worker_id text,
    CONSTRAINT teras_loop_level_cap CHECK (level<=1 OR worker_id IN ('loop_a','loop_b')));
CREATE TABLE decision (id uuid, acting_mode text NOT NULL CHECK(acting_mode IN ('assigned','delegate')));`];

  it('a list that only grows is a widening notice', () => {
    const r = classify([`ALTER TABLE public.teras_loop_level DROP CONSTRAINT teras_loop_level_cap;
--> statement-breakpoint
ALTER TABLE public.teras_loop_level ADD CONSTRAINT teras_loop_level_cap CHECK (level<=1 OR worker_id IN
 ('loop_a','loop_b','loop_c'));
ALTER TABLE decision ADD CONSTRAINT decision_acting_mode_ck CHECK(acting_mode IN ('assigned','delegate','on_behalf'));`], history);
    expect(r.findings).toEqual([]);
    expect(r.notices.map((n) => `${n.rule}:${n.object}`)).toEqual(['widened-check:teras_loop_level', 'widened-check:decision']);
  });

  it('a list that loses a value, or a changed expression, blocks', () => {
    expect(rules(classify([`ALTER TABLE teras_loop_level ADD CONSTRAINT teras_loop_level_cap CHECK (level<=1 OR worker_id IN ('loop_a','loop_c'))`], history))).toEqual(['validating-constraint:teras_loop_level']);
    expect(rules(classify([`ALTER TABLE teras_loop_level ADD CONSTRAINT teras_loop_level_cap CHECK (level<=2 OR worker_id IN ('loop_a','loop_b','loop_c'))`], history))).toEqual(['validating-constraint:teras_loop_level']);
    expect(rules(classify([`ALTER TABLE teras_loop_level ADD CONSTRAINT teras_loop_level_cap CHECK (level<=1 OR worker_id IN ('loop_a','loop_b','loop_c'))`]))).toEqual(['validating-constraint:teras_loop_level']);
  });
});

describe('release acceptance file', () => {
  const blocked = () => classify(["ALTER TABLE employment ADD CONSTRAINT e_ck CHECK (employee_code <> '')"]);

  it('turns an exactly matching, reasoned acceptance into an annotated finding', () => {
    const r = mode.applyAcceptances(blocked(), [{ tag: '90_pending', statement: 1, rule: 'validating-constraint', reason: 'every writer already refuses empty codes (lib/employee-code.ts)' }]);
    expect(r.mode).toBe('online');
    expect(r.findings[0].annotation).toMatch(/^release: every writer/);
  });

  it('refuses a stale entry or a missing reason', () => {
    expect(() => mode.applyAcceptances(blocked(), [{ tag: '90_pending', statement: 2, rule: 'validating-constraint', reason: 'long enough reason' }])).toThrow(/matches no finding/);
    expect(() => mode.applyAcceptances(blocked(), [{ tag: '90_pending', statement: 1, rule: 'validating-constraint', reason: 'ok' }])).toThrow(/needs a reason/);
  });
});

describe('pending set from two installed journals', () => {
  const tree = (entries: Array<[string, number, string]>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-mode-'));
    fs.mkdirSync(path.join(dir, 'db', 'migrations', 'meta'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'db', 'migrations', 'meta', '_journal.json'), JSON.stringify({ entries: entries.map(([tag, when]) => ({ tag, when })) }));
    for (const [tag, , sql] of entries) fs.writeFileSync(path.join(dir, 'db', 'migrations', `${tag}.sql`), sql);
    return dir;
  };

  it('classifies only the entries after the running release, using its history for widenings', () => {
    const base = tree([['0001_a', 1, "CREATE TABLE t (id uuid, k text CHECK (k IN ('x')))"]]);
    const cand = tree([['0001_a', 1, "CREATE TABLE t (id uuid, k text CHECK (k IN ('x')))"], ['0002_b', 2, "ALTER TABLE t ADD CONSTRAINT t_k CHECK (k IN ('x','y'))"]]);
    const r = mode.classifyRelease(base, cand);
    expect(r.pending).toEqual(['0002_b']);
    expect(r.mode).toBe('online');
    expect(r.notices.map((n: Finding) => n.rule)).toEqual(['widened-check']);
  });

  it('refuses a candidate whose history diverges from the running release', () => {
    const base = tree([['0001_a', 1, 'select 1'], ['0002_b', 2, 'select 1']]);
    expect(() => mode.classifyRelease(base, tree([['0001_a', 1, 'select 1'], ['0002_c', 2, 'select 1']]))).toThrow(/diverges at entry 1/);
    expect(() => mode.classifyRelease(base, tree([['0001_a', 1, 'select 1']]))).toThrow(/shorter/);
  });
});

describe('every committed migration', () => {
  it('splits into statements and classifies without throwing', () => {
    const root = path.resolve(__dirname, '..');
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'db/migrations/meta/_journal.json'), 'utf8')).entries as Array<{ tag: string }>;
    expect(journal.length).toBeGreaterThan(800);
    const migrations = journal.map((e) => ({ tag: e.tag, sql: fs.readFileSync(path.join(root, 'db/migrations', `${e.tag}.sql`), 'utf8') }));
    let statements = 0;
    for (const m of migrations) statements += mode.splitStatements(m.sql).length;
    expect(statements).toBeGreaterThan(journal.length);
    // The whole history as one pending set: everything is created by the set itself, so only the
    // objects that predate the journal (none) could block.
    const all = mode.classifyMigrations(migrations);
    expect(all.newTables.length).toBeGreaterThan(300);
  });
});
