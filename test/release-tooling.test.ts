import { describe, expect, it } from 'vitest';
import { classifyClosureFile, closureDelta, compareGenerators, migrationProblems } from '../scripts/release/preflight.mjs';
import { renumberPlan } from '../scripts/release/migrations-renumber.mjs';
import { CHUNK, RELEASE_PROVEN_GUARDS, chunk, selection } from '../scripts/release/select-focused';
import { AI_MANIFEST_INPUTS } from '../.github/ci/ai-manifest-admission.mjs';

const entry = (tag: string, idx: number, when: number) => ({ idx, version: '7', when, tag, breakpoints: true });
const base = [entry('0952_a', 798, 1793330000352), entry('0953_b', 799, 1793330000353)];

describe('preflight generator comparison (ADR-0176 decision 2)', () => {
  it('checks exactly the inputs CI admission byte-compares', () => {
    const same = compareGenerators('h', 'b', () => Buffer.from('x'));
    expect(same.map((g) => g.path)).toEqual([...AI_MANIFEST_INPUTS]);
    expect(same.every((g) => g.identical)).toBe(true);
  });
  it('reports a differing or missing generator, as admission refused at 4ba3b25a8', () => {
    const read = (rev: string, path: string) => (path.includes('provider') && rev === 'h' ? Buffer.from('changed') : rev === 'b' && path.includes('scope') ? null : Buffer.from('x'));
    const result = compareGenerators('h', 'b', read);
    expect(result.filter((g) => !g.identical).map((g) => g.path)).toEqual(['scripts/ai-agent-source-scope.mjs', 'scripts/ai-provider-data-source-manifest.mjs']);
  });
});

describe('preflight approval delta', () => {
  it('lists added, changed and removed closure files with a kind', () => {
    const delta = closureDelta(
      { sources: [{ path: 'messages/en.json', sha256: '1' }, { path: 'core/payroll.ts', sha256: '2' }, { path: 'lib/ai/old.ts', sha256: '3' }] },
      { sources: [{ path: 'messages/en.json', sha256: '9' }, { path: 'core/payroll.ts', sha256: '2' }, { path: 'lib/ai/providers/openrouter-transport.ts', sha256: '4' }] },
    );
    expect(delta).toEqual([
      { path: 'lib/ai/old.ts', change: 'removed', kind: 'AI code' },
      { path: 'lib/ai/providers/openrouter-transport.ts', change: 'added', kind: 'provider transport/egress' },
      { path: 'messages/en.json', change: 'changed', kind: 'locale catalogue' },
    ]);
    expect(classifyClosureFile('pnpm-lock.yaml')).toBe('dependencies');
    expect(classifyClosureFile('packs/my/service.ts')).toBe('country pack service');
  });
});

describe('preflight migration watermark', () => {
  it('accepts new entries strictly above base and the staging watermark', () => {
    const r = migrationProblems(base, [...base, entry('2000_c', 800, 1793330001400)], { stagingWatermark: 1793330000353 });
    expect(r).toMatchObject({ added: ['2000_c'], problems: [] });
  });
  it('flags the silent-skip case: a when below the recorded watermark', () => {
    const r = migrationProblems(base, [...base, entry('0954_c', 800, 1793330000354)], { stagingWatermark: 1793330001411 });
    expect(r.problems).toEqual([expect.stringContaining('the migrator would skip it')]);
  });
  it('flags a non-prefix base, a duplicate tag, a stale idx and missing SQL', () => {
    const r = migrationProblems(base, [base[0], entry('0953_b', 799, 1793330000999), entry('0952_a', 799, 1793330001000)], { sqlExists: () => false });
    expect(r.problems).toEqual([
      expect.stringContaining('not an exact prefix'),
      expect.stringContaining('Duplicate migration tag 0952_a'),
      expect.stringContaining('idx 799 is not above 799'),
      expect.stringContaining('SQL file missing'),
    ]);
  });
});

describe('migration renumbering at landing (ADR-0176 decision 6)', () => {
  it('moves only entries after the exact base prefix, strictly above base and watermark', () => {
    const head = [...base, entry('2000_x', 800, 1793330001400), entry('2001_y', 801, 1793330001401)];
    const plan = renumberPlan(base, head, { stagingWatermark: 1793330000400 });
    expect(plan.map((p) => p.to)).toEqual([
      { tag: '0954_x', idx: 800, when: 1793330000401 },
      { tag: '0955_y', idx: 801, when: 1793330000402 },
    ]);
    expect(plan.map((p) => p.entry.version)).toEqual(['7', '7']);
  });
  it('refuses when the applied prefix differs (merge the base first)', () => {
    expect(() => renumberPlan(base, [base[0], entry('0953_b', 799, 1)])).toThrow(/exact prefix/);
  });
  it('honours an explicit block start and skips numbers the base uses', () => {
    const plan = renumberPlan([...base, entry('2100_z', 800, 1793330001500)], [...base, entry('2100_z', 800, 1793330001500), entry('0960_q', 801, 1)], { startFile: 2100 });
    expect(plan[0].to).toEqual({ tag: '2101_q', idx: 801, when: 1793330001501 });
  });
});

describe('focused selection (ADR-0176 decision 1)', () => {
  it('chunks canonically within the focused workflow bound', () => {
    const files = Array.from({ length: 130 }, (_, i) => `test/f${String(i).padStart(3, '0')}.test.ts`).reverse();
    const chunks = chunk(files);
    expect(CHUNK).toBe(64);
    expect(chunks.map((c) => c.length)).toEqual([64, 64, 2]);
    expect(chunks.flat()).toEqual([...files].sort());
  });
  it('adds the release-proven guards that exist, without duplicates', () => {
    const result = selection(['test/ai-centre.test.ts', 'test/x.test.ts'], (p) => p !== 'test/setup-copilot-destinations.test.ts');
    expect(result.files).toContain('test/company-referrers.test.ts');
    expect(result.files.filter((f) => f === 'test/ai-centre.test.ts')).toHaveLength(1);
    expect(result.missing).toEqual(['test/setup-copilot-destinations.test.ts']);
    expect(result.extra).toHaveLength(RELEASE_PROVEN_GUARDS.length - 2);
  });
});
