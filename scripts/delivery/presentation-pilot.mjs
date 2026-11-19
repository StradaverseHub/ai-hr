/** First shadow lane: exact reviewed analytics header presentation change. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';

const chart = 'components/charts/ChartCard.tsx';
const journey = 'test/chart-card-export-wrap.browser.test.tsx';
const reviewedJourneySha256 = '42dce0cae93a81887d96b3f4e8adf3b68f1ca8e9da99cdb47f9bab3603629834';
const oldHeader = 'className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"';
const newHeader = oldHeader.replace('flex items-center', 'flex flex-wrap items-center');
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 1024 * 1024});

export function classifyPresentationPilot(cwd, base, candidate) {
  assert(/^[a-f0-9]{40}$/.test(base) && /^[a-f0-9]{40}$/.test(candidate), 'Frozen identities required');
  assert.equal(git(cwd, 'rev-parse', 'HEAD').trim(), candidate);
  git(cwd, 'merge-base', '--is-ancestor', base, candidate);
  const diff = git(cwd, 'diff', '--name-status', '--no-renames', base, candidate).trim().split('\n');
  const broad = reason => ({
    policy: 'aihr-presentation-shadow/v1', base, candidate,
    route: 'broad', reason, releaseAuthorized: false,
  });
  const admittedDiff = [`M\t${chart}`, `A\t${journey}`];
  if (diff.length !== admittedDiff.length || diff.some((entry, index) => entry !== admittedDiff[index])) {
    return broad('The combined diff includes work outside the qualified presentation sample');
  }
  for (const path of [chart, journey]) {
    assert.match(git(cwd, 'ls-tree', candidate, '--', path), /^100644 blob /, 'Only regular source files are admitted');
  }
  const fixture = git(cwd, 'show', `${candidate}:${journey}`);
  if (createHash('sha256').update(fixture).digest('hex') !== reviewedJourneySha256) {
    return broad('The candidate supplies a different acceptance test');
  }
  const before = git(cwd, 'show', `${base}:${chart}`);
  const after = git(cwd, 'show', `${candidate}:${chart}`);
  if (before.split(oldHeader).length !== 2 || after !== before.replace(oldHeader, newHeader)) {
    return broad('The component changes more than the reviewed wrapping rule');
  }
  return {policy: 'aihr-presentation-shadow/v1', base, candidate, route: 'scoped', journey, releaseAuthorized: false};
}

const [cwd, base, candidate, output] = process.argv.slice(2);
if (cwd && base && candidate && output) {
  writeFileSync(output, JSON.stringify(classifyPresentationPilot(cwd, base, candidate)) + '\n', {flag: 'wx'});
}
