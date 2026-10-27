/** Official-release helper only. No web import, tenant data, arbitrary ref checkout or live-arrival claim. */
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, linkSync, unlinkSync, fstatSync, readSync, realpathSync, constants } from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createCommittedSourceReader } from './committed-source-blobs';
import { buildIdentitySchema, catalogueSchema, sourceHashRecordSchema, testingSourceRef, testingUuid, type TestingBuildIdentity, type TestingSourceHashRecord } from '../../lib/system-testing/model';
import { catalogueDigest, sourceContentDigest, stableTestingJson, testingSourcePaths } from '../../lib/system-testing/hash';
export const SYSTEM_TESTING_CATALOGUE_PATH = 'lib/system-testing/catalogue.json';
// An OS launch bound, deliberately smaller than the web parser's JSON bound. No truncation.
export const SYSTEM_TESTING_COMPILE_RECORD_BYTES = 64 * 1024;
export const SYSTEM_TESTING_BUILD_RECORD_BYTES = 80 * 1024;
const preparedBuildSchema = z.strictObject({ format: z.literal(1), identity: buildIdentitySchema, sourceHashRecord: sourceHashRecordSchema, activeServiceVerified: z.literal(false) });
export type PreparedTestingBuild = { format: 1; identity: TestingBuildIdentity; sourceHashRecord: TestingSourceHashRecord; activeServiceVerified: false };
function git(root: string, args: string[], maxBuffer = 16 * 1024 * 1024): Buffer {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}
/** Reads committed blobs, then rechecks clean HEAD. Caller supplies the exact already-selected candidate. */
export function prepareSystemTestingBuild(p: { worktree: string; candidate: string; buildRecordId: string }): PreparedTestingBuild {
  testingSourceRef.parse(p.candidate); testingUuid.parse(p.buildRecordId);
  const root = resolve(p.worktree);
  function assertFrozen() {
    if (git(root, ['rev-parse', '--show-toplevel']).toString().trim() !== root || git(root, ['rev-parse', 'HEAD']).toString().trim() !== p.candidate || git(root, ['status', '--porcelain', '--untracked-files=all']).length) throw new Error('System Testing build evidence requires the exact clean selected worktree.');
  }
  assertFrozen();
  const committed = createCommittedSourceReader(root, p.candidate);
  const catalogueBlob = committed.read([SYSTEM_TESTING_CATALOGUE_PATH], 8 * 1024 * 1024).get(SYSTEM_TESTING_CATALOGUE_PATH)!;
  if (catalogueBlob.length > 8 * 1024 * 1024) throw new Error('Reviewed catalogue exceeds the supported bound.');
  const catalogue = catalogueSchema.parse(JSON.parse(catalogueBlob.toString('utf8')));
  const paths = testingSourcePaths(catalogue), hashes = committed.hashes(paths);
  const sourceHashRecord = paths.map(path => ({ path, sha256: hashes.get(path)! }));
  assertFrozen();
  const record: PreparedTestingBuild = { format: 1, identity: { sourceRef: p.candidate, buildRecordId: p.buildRecordId, catalogueHash: catalogueDigest(catalogue), contentHash: sourceContentDigest(sourceHashRecord) }, sourceHashRecord, activeServiceVerified: false };
  verifyInstalledTestingBuild(record, root);
  assertFrozen();
  return record;
}
export function systemTestingCompileEnvironment(record: PreparedTestingBuild): Record<string, string> {
  record = validatePreparedTestingBuild(record);
  return {
    AIHR_SYSTEM_TESTING_SOURCE_REF: record.identity.sourceRef,
    AIHR_SYSTEM_TESTING_BUILD_RECORD_ID: record.identity.buildRecordId,
    AIHR_SYSTEM_TESTING_CATALOGUE_HASH: record.identity.catalogueHash,
    AIHR_SYSTEM_TESTING_CONTENT_HASH: record.identity.contentHash,
    AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD: stableTestingJson(record.sourceHashRecord),
  };
}
/** Empty compile substitutions are explicit so dotenv cannot revive inherited provenance. */
export function emptySystemTestingCompileEnvironment(): Record<string, string> {
  return {
    AIHR_SYSTEM_TESTING_SOURCE_REF: '',
    AIHR_SYSTEM_TESTING_BUILD_RECORD_ID: '',
    AIHR_SYSTEM_TESTING_CATALOGUE_HASH: '',
    AIHR_SYSTEM_TESTING_CONTENT_HASH: '',
    AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD: '',
  };
}
/** A selector only: the Next configuration must reopen and validate the fixed private record. */
export function systemTestingBuildContextEnvironment(record: PreparedTestingBuild, context: 'official' | 'dev_only'): Record<string, string> {
  return { ...systemTestingCompileEnvironment(record), AIHR_SYSTEM_TESTING_BUILD_CONTEXT: context };
}
/**
 * Official release principal only. Directory is selected by the release, never a web request.
 * Caller-owned private selected directory; safe root/caller-owned ancestors. No mutable "latest".
 */
