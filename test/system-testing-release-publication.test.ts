/** Filesystem/build-child harness only; no Next artifact, service-arrival or manual-pass claim. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensurePrivateReleaseDirectory, parsePreparedTestingBuild, prepareSystemTestingBuild, publishSystemTestingBuild,
  readPublishedTestingBuild, systemTestingCompileEnvironment, verifyInstalledTestingBuild,
  type PreparedTestingBuild,
} from '../scripts/improve/system-testing-manifest';
import { readTestingBuildInput, runTestingProductionBuild, systemTestingBuildCommand } from '../scripts/improve/system-testing-build-cli';
import { sourceContentDigest, stableTestingJson } from '../lib/system-testing/hash';
import { buildTestingRecordCommand } from '../scripts/improve/release';

const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url))), roots: string[] = [];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = join(repo, 'scratchpad'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'testing-release-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'lib/system-testing'), { recursive: true }); mkdirSync(join(root, 'app/(app)'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.next/\nevidence/\n.gate-receipt.json\n');
  writeFileSync(join(root, 'app/(app)/page.tsx'), 'export default function Page(){ return "fictional release fixture"; }\n');
  const entry = structuredClone(JSON.parse(readFileSync(join(repo, 'lib/system-testing/catalogue.json'), 'utf8')).entries[0]);
  entry.sources = ['app/(app)/page.tsx']; entry.reviewedSourceHash = 'b'.repeat(64);
  const catalogue = { format: 1, revision: 'fictional.release', entries: [entry] };
  writeFileSync(join(root, 'lib/system-testing/catalogue.json'), JSON.stringify(catalogue));
  git('init', '-q'); git('config', 'user.email', 'fictional@example.invalid'); git('config', 'user.name', 'Fictional Release');
  git('add', '-A'); git('commit', '-qm', 'fictional build source');
  const candidate = git('rev-parse', 'HEAD'), buildRecordId = randomUUID();
  const record = prepareSystemTestingBuild({ worktree: root, candidate, buildRecordId });
  const directory = join(root, 'evidence'); ensurePrivateReleaseDirectory(directory);
  return { root, git, candidate, buildRecordId, record, directory, catalogue };
}
function publish(f: ReturnType<typeof fixture>) {
  const path = publishSystemTestingBuild(f.record, f.directory);
  return { path, buildDirectory: dirname(path), bytes: readFileSync(path) };
}
function buildId(root: string, id: string = randomUUID()) { mkdirSync(join(root, '.next'), { recursive: true }); writeFileSync(join(root, '.next/BUILD_ID'), id + '\n'); }

describe('selected System Testing release provenance', () => {
  it('prepares exact clean committed source and does not restamp unreviewed guide fingerprints', () => {
    const f = fixture();
    expect(f.record.identity.sourceRef).toBe(f.candidate);
    expect(f.record.sourceHashRecord).toEqual([{ path: 'app/(app)/page.tsx', sha256: hash(readFileSync(join(f.root, 'app/(app)/page.tsx'))) }]);
    expect(verifyInstalledTestingBuild(f.record, f.root)).toEqual(f.record);
    expect(JSON.parse(readFileSync(join(f.root, 'lib/system-testing/catalogue.json'), 'utf8')).entries[0].reviewedSourceHash).toBe('b'.repeat(64));
    expect(f.record.activeServiceVerified).toBe(false);
    expect(() => prepareSystemTestingBuild({ worktree: f.root, candidate: 'a'.repeat(40), buildRecordId: randomUUID() })).toThrow();
    writeFileSync(join(f.root, 'app/(app)/page.tsx'), 'uncommitted changed source');
    expect(() => prepareSystemTestingBuild({ worktree: f.root, candidate: f.candidate, buildRecordId: randomUUID() })).toThrow(/clean/);
  });

  it('refuses installed source/catalogue/path changes and symlink source despite a self-consistent transferred record', () => {
    for (const mode of ['source', 'catalogue', 'extra', 'missing', 'symlink']) {
      const f = fixture(), record = structuredClone(f.record);
      if (mode === 'source') writeFileSync(join(f.root, 'app/(app)/page.tsx'), 'changed after rsync');
      if (mode === 'catalogue') writeFileSync(join(f.root, 'lib/system-testing/catalogue.json'), JSON.stringify({ ...f.catalogue, revision: 'changed' }));
      if (mode === 'extra') record.sourceHashRecord.push({ path: 'core/extra.ts', sha256: 'a'.repeat(64) });
      if (mode === 'missing') record.sourceHashRecord = [];
      if (mode === 'extra' || mode === 'missing') record.identity.contentHash = sourceContentDigest(record.sourceHashRecord);
      if (mode === 'symlink') {
        rmSync(join(f.root, 'app/(app)/page.tsx')); writeFileSync(join(f.root, 'outside.tsx'), 'fictional external file'); symlinkSync(join(f.root, 'outside.tsx'), join(f.root, 'app/(app)/page.tsx'));
      }
      expect(() => verifyInstalledTestingBuild(record, f.root), mode).toThrow();
    }
  });

  it('receives only bounded canonical JSON with the exact expected source and build UUID', async () => {
    const f = fixture(), expected = { sourceRef: f.candidate, buildRecordId: f.buildRecordId }, bytes = Buffer.from(stableTestingJson(f.record) + '\n');
    expect(parsePreparedTestingBuild(bytes, expected)).toEqual(f.record);
    expect(() => parsePreparedTestingBuild(bytes, { ...expected, buildRecordId: randomUUID() })).toThrow();
    for (const bad of [Buffer.from('{'), Buffer.from(JSON.stringify(f.record)), Buffer.from(stableTestingJson({ ...f.record, activeServiceVerified: true }) + '\n'), Buffer.from(stableTestingJson({ ...f.record, unknown: 'field' }) + '\n')]) expect(() => parsePreparedTestingBuild(bad, expected)).toThrow();
    async function* chunks() { yield Buffer.alloc(50000); yield Buffer.alloc(50000); }
    await expect(readTestingBuildInput(chunks())).rejects.toThrow(/bound/);
    await expect(systemTestingBuildCommand(['receive', f.candidate, f.buildRecordId, '/arbitrary/path'])).rejects.toThrow();
    const oversized: PreparedTestingBuild = structuredClone(f.record);
    oversized.sourceHashRecord = Array.from({ length: 400 }, (_, i) => ({ path: `core/${'a'.repeat(190)}${i}.ts`, sha256: 'a'.repeat(64) }));
    oversized.identity.contentHash = sourceContentDigest(oversized.sourceHashRecord);
    expect(() => systemTestingCompileEnvironment(oversized)).toThrow(/oversized/);
  });

  it('publishes once in private owned storage and refuses permissive/symlink ancestry or altered immutable identity', () => {
    const f = fixture(), saved = publish(f);
    expect(readPublishedTestingBuild(f.directory, { sourceRef: f.candidate, buildRecordId: f.buildRecordId }).bytes).toEqual(saved.bytes);
    expect(() => publishSystemTestingBuild(f.record, f.directory)).toThrow();
    const permissive = join(f.root, 'writable'); mkdirSync(permissive, { mode: 0o777 }); chmodSync(permissive, 0o777);
    expect(() => ensurePrivateReleaseDirectory(join(permissive, 'private'))).toThrow(/ancestry/);
    const link = join(f.root, 'linked'); symlinkSync(f.directory, link);
    expect(() => publishSystemTestingBuild({ ...f.record, identity: { ...f.record.identity, buildRecordId: randomUUID() } }, link)).toThrow();
    writeFileSync(saved.path, stableTestingJson({ ...f.record, identity: { ...f.record.identity, sourceRef: 'c'.repeat(40) } }) + '\n');
    expect(() => readPublishedTestingBuild(f.directory, { sourceRef: f.candidate, buildRecordId: f.buildRecordId })).toThrow();
  });

  it('puts only validated identifiers in the SSH command, keeping record bytes on stdin', () => {
    const f = fixture(), command = buildTestingRecordCommand(f.candidate, f.buildRecordId, '/opt/fictional app');
    expect(command).toContain("cd '/opt/fictional app'"); expect(command).toContain(`receive ${f.candidate} ${f.buildRecordId}`);
    expect(command).not.toContain('sourceHashRecord'); expect(command).not.toContain('DATABASE_URL');
    for (const [ref, id] of [['$(echo bad)', f.buildRecordId], [f.candidate, '../other']]) expect(() => buildTestingRecordCommand(ref, id)).toThrow();
  });
});

describe('actual build exit and separate non-arrival observation', () => {
  it('overrides all stale runtime metadata and publishes only after a successful child wrote a fresh actual build ID', () => {
    const f = fixture(), saved = publish(f);
    for (const key of Object.keys(systemTestingCompileEnvironment(f.record))) vi.stubEnv(key, 'stale-private-runtime-value');
    const observation = runTestingProductionBuild({ ...f, worktree: f.root, sourceRef: f.candidate, build: environment => {
      expect(Object.fromEntries(Object.keys(systemTestingCompileEnvironment(f.record)).map(key => [key, environment[key]]))).toEqual(systemTestingCompileEnvironment(f.record));
      expect(environment.AIHR_SYSTEM_TESTING_BUILD_CONTEXT).toBe('official');
      expect(existsSync(join(saved.buildDirectory, 'successful-build.json'))).toBe(false);
      buildId(f.root, 'actual-fictional-build'); return { status: 0, signal: null };
    } });
    const receipt = JSON.parse(readFileSync(observation, 'utf8'));
    expect(receipt).toMatchObject({ kind: 'successful-system-testing-build', identity: f.record.identity, preparedRecordSha256: hash(saved.bytes), nextBuildId: 'actual-fictional-build', activeServiceVerified: false, manualExecutionVerified: false });
    expect(() => runTestingProductionBuild({ ...f, worktree: f.root, sourceRef: f.candidate, build: () => { throw new Error('must not launch twice'); } })).toThrow(/already/);
  });

  it('leaves no successful observation for child failure/signal, missing/stale build ID or source drift during build', () => {
    for (const mode of ['exit', 'signal', 'missing', 'stale', 'source']) {
      const f = fixture(), saved = publish(f);
      if (mode === 'stale') buildId(f.root, 'previous-build');
      expect(() => runTestingProductionBuild({ ...f, worktree: f.root, sourceRef: f.candidate, build: () => {
        if (mode === 'exit' || mode === 'signal' || mode === 'source') buildId(f.root, 'partial-new-build');
        if (mode === 'source') writeFileSync(join(f.root, 'app/(app)/page.tsx'), 'changed while compiling');
        return { status: mode === 'exit' ? 9 : mode === 'signal' ? null : 0, signal: mode === 'signal' ? 'SIGTERM' : null };
      } }), mode).toThrow();
      expect(existsSync(join(saved.buildDirectory, 'successful-build.json')), mode).toBe(false);
    }
  });
});
