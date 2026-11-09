/** Fixed installation-parity replay bytes. The native course owns all DDL and admission. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {appliedMigrationIdentity} from './migration-history.mjs';

const historicalCount = 710;
const selectedCount = 717;
const maximumSourceFile = 4 * 1024 * 1024;
const maximumArchiveFile = 32 * 1024;
const maximumSqlBytes = 16 * 1024 * 1024;
const expected = Object.freeze({
  tuples710: '0c1400ecff0da4595cbe4106e3aed49097ebf3398ddfaf33b19ef010d7319cc5',
  tuples717: '1c09c88bea94c7f4966abe99a2c4d28fd49c5a1493ac61ccda0244a7a63c1530',
  canonical717: '9e2dd13f608f0178d26544d8eeade945f5b50dd18bd6444dda87bcdc0cb8f8a2',
  replay710: 'ea0b1b962aed4e5eb460ac3de3ffbe1471c7f4d74fcef546e8ae320210270b04',
  replay717: '9abdbba7f20e2a0f12879c653ee4f42389a33e5e559f286a2e35cd6a125186a8',
});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mode === second.mode && first.nlink === second.nlink
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function readSourceFile(path, maximum) {
  assert.equal(realpathSync(path), path, 'Replay source path is not canonical');
  const before = lstatSync(path, {bigint: true});
  assert(before.isFile() && before.nlink === 1n && before.size > 0n
    && before.size <= BigInt(maximum), 'Replay source must be a bounded regular file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, {bigint: true});
    assert(sameFile(before, opened), 'Replay source changed while opening');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert(length > 0, 'Replay source truncated while reading');
      offset += length;
    }
    assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, offset), 0, 'Replay source grew while reading');
    assert(sameFile(opened, fstatSync(fd, {bigint: true})), 'Replay source changed while reading');
    assert.equal(realpathSync(path), path, 'Replay source path is not canonical');
    assert(sameFile(opened, lstatSync(path, {bigint: true})), 'Replay source path changed while reading');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** The admitted owner must bind the candidate root before calling this reader. */
export function readAbsent710ReplaySources(candidateRoot) {
  assert(typeof candidateRoot === 'string' && isAbsolute(candidateRoot) && resolve(candidateRoot) === candidateRoot,
    'Replay source root must be absolute and canonical');
  assert.equal(realpathSync(candidateRoot), candidateRoot, 'Replay source root must be absolute and canonical');
  const journal = JSON.parse(readSourceFile(join(candidateRoot, 'db/migrations/meta/_journal.json'), maximumSourceFile));
  assert(journal?.version === '7' && journal?.dialect === 'postgresql' && Array.isArray(journal.entries)
    && journal.entries.length >= selectedCount, 'Complete selected replay journal required');
  const selectedEntries = journal.entries.slice(0, selectedCount);
  const historicalEntries = selectedEntries.slice(0, historicalCount);
  assert.equal(digest(selectedEntries), expected.tuples717, 'Ordered 717 replay journal differs');
  assert.equal(digest(historicalEntries), expected.tuples710, 'Ordered 710 replay journal differs');

  let sqlBytes = 0;
  function readSql(relative, maximum) {
    const bytes = readSourceFile(join(candidateRoot, relative), Math.min(maximum, maximumSqlBytes - sqlBytes));
    sqlBytes += bytes.length;
    return bytes;
  }
  const files = [];
  for (const {tag, when} of selectedEntries) {
    assert(/^[0-9]{4}_[a-z0-9_]+(?![\s\S])/.test(tag), 'Replay migration tag is not canonical');
    const canonical = readSql(`db/migrations/${tag}.sql`, maximumSourceFile);
    let original;
    const identity = appliedMigrationIdentity(tag, when, canonical, {
      readArchive: record => {
        original = readSql(`.github/ci/historical-migrations/${record.tag}.sql`, maximumArchiveFile);
        return original;
      },
    });
    files.push({tag, canonicalSha256: identity.sourceSha256 ?? identity.hash,
      replaySha256: identity.hash, bytes: original ?? canonical});
  }

  const canonicalPairs = files.map(file => [file.tag, file.canonicalSha256]);
  const replayPairs = files.map(file => [file.tag, file.replaySha256]);
  assert.equal(digest(canonicalPairs), expected.canonical717, 'Canonical 717 migration bytes differ');
  assert.equal(digest(replayPairs.slice(0, historicalCount)), expected.replay710, 'Replayed 710 migration bytes differ');
  assert.equal(digest(replayPairs), expected.replay717, 'Replayed 717 migration bytes differ');

  const ledger717 = selectedEntries.map(({when}, index) => ({
    hash: files[index].replaySha256, created_at: String(when),
  }));
  return {
    journal710: {version: journal.version, dialect: journal.dialect, entries: historicalEntries},
    journal717: {version: journal.version, dialect: journal.dialect, entries: selectedEntries},
    ledger710: ledger717.slice(0, historicalCount),
    ledger717,
    files,
  };
}