export function publishSystemTestingBuild(record: PreparedTestingBuild, selectedDirectory: string): string {
  record = validatePreparedTestingBuild(record);
  assertPrivateReleaseDirectory(selectedDirectory);
  const directory = resolve(selectedDirectory);
  // Each build has a private immutable directory. mkdir refuses duplicate publication rather than overwrite.
  const buildDirectory = join(directory, record.identity.buildRecordId);
  mkdirSync(buildDirectory, { mode: 0o700 });
  return writeImmutablePrivateJson(buildDirectory, 'system-testing.json', record);
}

export function validatePreparedTestingBuild(raw: unknown, expected?: { sourceRef: string; buildRecordId: string }): PreparedTestingBuild {
  const record = preparedBuildSchema.parse(raw);
  if (sourceContentDigest(record.sourceHashRecord) !== record.identity.contentHash
    || Buffer.byteLength(stableTestingJson(record.sourceHashRecord)) > SYSTEM_TESTING_COMPILE_RECORD_BYTES
    || Buffer.byteLength(stableTestingJson(record) + '\n') > SYSTEM_TESTING_BUILD_RECORD_BYTES
    || expected && (record.identity.sourceRef !== expected.sourceRef || record.identity.buildRecordId !== expected.buildRecordId)) {
    throw new Error('Invalid or oversized prepared System Testing build evidence.');
  }
  return record;
}

export function parsePreparedTestingBuild(bytes: Buffer, expected: { sourceRef: string; buildRecordId: string }): PreparedTestingBuild {
  testingSourceRef.parse(expected.sourceRef); testingUuid.parse(expected.buildRecordId);
  if (!bytes.length || bytes.length > SYSTEM_TESTING_BUILD_RECORD_BYTES) throw new Error('Prepared System Testing build record exceeds its transfer bound.');
  const record = validatePreparedTestingBuild(JSON.parse(bytes.toString('utf8')), expected);
  if (!bytes.equals(Buffer.from(stableTestingJson(record) + '\n'))) throw new Error('Prepared System Testing build record must use its canonical serialization.');
  return record;
}

/** Fixed CLI-owned locations outside the rsynced source and deploy-state tree. No web-selected path. */
export function systemTestingBuildDirectory(location: 'local' | 'remote'): string {
  return location === 'local' ? join(homedir(), '.aihr-gate-state', 'system-testing-builds') : join(homedir(), '.aihr-system-testing-builds');
}

export function assertPrivateReleaseDirectory(selectedDirectory: string): void {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(selectedDirectory)) throw new Error('System Testing build publication requires an absolute private release directory.');
  const directory = resolve(selectedDirectory);
  const parts = directory.split('/').filter(Boolean);
  let cursor = '/';
  for (const part of parts) {
    cursor = join(cursor, part);
    const st = lstatSync(cursor);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== uid) || (st.mode & 0o022) !== 0) throw new Error('Release evidence directory ancestry is not trusted storage.');
  }
  const selected = lstatSync(directory);
  if (selected.uid !== uid || (selected.mode & 0o077) !== 0) throw new Error('Selected release record directory must be private and caller-owned.');
}

