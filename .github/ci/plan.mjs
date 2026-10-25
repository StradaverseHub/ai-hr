/** Full CI coverage uses the local gate's classifier, with independent job environments. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CI_POLICY} from './policy-version.mjs';
export const CI_SHARDS = 4;
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function createPlan(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
  const sha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw Error('CI requires a clean candidate');
  if (process.env.AIHR_CI_HEAD && process.env.AIHR_CI_HEAD !== sha) throw Error('CI checkout does not match requested HEAD');
  const tracked = git('ls-files', 'test').split('\n');
  const suite = tracked.filter(f => /\.test\.ts$|\.dom\.test\.tsx$/.test(f)).sort();
  if (!suite.length) throw Error('Empty test inventory');
  const classified = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gate-db-classify.ts', 'explain'], {
    cwd, input: suite.join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trim().split('\n').map(line => line.split('\t'));
  const groups = {nodb: [], db: []};
  for (const [kind, file] of classified) {
    if (!['DB', 'NODB'].includes(kind) || !suite.includes(file)) throw Error('Invalid classifier output');
    groups[kind === 'DB' ? 'db' : 'nodb'].push(file);
  }
  if (JSON.stringify([...groups.db, ...groups.nodb].sort()) !== JSON.stringify(suite)) throw Error('Classifier does not partition the suite exactly');
  const units = [];
  for (const kind of ['nodb', 'db']) for (let index = 0; index < CI_SHARDS; index++) {
    units.push({id: `${kind}-${index + 1}`, kind, files: groups[kind].filter((_, i) => i % CI_SHARDS === index)});
  }
  const browsers = tracked.filter(f => f.endsWith('.browser.test.tsx')).sort();
  if (!browsers.length) throw Error('Missing browser inventory');
  for (const engine of ['chromium', 'firefox', 'webkit']) units.push({id: `browser-${engine}`, kind: 'browser', engine, files: browsers});
  const body = {schemaVersion: 1, policyVersion: CI_POLICY, sha, controller: process.env.AIHR_CI_CONTROL_HEAD ?? 'local', migrationBase: process.env.AIHR_CI_MIGRATION_BASE ?? null, runtime:{node:process.versions.node,platform:process.platform,arch:process.arch}, suite, units};
  return {...body, fingerprint: hash(body)};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(createPlan(), null, 2));
