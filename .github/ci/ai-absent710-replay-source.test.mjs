import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {readAbsent710ReplaySources} from './ai-absent710-replay-source.mjs';

const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const journalPath = 'db/migrations/meta/_journal.json';
const original0180 = '.github/ci/historical-migrations/0180_profile_option.sql';
const original0212 = '.github/ci/historical-migrations/0212_dashboard_card_config.sql';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('reads the whole selected alpha prefix with the two exact installation originals', () => {
  const snapshot = readAbsent710ReplaySources(root);
  const sourceJournal = JSON.parse(readFileSync(join(root, journalPath)));
  assert.equal(snapshot.files.length, 717);
  assert.deepEqual(snapshot.journal710.entries, sourceJournal.entries.slice(0, 710));
  assert.deepEqual(snapshot.journal717.entries, sourceJournal.entries.slice(0, 717));
  assert.equal(snapshot.journal710.entries.at(-1).tag, '3400_system_label_company_scope');
  assert.deepEqual(snapshot.journal717.entries.slice(710).map(row => row.tag), [
    '3700_pay_item_company_applicability',
    '3701_rewards_unit_preparation',
    '3702_maybank_payment_arrangement',
    '3703_attendance_formula_versions',
    '3704_attendance_formula_results',
    '3705_attendance_formula_payroll_source',
    '3706_attendance_formula_overtime_binding',
  ]);
  assert.deepEqual(snapshot.ledger710, snapshot.ledger717.slice(0, 710));
  assert.deepEqual(snapshot.ledger717.map(row => row.created_at),
    sourceJournal.entries.slice(0, 717).map(row => String(row.when)));
  for (const [tag, path, expectedHash] of [
    ['0180_profile_option', original0180, 'ae128e75c9491bd1d39537fdddd18ad9307b2050f813b8a056d473dcfda9d41f'],
    ['0212_dashboard_card_config', original0212, 'aa9337028da35cd3816d8d66486455595e36aea709c98405868ca36320c99f41'],
  ]) {
    const position = snapshot.journal710.entries.findIndex(row => row.tag === tag);
    assert(position >= 0);
    const file = snapshot.files[position];
    assert.equal(file.tag, tag);
    assert.deepEqual(file.bytes, readFileSync(join(root, path)));
    assert.equal(sha256(file.bytes), expectedHash);
    assert.equal(snapshot.ledger710[position].hash, expectedHash);
    assert.notEqual(file.canonicalSha256, expectedHash);
  }
  const alpha = snapshot.files.find(file => file.tag === '3701_rewards_unit_preparation');
  assert.deepEqual(alpha.bytes, readFileSync(join(root, 'db/migrations/3701_rewards_unit_preparation.sql')));
  assert.equal(alpha.replaySha256, '4d8969bfc0b8f134f8cc01c42a738eb6cc4babdcb1ccfb0ec824a61d9b9fee11');
});

test('refuses drifted ordering, changed canonical or archived bytes and a linked source path', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'aihr-absent710-source-'));
  try {
    const journalBytes = readFileSync(join(root, journalPath));
    const journal = JSON.parse(journalBytes);
    const paths = [journalPath, original0180, original0212,
      ...journal.entries.slice(0, 717).map(({tag}) => `db/migrations/${tag}.sql`)];
    for (const path of paths) {
      mkdirSync(dirname(join(dir, path)), {recursive: true});
      copyFileSync(join(root, path), join(dir, path));
    }

    const targetJournal = join(dir, journalPath);
    [journal.entries[710], journal.entries[711]] = [journal.entries[711], journal.entries[710]];
    writeFileSync(targetJournal, JSON.stringify(journal));
    assert.throws(() => readAbsent710ReplaySources(dir), /Ordered 717 replay journal differs/);
    writeFileSync(targetJournal, journalBytes);

    const canonical = join(dir, 'db/migrations/3701_rewards_unit_preparation.sql');
    const canonicalBytes = readFileSync(canonical);
    writeFileSync(canonical, Buffer.concat([canonicalBytes, Buffer.from('\n-- changed fixture bytes\n')]));
    assert.throws(() => readAbsent710ReplaySources(dir), /Canonical 717 migration bytes differ/);
    writeFileSync(canonical, canonicalBytes);

    const archive = join(dir, original0180);
    const archiveBytes = readFileSync(archive);
    writeFileSync(archive, Buffer.concat([archiveBytes, Buffer.from('\n-- changed original bytes\n')]));
    assert.throws(() => readAbsent710ReplaySources(dir), /Original applied SQL bytes differ/);
    writeFileSync(archive, archiveBytes);

    const aliasTarget = `${archive}.target`;
    renameSync(archive, aliasTarget);
    symlinkSync(aliasTarget, archive);
    assert.throws(() => readAbsent710ReplaySources(dir), /Replay source path is not canonical/);
    unlinkSync(archive);
    renameSync(aliasTarget, archive);

    assert.equal(readAbsent710ReplaySources(dir).files.length, 717);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
