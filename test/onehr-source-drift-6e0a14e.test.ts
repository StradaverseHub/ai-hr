import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import drift from './fixtures/onehr/source-drift-6e0a14e.json';
import golden from './fixtures/onehr/source-golden.json';

// ADR-0141 M02: the golden fixtures were derived from OneHR a644fd6. This record re-derives them against 6e0a14e
// (isolated AST execution, app never imported). The guards keep the two files from drifting apart silently.
const fixtures = join(__dirname, 'fixtures', 'onehr');
const sha256 = (file: string) => createHash('sha256').update(readFileSync(join(fixtures, file))).digest('hex');

describe('OneHR 6e0a14e source drift record', () => {
  it('is bound to the exact golden input it re-executed', () => {
    expect(golden.source.commit).toBe('a644fd6');
    expect(drift.sources.a644fd6.appPySha256).toBe(golden.source.sha256);
    expect(drift.sources.goldenInput.sha256).toBe(sha256('source-golden.json'));
  });

  it('re-executed every scoring and talent case with no mismatch under 6e0a14e', () => {
    expect(drift.rerun.scoring.cases).toBe(golden.scoring.length);
    expect(drift.rerun.scoring.cases).toBeGreaterThanOrEqual(156);
    expect(drift.rerun.scoring.mismatches).toEqual([]);
    expect(drift.rerun.talent.cases).toBe(golden.talent.length);
    expect(drift.rerun.talent.cases).toBe(15);
    expect(drift.rerun.talent.mismatches).toEqual([]);
  });

  it('characterizes every changed function and leaves none unexplained', () => {
    const changed = drift.functionDrift.filter((d) => d.status !== 'unchanged').map((d) => d.name).sort();
    expect(changed.length).toBeGreaterThan(0);
    expect(Object.keys(drift.characterization).sort()).toEqual(changed);
    const unchanged = drift.functionDrift.filter((d) => d.status === 'unchanged').map((d) => d.name).sort();
    expect([...drift.unchangedVerified].sort()).toEqual(unchanged);
  });

  it('records that the native rating-record export still follows the a644fd6 header', () => {
    expect(golden.ratingExportHeaders).toHaveLength(43);
    expect(drift.ratingExportHeader).toEqual({ columns6e0a14e: 44, sameAsGolden: false });
  });

  it('names only fixture files that exist', () => {
    for (const d of drift.functionDrift) expect(() => readFileSync(join(fixtures, d.fixture)), d.fixture).not.toThrow();
  });
});
