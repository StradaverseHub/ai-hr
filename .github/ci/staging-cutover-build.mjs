/** Authenticate a build-only packet for the migration-free staging lane. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {downloadCiArchives} from './archive-downloads.mjs';
import {expectedMigrationLedger} from './staging-migration-ledger.mjs';
import {REPOSITORY, validateRun} from './release-policy.mjs';
import {installHash, installJson} from './ci-install-grant.mjs';
import {cleanHead, sourceBoundBuild} from './release-ci.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const api = (route) => JSON.parse(execFileSync('gh', ['api', `repos/${REPOSITORY}/${route}`], {
  encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 ** 2,
}));
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', timeout: 12000}).trim();

// An accepted canonical baseline plus authenticated before/after bytes lets
// us reconcile narrowly scoped regular-file edits without rescanning the tree.
export function sourceDelta(cwd, baseline, candidate) {
  const raw = execFileSync('git', ['diff', '--name-status', '-z', '--no-renames', baseline, candidate],
    {cwd, encoding: 'utf8', timeout: 12000});
  const changes = raw.split('\0').slice(0, -1);
  if (!changes.length || changes.length > 200 || changes.length % 2) return null;
  const paths = [], before = [], after = [];
  for (let i = 0; i < changes.length; i += 2) {
    const [status, file] = changes.slice(i, i + 2);
    if (status !== 'M' || !/^(app|components|lib|messages|test)\/[a-zA-Z0-9_./-]+$/.test(file)
        || file.split('/').some(part => !part || part === '.' || part === '..')) return null;
    const mode = (ref) => git(cwd, 'ls-tree', ref, '--', file).split(' ')[0];
    if (mode(baseline) !== '100644' || mode(candidate) !== '100644') return null;
    const hashAt = (ref) => createHash('sha256').update(execFileSync('git', ['show', `${ref}:${file}`],
      {cwd, timeout: 12000, maxBuffer: 16 * 1024 ** 2})).digest('hex');
    paths.push(file);
    before.push(`${hashAt(baseline)}  ${file}`);
    after.push(`${hashAt(candidate)}  ${file}`);
  }
  return {baseline, candidate, paths, before, after};
}

export async function verifyCutoverBuild({source, baseline, controller, runId, directory}) {
  const candidate = cleanHead(source);
  assert(sha(baseline) && sha(controller) && Number.isSafeInteger(runId) && runId > 0);
  assert.equal(git(source, 'merge-base', baseline, candidate), baseline, 'Staging baseline diverged');
  assert.equal(git(source, 'diff', '--name-only', baseline, candidate, '--', 'db/migrations',
    'pnpm-lock.yaml', 'package.json', 'deploy/deploy-state.sh', 'scripts/staging', '.github/ci/build-activate.py'), '', 'Migrations and runtime dependency updates require the upgrade path');
  const run = api(`actions/runs/${runId}`);
  validateRun(run, {runId, baseline, candidate, controller});
  assert.equal(run.event, 'workflow_dispatch', 'Build-only dispatch is required');
  assert.match(run.display_title, /^Canonical build only · /);
  const jobs = api(`actions/runs/${runId}/jobs?per_page=100`);
  assert.equal(jobs.jobs.length, jobs.total_count, 'Incomplete job inventory');
  const producers = jobs.jobs.filter(job => job.name === 'build');
  assert.equal(producers.length, 1, 'Unique build producer required');
  assert.equal(producers[0].conclusion, 'success', 'Build producer did not qualify');
  assert.equal(producers[0].run_attempt, 1);
  const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`);
  assert.equal(artifacts.artifacts.length, artifacts.total_count, 'Incomplete artifact inventory');
  assert(!artifacts.artifacts.some(artifact => artifact.name === 'gate-evidence'), 'Unexpected full gate receipt');
  const binaries = artifacts.artifacts.filter(artifact => artifact.name === BUILD_ARTIFACT);
  assert.equal(binaries.length, 1, 'Unique build artifact required');
  const [artifact] = binaries;
  assert.equal(artifact.workflow_run?.id, runId);
  assert.equal(artifact.workflow_run?.head_sha, controller);
  await mkdir(directory, {mode: 0o700});
  await downloadCiArchives([artifact], directory);
  execFileSync('python3', [path.join(scriptDir, 'build-transport-extract.py'),
    path.join(directory, `${BUILD_ARTIFACT}.zip`), path.join(directory, BUILD_ARTIFACT),
    artifact.digest.slice(7)], {timeout: 60000, stdio: 'inherit'});
  const build = await sourceBoundBuild({
    candidatePath: source, dir: directory,
    p: {candidate, controller, runId, controllerBranch: run.head_branch}, jobs: jobs.jobs,
  });
  assert.equal(cleanHead(source), candidate, 'Selected candidate changed during verification');
  const archive = path.join(directory, 'source.tar.gz');
  const child = spawn('git', ['archive', '--format=tar.gz', candidate], {cwd: source, stdio: ['ignore', 'pipe', 'inherit']});
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Source archive failed')));
  });
  await Promise.all([pipeline(child.stdout, createWriteStream(archive, {flags: 'wx', mode: 0o600})), exited]);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  const delta = sourceDelta(source, baseline, candidate);
  const deltaBytes = JSON.stringify(delta) + '\n';
  await writeFile(path.join(directory, 'source-delta.json'), deltaBytes, {flag: 'wx', mode: 0o600});
  const prepared = {
    ...build,
    schema: installHash(installJson(expectedMigrationLedger(source))),
    sourceArchiveSha256: digest.digest('hex'),
    sourceDeltaSha256: createHash('sha256').update(deltaBytes).digest('hex'),
    startedAt: run.run_started_at,
    publishedAt: artifact.created_at,
  };
  await writeFile(path.join(directory, 'verified.json'), JSON.stringify(prepared) + '\n', {flag: 'wx', mode: 0o600});
  return prepared;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, baseline, controller, run, directory] = process.argv.slice(2);
  const result = await verifyCutoverBuild({source, baseline, controller, runId: Number(run), directory});
  console.log(JSON.stringify({source: result.source, build: result.nextBuildId, archive: result.archiveSha256}));
}
