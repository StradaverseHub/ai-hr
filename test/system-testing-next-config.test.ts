/** Actual filesystem/configuration boundary; not a Next artifact or service-arrival proof. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants';
import {
  emptySystemTestingCompileEnvironment, ensurePrivateReleaseDirectory, prepareSystemTestingBuild, publishSystemTestingBuild,
  systemTestingBuildContextEnvironment, systemTestingBuildDirectory, systemTestingCompileEnvironment,
} from '../scripts/improve/system-testing-manifest';
import { systemTestingNextCompileEnvironment } from '../scripts/improve/system-testing-next-config';

const storage = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => storage.home }));
const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url))), roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); storage.home = ''; });
function fixture(context: 'official' | 'dev_only') {
  const scratch = join(repo, 'scratchpad'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'testing-config-')); roots.push(root); storage.home = root;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'lib/system-testing'), { recursive: true }); mkdirSync(join(root, 'app/(app)'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.aihr-*/\n');
  writeFileSync(join(root, 'app/(app)/page.tsx'), 'export default function Page(){ return "fictional config fixture"; }\n');
  const entry = structuredClone(JSON.parse(readFileSync(join(repo, 'lib/system-testing/catalogue.json'), 'utf8')).entries[0]);
  entry.sources = ['app/(app)/page.tsx']; entry.reviewedSourceHash = 'b'.repeat(64);
  writeFileSync(join(root, 'lib/system-testing/catalogue.json'), JSON.stringify({ format: 1, revision: 'fictional.config', entries: [entry] }));
  git('init', '-q'); git('config', 'user.email', 'fictional@example.invalid'); git('config', 'user.name', 'Fictional Config');
  git('add', '-A'); git('commit', '-qm', 'fictional config source');
  const record = prepareSystemTestingBuild({ worktree: root, candidate: git('rev-parse', 'HEAD'), buildRecordId: randomUUID() });
  const directory = systemTestingBuildDirectory(context === 'official' ? 'remote' : 'local');
  ensurePrivateReleaseDirectory(directory);
  const file = publishSystemTestingBuild(record, directory);
  return { root, record, file, directory, environment: systemTestingBuildContextEnvironment(record, context) };
}

describe('Next configuration provenance boundary', () => {
  it('ignores self-consistent inherited five values without a selector, even when the owner bytes have changed', () => {
    const f = fixture('official');
    writeFileSync(join(f.root, 'app/(app)/page.tsx'), 'changed source after preparation');
    for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER]) {
      expect(systemTestingNextCompileEnvironment({ phase, worktree: f.root, environment: systemTestingCompileEnvironment(f.record) })).toEqual(emptySystemTestingCompileEnvironment());
    }
  });

  it('derives official values from the exact private record, ignoring poisoned inherited hashes and JSON', () => {
    const f = fixture('official');
    const environment = { ...f.environment, AIHR_SYSTEM_TESTING_CATALOGUE_HASH: 'poisoned', AIHR_SYSTEM_TESTING_CONTENT_HASH: 'poisoned', AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD: 'malformed' };
    const actual = systemTestingNextCompileEnvironment({ phase: PHASE_PRODUCTION_BUILD, worktree: f.root, environment });
    expect(actual).toEqual(systemTestingCompileEnvironment(f.record));
    expect(Object.keys(actual)).toHaveLength(5);
    expect(f.record.activeServiceVerified).toBe(false);
    // Repeated config reads and deliberate retry of an unused preparation are allowed, not a successful-build claim.
    expect(systemTestingNextCompileEnvironment({ phase: PHASE_PRODUCTION_BUILD, worktree: f.root, environment })).toEqual(actual);
    expect(existsSync(join(dirname(f.file), 'successful-build.json'))).toBe(false);
  });

  it('hard-refuses explicit selection with wrong source/UUID, private storage, used record or changed owner bytes', () => {
    for (const mode of ['ref', 'uuid', 'missing', 'private', 'used', 'source']) {
      const f = fixture('official'), environment = { ...f.environment };
      if (mode === 'ref') environment.AIHR_SYSTEM_TESTING_SOURCE_REF = 'a'.repeat(40);
      if (mode === 'uuid') environment.AIHR_SYSTEM_TESTING_BUILD_RECORD_ID = randomUUID();
      if (mode === 'missing') delete environment.AIHR_SYSTEM_TESTING_SOURCE_REF;
      if (mode === 'private') chmodSync(f.directory, 0o755);
      if (mode === 'used') writeFileSync(join(dirname(f.file), 'successful-build.json'), '{}\n');
      if (mode === 'source') writeFileSync(join(f.root, 'app/(app)/page.tsx'), 'changed source after preparation');
      expect(() => systemTestingNextCompileEnvironment({ phase: PHASE_PRODUCTION_BUILD, worktree: f.root, environment }), mode).toThrow();
    }
  });

  it('keeps dev-only preparation phase-specific and never publishes a successful production observation', () => {
    const f = fixture('dev_only');
    expect(f.environment.AIHR_SYSTEM_TESTING_BUILD_CONTEXT).toBe('dev_only');
    expect(systemTestingNextCompileEnvironment({ phase: PHASE_DEVELOPMENT_SERVER, worktree: f.root, environment: f.environment })).toEqual(systemTestingCompileEnvironment(f.record));
    expect(() => systemTestingNextCompileEnvironment({ phase: PHASE_PRODUCTION_BUILD, worktree: f.root, environment: f.environment })).toThrow(/phase/);
    expect(() => systemTestingNextCompileEnvironment({ phase: PHASE_DEVELOPMENT_SERVER, worktree: f.root, environment: { ...f.environment, AIHR_SYSTEM_TESTING_BUILD_CONTEXT: 'official' } })).toThrow(/phase/);
    expect(() => systemTestingNextCompileEnvironment({ phase: PHASE_PRODUCTION_BUILD, worktree: f.root, environment: { ...f.environment, AIHR_SYSTEM_TESTING_BUILD_CONTEXT: 'unknown' } })).toThrow(/phase/);
    expect(existsSync(join(dirname(f.file), 'successful-build.json'))).toBe(false);
  });

  it('does no source/private-record read at production startup, despite stale selectors and nonexistent storage', () => {
    storage.home = '/nonexistent-fictional-testing-home';
    expect(systemTestingNextCompileEnvironment({ phase: PHASE_PRODUCTION_SERVER, worktree: '/nonexistent-fictional-source', environment: { AIHR_SYSTEM_TESTING_BUILD_CONTEXT: 'official', AIHR_SYSTEM_TESTING_SOURCE_REF: 'bad', AIHR_SYSTEM_TESTING_BUILD_RECORD_ID: 'bad' } })).toEqual(emptySystemTestingCompileEnvironment());
  });
});
