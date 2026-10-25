/** Full CI coverage uses the local gate's classifier, with independent job environments. */
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CI_POLICY} from './policy-version.mjs';
import {buildUnits,hash,CI_EXECUTION} from './manifest.mjs';
export {hash};
export function createPlan(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
  const sha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw Error('CI requires a clean candidate');
  if (process.env.AIHR_CI_HEAD && process.env.AIHR_CI_HEAD !== sha) throw Error('CI checkout does not match requested HEAD');
  const tracked = git('ls-files', 'test').split('\n');
  const suite = tracked.filter(f => /\.test\.ts$|\.dom\.test\.tsx$/.test(f)).sort();
  if (!suite.length) throw Error('Empty test inventory');
  const classifierRuntime=process.env.AIHR_CI_CLASSIFIER_RUNTIME??'tsx';
  if(!['tsx','native'].includes(classifierRuntime))throw Error('Unknown classifier runtime');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(classifierRuntime==='native'&&(major!==22||minor<18))throw Error('Native classifier requires Node 22.18+');
  const loader=classifierRuntime==='native'?['--experimental-strip-types']:['--import','tsx'];
  const classified = execFileSync(process.execPath, [...loader, 'scripts/gate-db-classify.ts', 'explain'], {
    cwd, input: suite.join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trim().split('\n').map(line => line.split('\t'));
  const groups = {nodb: [], db: []};
  for (const [kind, file] of classified) {
    if (!['DB', 'NODB'].includes(kind) || !suite.includes(file)) throw Error('Invalid classifier output');
    groups[kind === 'DB' ? 'db' : 'nodb'].push(file);
  }
  if (JSON.stringify([...groups.db, ...groups.nodb].sort()) !== JSON.stringify(suite)) throw Error('Classifier does not partition the suite exactly');
  const browsers = tracked.filter(f => f.endsWith('.browser.test.tsx')).sort();
  const units = buildUnits(suite,groups,browsers);
  const body = {schemaVersion: 2, policyVersion: CI_POLICY, sha, controller: process.env.AIHR_CI_CONTROL_HEAD ?? 'local', migrationBase: process.env.AIHR_CI_MIGRATION_BASE ?? null, runtime:{node:process.versions.node,platform:process.platform,arch:process.arch}, execution:CI_EXECUTION, suite, units};
  return {...body, fingerprint: hash(body)};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(createPlan(), null, 2));
