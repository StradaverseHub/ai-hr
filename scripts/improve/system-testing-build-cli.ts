/** Trusted release/build entry only. Records arrive over bounded stdin, never a web path or URL. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testingSourceRef, testingUuid } from '../../lib/system-testing/model';
import {
  SYSTEM_TESTING_BUILD_RECORD_BYTES, assertTestingBuildNotObserved, ensurePrivateReleaseDirectory,
  parsePreparedTestingBuild, publishSuccessfulTestingBuild, publishSystemTestingBuild, readPublishedTestingBuild,
  systemTestingBuildDirectory, systemTestingBuildContextEnvironment, testingNextBuildId, verifyInstalledTestingBuild,
} from './system-testing-manifest';

export async function readTestingBuildInput(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > SYSTEM_TESTING_BUILD_RECORD_BYTES) throw new Error('System Testing build stdin exceeds its bound.');
    chunks.push(bytes);
  }
  if (!size) throw new Error('System Testing build stdin is empty.');
  return Buffer.concat(chunks);
}

function buildFingerprint(worktree: string): string | null {
  try {
    const id = testingNextBuildId(worktree), st = lstatSync(join(worktree, '.next/BUILD_ID'), { bigint: true });
    return `${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${createHash('sha256').update(id).digest('hex')}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export class TestingProductionBuildError extends Error {
  constructor(readonly exitCode: number, message: string) { super(message); this.name = 'TestingProductionBuildError'; }
}

/** The injected child seam is only for local harnesses; the CLI always executes canonical pnpm build. */
export function runTestingProductionBuild(p: {
  worktree: string; directory: string; sourceRef: string; buildRecordId: string;
  build?: (environment: NodeJS.ProcessEnv) => { status: number | null; signal: string | null; error?: Error };
}): string {
  const selected = readPublishedTestingBuild(p.directory, p);
  verifyInstalledTestingBuild(selected.record, p.worktree);
  assertTestingBuildNotObserved(selected.buildDirectory);
  const previous = buildFingerprint(p.worktree), startedAt = new Date().toISOString();
  const environment = { ...process.env, ...systemTestingBuildContextEnvironment(selected.record, 'official') };
  const result = p.build ? p.build(environment) : spawnSync('pnpm', ['build'], { cwd: p.worktree, env: environment, stdio: 'inherit' });
  if (result.error || result.status !== 0 || result.signal) throw new TestingProductionBuildError(result.status && result.status > 0 ? result.status : 1, 'Production build failed; no System Testing successful-build observation was published.');
  if (buildFingerprint(p.worktree) === previous) throw new Error('Production build did not write a fresh Next build ID; no successful-build observation.');
  const current = readPublishedTestingBuild(p.directory, p);
  if (!current.bytes.equals(selected.bytes)) throw new Error('Published System Testing preparation changed during the build.');
  return publishSuccessfulTestingBuild({ buildDirectory: selected.buildDirectory, prepared: selected.record, preparedBytes: selected.bytes, worktree: p.worktree, startedAt });
}

export async function systemTestingBuildCommand(args: string[]): Promise<string> {
  const [command, sourceRef, buildRecordId, ...extra] = args;
  if (extra.length || !['receive', 'build'].includes(command)) throw new Error('Expected receive|build <source-ref> <build-record-uuid>.');
  testingSourceRef.parse(sourceRef); testingUuid.parse(buildRecordId);
  const worktree = process.cwd(), directory = systemTestingBuildDirectory('remote');
  if (command === 'receive') {
    const record = parsePreparedTestingBuild(await readTestingBuildInput(process.stdin), { sourceRef, buildRecordId });
    verifyInstalledTestingBuild(record, worktree);
    ensurePrivateReleaseDirectory(directory);
    return publishSystemTestingBuild(record, directory);
  }
  return runTestingProductionBuild({ worktree, directory, sourceRef, buildRecordId });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  systemTestingBuildCommand(process.argv.slice(2)).then(file => console.log(`System Testing build evidence: ${file}`)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof TestingProductionBuildError ? error.exitCode : 1;
  });
}
