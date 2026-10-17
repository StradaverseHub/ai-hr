/** Official-release helper only. No web import, tenant data, arbitrary ref checkout or live-arrival claim. */
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { buildIdentitySchema, catalogueSchema, sourceHashRecordSchema, testingSourceRef, testingUuid, type TestingBuildIdentity, type TestingSourceHashRecord } from '../../lib/system-testing/model';
import { catalogueDigest, sourceContentDigest, stableTestingJson, testingSourcePaths } from '../../lib/system-testing/hash';
export const SYSTEM_TESTING_CATALOGUE_PATH = 'lib/system-testing/catalogue.json';
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
  function blob(path: string): Buffer {
    const mode = git(root, ['ls-tree', p.candidate, '--', path]).toString();
    if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(mode)) throw new Error('Reviewed System Testing source must be a committed regular file.');
    return git(root, ['show', `${p.candidate}:${path}`]);
  }
  assertFrozen();
  const catalogueBlob = blob(SYSTEM_TESTING_CATALOGUE_PATH);
  if (catalogueBlob.length > 8 * 1024 * 1024) throw new Error('Reviewed catalogue exceeds the supported bound.');
  const catalogue = catalogueSchema.parse(JSON.parse(catalogueBlob.toString('utf8')));
  const sourceHashRecord = testingSourcePaths(catalogue).map(path => ({ path, sha256: createHash('sha256').update(blob(path)).digest('hex') }));
  assertFrozen();
  return { format: 1, identity: { sourceRef: p.candidate, buildRecordId: p.buildRecordId, catalogueHash: catalogueDigest(catalogue), contentHash: sourceContentDigest(sourceHashRecord) }, sourceHashRecord, activeServiceVerified: false };
}
export function systemTestingCompileEnvironment(record: PreparedTestingBuild): Record<string, string> {
  return {
    AIHR_SYSTEM_TESTING_SOURCE_REF: record.identity.sourceRef,
    AIHR_SYSTEM_TESTING_BUILD_RECORD_ID: record.identity.buildRecordId,
    AIHR_SYSTEM_TESTING_CATALOGUE_HASH: record.identity.catalogueHash,
    AIHR_SYSTEM_TESTING_CONTENT_HASH: record.identity.contentHash,
    AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD: stableTestingJson(record.sourceHashRecord),
  };
}
/**
 * Official release principal only. Directory is selected by the release, never a web request.
 * Caller-owned private selected directory; safe root/caller-owned ancestors. No mutable "latest".
 */
export function publishSystemTestingBuild(record: PreparedTestingBuild, selectedDirectory: string): string {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(selectedDirectory)) throw new Error('System Testing build publication requires an absolute private release directory.');
  record = preparedBuildSchema.parse(record);
  if (record.activeServiceVerified !== false || sourceContentDigest(record.sourceHashRecord) !== record.identity.contentHash) throw new Error('Invalid prepared build evidence.');
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
  // Each build has a private immutable directory. mkdir refuses duplicate publication rather than overwrite.
  const buildDirectory = join(directory, record.identity.buildRecordId);
  mkdirSync(buildDirectory, { mode: 0o700 });
  const destination = join(buildDirectory, 'system-testing.json'), temporary = join(buildDirectory, `.pending-${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, stableTestingJson(record) + '\n'); fsyncSync(fd); closeSync(fd); fd = null;
    // link is atomic and refuses an existing destination; rename could overwrite one.
    linkSync(temporary, destination); unlinkSync(temporary);
    const dirFd = openSync(buildDirectory, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return destination;
  } catch (error) { if (fd !== null) closeSync(fd); try { unlinkSync(temporary); } catch { /* Preserve the original failure. */ } throw error; }
}