/** Validate existing ancestry before creating each private child; never repair permissive storage. */
export function ensurePrivateReleaseDirectory(directory: string): void {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('Absolute canonical release storage required.');
  try { assertPrivateReleaseDirectory(directory); return; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parent = dirname(directory);
  if (parent === directory) throw new Error('Private release storage has no safe parent.');
  // Existing parent need not be private (e.g. the user's home), but every ancestor must be trusted.
  try {
    lstatSync(parent);
    const uid = process.getuid?.();
    let cursor = '/';
    for (const part of parent.split('/').filter(Boolean)) {
      cursor = join(cursor, part); const st = lstatSync(cursor);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== uid) || (st.mode & 0o022)) throw new Error('Release evidence directory ancestry is not trusted storage.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    ensurePrivateReleaseDirectory(parent);
  }
  mkdirSync(directory, { mode: 0o700 });
  assertPrivateReleaseDirectory(directory);
}

function writeImmutablePrivateJson(buildDirectory: string, name: string, value: unknown): string {
  assertPrivateReleaseDirectory(buildDirectory);
  const destination = join(buildDirectory, name), temporary = join(buildDirectory, `.pending-${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, stableTestingJson(value) + '\n'); fsyncSync(fd); closeSync(fd); fd = null;
    // link is atomic and refuses an existing destination; rename could overwrite one.
    linkSync(temporary, destination); unlinkSync(temporary);
    const dirFd = openSync(buildDirectory, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return destination;
  } catch (error) { if (fd !== null) closeSync(fd); try { unlinkSync(temporary); } catch { /* Preserve the original failure. */ } throw error; }
}

function installedBytes(root: string, relative: string, limit: number): Buffer {
  let cursor = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part); const st = lstatSync(cursor);
    if (st.isSymbolicLink() || (index === parts.length - 1 ? !st.isFile() || st.size > limit : !st.isDirectory())) throw new Error('Installed System Testing source is not a bounded regular file.');
  }
  if (realpathSync(cursor) !== cursor) throw new Error('Installed System Testing source escapes its selected root.');
  const fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > limit) throw new Error('Installed System Testing source exceeds its regular-file bound.');
    const bytes = Buffer.alloc(st.size + 1); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; }
    if (offset !== st.size || fstatSync(fd).size !== st.size) throw new Error('Installed System Testing source changed while being read.');
    return bytes.subarray(0, offset);
  }
  finally { closeSync(fd); }
}

/** No Git on the installed server: compare the bounded declared paths with actual shipped bytes. */
export function verifyInstalledTestingBuild(raw: unknown, worktree: string): PreparedTestingBuild {
  const record = validatePreparedTestingBuild(raw), root = resolve(worktree);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Canonical installed System Testing root required.');
  const catalogue = catalogueSchema.parse(JSON.parse(installedBytes(root, SYSTEM_TESTING_CATALOGUE_PATH, 8 * 1024 * 1024).toString('utf8')));
  const required = testingSourcePaths(catalogue), supplied = record.sourceHashRecord.map(row => row.path).sort();
  if (catalogueDigest(catalogue) !== record.identity.catalogueHash || required.length !== supplied.length || required.some((path, index) => path !== supplied[index])) throw new Error('Installed catalogue differs from the selected build record.');
  for (const row of record.sourceHashRecord) {
    if (createHash('sha256').update(installedBytes(root, row.path, 16 * 1024 * 1024)).digest('hex') !== row.sha256) throw new Error(`Installed reviewed source changed: ${row.path}`);
  }
  return record;
}

export function readPublishedTestingBuild(directory: string, expected: { sourceRef: string; buildRecordId: string }): { record: PreparedTestingBuild; bytes: Buffer; buildDirectory: string } {
  testingSourceRef.parse(expected.sourceRef); testingUuid.parse(expected.buildRecordId);
  assertPrivateReleaseDirectory(directory);
  const buildDirectory = join(directory, expected.buildRecordId);
  assertPrivateReleaseDirectory(buildDirectory);
  const file = join(buildDirectory, 'system-testing.json'), st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('Prepared System Testing record is not a private owned file.');
  const bytes = installedBytes(buildDirectory, 'system-testing.json', SYSTEM_TESTING_BUILD_RECORD_BYTES);
  return { record: parsePreparedTestingBuild(bytes, expected), bytes, buildDirectory };
}

export function assertTestingBuildNotObserved(buildDirectory: string): void {
  try { lstatSync(join(buildDirectory, 'successful-build.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('This immutable System Testing build record already has a successful build observation.');
}

export function testingNextBuildId(worktree: string): string {
  const id = installedBytes(resolve(worktree), '.next/BUILD_ID', 512).toString('utf8').trim();
  if (!id || /[\x00-\x1f\x7f]/.test(id)) throw new Error('The successful build has no valid Next build ID.');
  return id;
}

/** Call only after the actual build child exits0; never an arrival or manual-execution receipt. */
export function publishSuccessfulTestingBuild(p: { buildDirectory: string; prepared: PreparedTestingBuild; preparedBytes: Buffer; worktree: string; startedAt: string }): string {
  const record = verifyInstalledTestingBuild(p.prepared, p.worktree);
  if (!p.preparedBytes.equals(Buffer.from(stableTestingJson(record) + '\n'))) throw new Error('Successful build differs from the published preparation.');
  return writeImmutablePrivateJson(p.buildDirectory, 'successful-build.json', {
    format: 1, kind: 'successful-system-testing-build', identity: record.identity,
    preparedRecordSha256: createHash('sha256').update(p.preparedBytes).digest('hex'),
    nextBuildId: testingNextBuildId(p.worktree), buildStartedAt: p.startedAt, observedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, activeServiceVerified: false, manualExecutionVerified: false,
  });
}
