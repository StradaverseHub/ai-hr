/**
 * r417 (ADR-0094) — the no-DB / DB split of the full gate (scripts/gate-db-classify.ts) and the config
 * the no-DB half runs under (vitest.nodb.config.ts).
 *
 * THE PROOF IS NOT HERE, AND THAT IS DELIBERATE. The proof that every file called no-DB really needs no
 * database is EXECUTION: scripts/gate-chunked.sh runs part (a) with every database URL on a closed port
 * (127.0.0.1:1) on every full gate, and `GATE_NODB_PROOF=1 bash scripts/gate-chunked.sh` runs just that.
 * Spawning a 460-file vitest from inside a test would double the gate's load for no extra information.
 * What this file pins is the RULES, on an in-memory tree, and two facts about the real repo.
 *
 * Fixture sources are spelled with placeholders (IMP → the import keyword, REQ → require, and so on) so that THIS file
 * does not itself read as DB-touching to the classifier it tests.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyTestFile, classifyTestFiles, importSpecifiers, type Reader } from '../scripts/gate-db-classify';

const KW: Record<string, string> = {
  IMP: 'imp' + 'ort',
  MIGRATE: 'migrate' + 'TestDb',
  RESET: 'reset' + 'Db',
  WT: 'with' + 'Tenant',
  DBURL: 'DATABASE' + '_URL',
  PSQL: 'ps' + 'ql',
  REQ: 'req' + 'uire',
};
const spell = (s: string) => s.replace(/\b(IMP|MIGRATE|RESET|WT|DBURL|PSQL|REQ)\b/g, (m) => KW[m]);
function tree(files: Record<string, string>): Reader {
  const t = new Map(Object.entries(files).map(([k, v]) => [k, spell(v)]));
  return (p) => t.get(p) ?? null;
}
const isDb = (file: string, files: Record<string, string>) => classifyTestFile(file, tree(files)).db;

describe('DB-touching: imports', () => {
  it.each([
    ["IMP { seedBase } from './harness';", 'test/harness.ts'],
    ["IMP { db } from '../db/client';", 'db/client.ts'],
    ["IMP * as schema from '../db/schema';", 'db/schema.ts'],
    ["IMP { db } from '@/db/client';", 'db/client.ts'],
    ["IMP setup from './global-setup';", 'test/global-setup.ts'],
  ])('%s', (line, target) => {
    expect(isDb('test/a.test.ts', { 'test/a.test.ts': line, [target]: 'export {}' })).toBe(true);
  });

  it.each(['postgres', 'pg', 'drizzle-orm/postgres-js', 'drizzle-orm/postgres-js/migrator', 'drizzle-orm/pg-core'])(
    'the driver package %s',
    (pkg) => {
      expect(isDb('test/a.test.ts', { 'test/a.test.ts': `IMP x from '${pkg}';` })).toBe(true);
    },
  );

  it('a dynamic import of the harness, and a require', () => {
    expect(isDb('test/a.test.ts', { 'test/a.test.ts': "const h = await IMP('./harness');", 'test/harness.ts': '' })).toBe(true);
    expect(isDb('test/a.test.ts', { 'test/a.test.ts': "const { db } = REQ('../db/client');", 'db/client.ts': '' })).toBe(true);
  });

  it('THROUGH a test/ helper, transitively', () => {
    const files = {
      'test/a.test.ts': "IMP { mk } from './helpers/make';",
      'test/helpers/make.ts': "IMP { deeper } from './deeper';",
      'test/helpers/deeper.ts': "IMP { owner } from '../harness';",
      'test/harness.ts': '',
    };
    const v = classifyTestFile('test/a.test.ts', tree(files));
    expect(v.db).toBe(true);
    expect(v.reason).toContain('test/helpers/deeper.ts');
  });

  it('but NOT through product code — that gap is what the closed-port run closes', () => {
    // core/x imports db/client; a test calling a pure function of core/x opens no connection.
    const files = { 'test/a.test.ts': "IMP { pure } from '../core/x';", 'core/x.ts': "IMP { db } from '../db/client';" };
    expect(isDb('test/a.test.ts', files)).toBe(false);
  });
});

describe('DB-touching: calls and text', () => {
  it.each(['await MIGRATE();', 'beforeEach(() => RESET());', 'await WT(ctx, async (tx) => {});', 'process.env.DBURL', 'PSQL -p 5433', "inj" + "ect('workerDbPrefix')"])(
    '%s',
    (line) => {
      expect(isDb('test/a.test.ts', { 'test/a.test.ts': line })).toBe(true);
    },
  );
});

describe('doubt resolves to DB', () => {
  it('a relative import that does not resolve', () => {
    expect(isDb('test/a.test.ts', { 'test/a.test.ts': "IMP { x } from './nowhere';" })).toBe(true);
  });
  it('a dynamic import whose argument is not a literal', () => {
    expect(isDb('test/a.test.ts', { 'test/a.test.ts': 'const m = await IMP(`../app/${p}`);' })).toBe(true);
    expect(isDb('test/a.test.ts', { 'test/a.test.ts': 'const m = await IMP(modulePath);' })).toBe(true);
  });
  it('a file that cannot be read', () => {
    expect(isDb('test/missing.test.ts', {})).toBe(true);
  });
});

describe('no-DB', () => {
  it('a source-reading guard', () => {
    const files = {
      'test/a.test.ts': "IMP { readFileSync } from 'node:fs';\nIMP { it, expect } from 'vitest';\nIMP { fmt } from '../lib/format';",
      'lib/format.ts': 'export const fmt = 1;',
    };
    expect(isDb('test/a.test.ts', files)).toBe(false);
  });
  it('a DOM test', () => {
    const files = {
      'test/a.dom.test.tsx': "IMP { render } from '@testing-library/react';\nIMP Thing from '@/components/thing';",
      'components/thing.tsx': 'export default function Thing() { return null; }',
    };
    expect(isDb('test/a.dom.test.tsx', files)).toBe(false);
  });
  it('import specifiers are read from multi-line and type-only imports', () => {
    const { specs } = importSpecifiers(spell("IMP {\n  a,\n  b,\n} from './x';\nIMP type { T } from '../y';\nexport * from './z';"));
    expect(specs).toEqual(['./x', '../y', './z']);
  });
});

describe('the real repo', () => {
  const read: Reader = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };

  it('a file that imports the harness directly is DB — sampled from files that say so in their text', () => {
    const sample = ['test/claims-lifecycle.test.ts', 'test/claims-rls.test.ts'];
    for (const f of sample) {
      const src = read(f);
      expect(src, f).not.toBeNull();
      expect(src!).toMatch(/from '\.\/harness'/);
      expect(classifyTestFile(f, read).db, f).toBe(true);
    }
  });

  it('this file and the tier classifier test are no-DB (they must stay fast for the affected tier)', () => {
    const { nodb } = classifyTestFiles(['test/r417-gate-db-classify.test.ts', 'test/r417-gate-tier.test.ts'], read);
    expect(nodb).toEqual(['test/r417-gate-db-classify.test.ts', 'test/r417-gate-tier.test.ts']);
  });
});

describe('vitest.nodb.config.ts differs from vitest.config.ts in exactly two ways', () => {
  it('no globalSetup, and maxWorkers from VITEST_MAX_WORKERS_NODB (default 6)', async () => {
    const prev = process.env.VITEST_MAX_WORKERS_NODB;
    delete process.env.VITEST_MAX_WORKERS_NODB;
    try {
      const nodb = (await import('../vitest.nodb.config')).default as { test: { projects: { test: Record<string, unknown> }[] } };
      const base = (await import('../vitest.config')).default as { test: { projects: { test: Record<string, unknown> }[] } };
      expect(nodb.test.projects.map((p) => p.test.name)).toEqual(base.test.projects.map((p) => p.test.name));
      for (const [i, p] of nodb.test.projects.entries()) {
        expect(p.test.globalSetup).toEqual([]);
        expect(p.test.maxWorkers).toBe(6);
        const { globalSetup: _g, maxWorkers: _m, ...rest } = p.test;
        const { globalSetup: _bg, maxWorkers: _bm, ...baseRest } = base.test.projects[i].test;
        expect(rest).toEqual(baseRest);
      }
      expect(base.test.projects.some((p) => Array.isArray(p.test.globalSetup) && (p.test.globalSetup as unknown[]).length > 0)).toBe(true);
    } finally {
      if (prev !== undefined) process.env.VITEST_MAX_WORKERS_NODB = prev;
    }
  });
});
