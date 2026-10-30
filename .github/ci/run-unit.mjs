/** One exact CI partition; every DB batch gets a fresh, job-owned PostgreSQL container. */
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
import {capturePostgresEvidence,validatePostgresEvidence,postgresProfileFromEnv} from './postgres-evidence.mjs';
import {hostHealth} from './host-health.mjs';
import {createPlan} from './plan.mjs';
import {DB_BATCH_FILES} from './manifest.mjs';
import {validatePdfSetupProof} from './pdf-tools.mjs';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true' || process.platform !== 'linux') throw Error('GitHub runners only; never the shared developer cluster');
const [id, destination] = process.argv.slice(2), plan = createPlan(), unit = plan.units.find(u => u.id === id);
if (!unit || !destination) throw Error('Unknown CI unit or missing evidence directory');
const dir = resolve(destination); mkdirSync(dir, {recursive: true});
const report = {healthBefore: null, schemaVersion: 1, sha: plan.sha, fingerprint: plan.fingerprint, id, cwd: process.cwd(), files: unit.files, batches: [], exitCode: 1};
const closed = 'postgres://nobody:nothing@127.0.0.1:1/no_database';
let failure = false;
try {
  if(unit.kind!=='browser'){report.pdfToolSetup=JSON.parse(readFileSync(join(process.env.RUNNER_TEMP,'pdf-tools-setup.json'),'utf8'));validatePdfSetupProof(plan,unit,report.pdfToolSetup);}
  report.healthBefore = hostHealth();
  writeFileSync(join(dir, `health-before-${id}.json`), JSON.stringify(report.healthBefore,null,2)+'\n', {flag:'wx'});
  if (!report.healthBefore.ok) throw Error('Runner disk headroom too low: '+JSON.stringify(report.healthBefore));
  if(unit.kind==='db')assert.deepEqual(postgresProfileFromEnv(process.env),plan.execution.postgres,'Full CI requires the exact versioned PostgreSQL execution profile');
  const batchSize = unit.kind === 'db' ? DB_BATCH_FILES : Math.max(1, unit.files.length);
  for (let offset = 0; offset < unit.files.length; offset += batchSize) {
    const files = unit.files.slice(offset, offset + batchSize), path = join(dir, `${id}-batch-${offset}.json`);
    if (unit.kind === 'db') {
      if (!hostHealth().ok) throw Error('Runner disk headroom too low before DB batch');
      const reset = spawnSync('bash', [postgres, 'reset'], {stdio: 'inherit', env: {...process.env, AIHR_CI_UNIT: id}});
      if (reset.status !== 0) throw Error('Owned CI PostgreSQL reset failed');
      const migrate = spawnSync('pnpm', ['db:migrate'], {stdio: 'inherit'});
      if(migrate.status !== 0)throw Error('CI migration failed');
    }
    const args = ['exec', 'vitest', 'run'];
    if (unit.kind === 'nodb') args.push('--config', 'vitest.nodb.config.ts');
    if (unit.kind === 'browser') {
      // A runner-owned ignored config selects the actual engine without changing the candidate.
      mkdirSync('.vitest-attachments', {recursive:true});
      const config = '.vitest-attachments/ci-browser.config.mts';
      writeFileSync(config, `import base from '../vitest.browser.config';\nexport default {...base,test:{...base.test,browser:{...base.test.browser,instances:[{browser:${JSON.stringify(unit.engine)}}]}}};\n`);
      args.push('--config', config);
    }
    args.push(...files, '--reporter=default', '--reporter=json', '--outputFile.json=' + path);
    const env = {...process.env, VITEST_MAX_WORKERS: String(plan.execution.workers), VITEST_MAX_WORKERS_NODB: String(plan.execution.workers), AIHR_BROWSER_ENGINE: unit.engine ?? '', AIHR_TEST_DURATION_ORDER: unit.kind==='db'?'true':'false'};
    if (unit.kind !== 'db') for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL']) env[key] = closed;
    const child = spawnSync('pnpm', args, {stdio: 'inherit', env});
    const exitCode = child.status ?? 1;
    const stats = unit.kind === 'db' ? spawnSync('bash', [postgres, 'stats'], {encoding:'utf8', env:{...process.env, AIHR_CI_UNIT:id}}) : null;
    const databaseEvidence=unit.kind==='db'?capturePostgresEvidence(id,plan.execution.postgres):null;
    report.batches.push({exitCode,databaseEvidence, databaseResourceSnapshot: stats?.status === 0 ? JSON.parse(stats.stdout) : null, result: JSON.parse(readFileSync(path, 'utf8'))});
    if(databaseEvidence)validatePostgresEvidence(databaseEvidence,plan.execution);
    failure ||= exitCode !== 0;
  }
  if(createPlan().fingerprint!==plan.fingerprint)throw Error('Candidate changed during CI execution');
  report.exitCode = failure ? 1 : 0;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  report.healthAfter = hostHealth();
  if (unit.kind === 'db') {
    try{report.databaseTerminalEvidence=capturePostgresEvidence(id,plan.execution.postgres);validatePostgresEvidence(report.databaseTerminalEvidence,plan.execution);}catch(error){report.databaseTelemetryError=String(error);report.exitCode=1;}
    const cleanup = spawnSync('bash', [postgres, 'stop'], {stdio: 'inherit', env: {...process.env, AIHR_CI_UNIT: id}});
    if (cleanup.status !== 0) report.exitCode = 1;
  }
  writeFileSync(join(dir, `unit-${id}.json`), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
}
process.exitCode = report.exitCode;
