import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {sourceDelta} from './staging-cutover-build.mjs';

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'aihr-delta-'));
  t.after(() => rmSync(cwd, {force: true, recursive: true}));
  const git = (...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
  git('init', '-q');
  mkdirSync(join(cwd, 'components'));
  const put = (file, body) => writeFileSync(join(cwd, file), body);
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'Fixture');
    return git('rev-parse', 'HEAD');
  };
  return {cwd, put, commit};
}

test('exact modified regular files receive baseline and candidate byte hashes', t => {
  const {cwd, put, commit} = repository(t);
  const file = 'components/chart.tsx';
  put(file, 'previous');
  const baseline = commit();
  put(file, 'candidate');
  const candidate = commit();
  const digest = value => createHash('sha256').update(value).digest('hex');
  assert.deepEqual(sourceDelta(cwd, baseline, candidate), {
    baseline, candidate, paths: [file],
    before: [`${digest('previous')}  ${file}`],
    after: [`${digest('candidate')}  ${file}`],
  });
});

test('new files and non-application files retain the full source comparison', t => {
  const {cwd, put, commit} = repository(t);
  put('components/chart.tsx', 'previous');
  put('settings.json', '{}');
  const baseline = commit();
  put('settings.json', '{"new":true}');
  const settings = commit();
  assert.equal(sourceDelta(cwd, baseline, settings), null);
  put('components/export.tsx', 'added');
  const addition = commit();
  assert.equal(sourceDelta(cwd, settings, addition), null);
});
