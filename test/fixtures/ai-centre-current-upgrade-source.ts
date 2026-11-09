/** Held input for the current fictional upgrade fixture. No database or filesystem writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appliedMigrationIdentity, HISTORICAL_MIGRATIONS } from '../../.github/ci/migration-history.mjs';
import { expectedBaselineMigrationLedger } from '../../.github/ci/staging-migration-ledger.mjs';

const incoming = 'f07f32dcd0ccaeb6b49d40f2b6c64307b9bf80fc';
const checkpointJournalSha256 = '69e00aaf89b8c9deb4d0e81f36d3cb732343e66565b2fa95da15a33842d1cf38';
const incomingLedgerSha256 = '949043cefb77fecae0e9909d9421680f9cfcb4d4fc9953b4a2052121ea92fb00';
const architectureTailSha256 = '5fe119909f6e737f575158b95051497b815fc92a8ad149593b76ebef81ed7ddd';
const firstPending = '2103_system_performance_read_guards';
const compatibility = '3500_ai_centre_architecture_compatibility';
const mandate = '3501_ai_centre_mandate_write_order';
const sqlMaximum = 512 * 1024;
const inputMaximum = 16 * 1024 * 1024;

type JournalRow = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalRow[] };
type LedgerIdentity = { tag: string; created_at: string; hash: string };

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const ledgerTuple = ({ tag, created_at, hash }: LedgerIdentity) => [tag, created_at, hash];
const ledgerDigest = (rows: LedgerIdentity[]) => sha(JSON.stringify(rows.map(ledgerTuple)));

function heldBytes(path: string, maximum: number): Buffer<ArrayBuffer> {
  assert.equal(realpathSync(path), path, 'Current upgrade source path differs');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    assert(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= maximum,
      'Bounded regular current upgrade source required');
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const received = readSync(fd, data, offset, data.length - offset, offset);
      assert(received > 0, 'Current upgrade source truncated');
      offset += received;
    }
    const after = fstatSync(fd);
    assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, data.length), 0, 'Current upgrade source grew');
    assert(after.size === before.size && after.ctimeMs === before.ctimeMs,
      'Current upgrade source changed');
    return data;
  } finally {
    closeSync(fd);
  }
}

/** Call only after admission for the eventual hosted singleton. The observed native
 * baseline, separate M login, and native rollback still require their own proof. */
export function readCurrentAiCentreUpgradeSource(source: string) {
  const root = resolve(source);
  assert.equal(root, source);
  assert.equal(realpathSync(root), root);
  const bytes = heldBytes(join(root, 'db/migrations/meta/_journal.json'), 256 * 1024);
  const journal: Journal = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(journal).sort(), ['dialect', 'entries', 'version']);
  assert.equal(journal.dialect, 'postgresql');
  assert.equal(journal.version, '7');
  assert(Array.isArray(journal.entries));
  const boundary = journal.entries.findIndex(row => row.tag === firstPending);
  const end = journal.entries.findIndex(row => row.tag === mandate) + 1;
  assert(boundary > 0 && end - boundary === 38);
  const checkpoint = journal.entries.slice(0, end);
  const tail = checkpoint.slice(boundary);
  const tuples = checkpoint.map(row => {
    assert.deepEqual(Object.keys(row).sort(), ['breakpoints', 'idx', 'tag', 'version', 'when']);
    return [row.idx, row.version, row.when, row.tag, row.breakpoints];
  });
  assert.equal(sha(JSON.stringify(tuples)), checkpointJournalSha256, 'Unreviewed AI Centre checkpoint journal');

  // A later candidate may have a strictly appended suffix. The replay and receipt
  // still stop at this checkpoint, with no claim about an unexecuted suffix.
  let previous = checkpoint.at(-1)!;
  for (const row of journal.entries.slice(end)) {
    assert(Number.isSafeInteger(row.idx) && row.idx > previous.idx);
    assert(Number.isSafeInteger(row.when) && row.when > previous.when);
    previous = row;
  }
  assert.equal(tail.at(-2)?.tag, compatibility);
  assert.equal(tail.at(-1)?.tag, mandate);

  // The existing history owner separately compares the unchanged Git prefix and its applied-byte exceptions.
  const verifiedIncoming: LedgerIdentity[] = expectedBaselineMigrationLedger(root, incoming);
  assert.equal(verifiedIncoming.length, boundary);
  assert.equal(ledgerDigest(verifiedIncoming), incomingLedgerSha256);

  const histories = new Set<string>(HISTORICAL_MIGRATIONS.map(record => record.tag));
  const seen = new Set<string>();
  let aggregate = bytes.length;
  const migrations = checkpoint.map(row => {
    assert(/^[a-zA-Z0-9_-]{1,160}$/.test(row.tag) && !seen.has(row.tag));
    seen.add(row.tag);
    const name = row.tag + '.sql';
    const current = heldBytes(join(root, 'db/migrations', name), sqlMaximum);
    const historical = histories.has(row.tag);
    const sql = historical
      ? heldBytes(join(root, '.github/ci/historical-migrations', name), 32768)
      : current;
    aggregate += current.length + (historical ? sql.length : 0);
    assert(aggregate <= inputMaximum, 'Current upgrade source exceeds its aggregate bound');
    const identity = appliedMigrationIdentity(row.tag, row.when, current, { readArchive: () => sql });
    assert.equal(sha(sql), identity.hash);
    return { name, bytes: sql, ledger: { tag: row.tag, created_at: String(row.when), hash: identity.hash } };
  });
  const expected = migrations.map(migration => migration.ledger);
  assert.deepEqual(expected.slice(0, boundary).map(ledgerTuple), verifiedIncoming.map(ledgerTuple));
  assert.equal(ledgerDigest(expected.slice(boundary)), architectureTailSha256);
  return {
    incoming,
    boundary,
    baselineJournal: JSON.stringify({ ...journal, entries: journal.entries.slice(0, boundary) }),
    checkpointTag: mandate,
    checkpointJournal: JSON.stringify({ ...journal, entries: checkpoint }),
    migrations,
    expected,
  };
}
