/** Controller-owned readback of ALL runs in an independently admitted fictional tenant.
 * No receipt-selected tenant/run IDs, candidate dependency imports, prompts or secrets.
 * Native tests also exercise the exact projection below through their explicit fixture driver.
 */
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const refuse = () => { throw Error('Independent native evaluation ledger unavailable.'); };
function scopeOf({tenantId, maxAttempts}) {
  if (typeof tenantId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(tenantId)
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1500) refuse();
  return {tenantId, maxAttempts};
}
// Contract-tested against test/db-names.ts in the native suite. No receipt-selected DB names.
export const FOCUSED_NATIVE_DATABASES = Object.freeze(['ai_hr_test_w_aifocus1', 'ai_hr_test_w_aifocus2']);
/** Retain only an admitted focused eval's disposable workers until controller capture.
 * This controls cleanup timing, not financial admission. The controller removes its container finally. */
export function retainNativeLedgerForController(env) {
  if (env.AIHR_EVAL_RETAIN_NATIVE_LEDGER !== 'true') return false;
  const files = JSON.parse(env.AIHR_FOCUSED_TESTS ?? 'null');
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.GITHUB_REPOSITORY !== 'StradaverseHub/ai-hr' || env.GITHUB_WORKFLOW !== 'alpha-focused-checks'
    || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || env.GITHUB_RUN_ATTEMPT !== '1' || env.WORKER_DB === '0' || env.TEST_DB_NAMESPACE !== 'aifocus' || env.VITEST_MAX_WORKERS !== '2'
    || env.AIHR_EVAL_REQUESTED !== 'true' || env.AIHR_EVAL_MODEL !== 'openai/gpt-6-luna' || env.AIHR_EVAL_PATH !== 'production'
    || !/^[a-f0-9]{64}$/.test(env.AIHR_EVAL_PLAN_HASH ?? '') || !/^[a-f0-9]{64}$/.test(env.AIHR_EVAL_CORPUS_REVIEW_DIGEST ?? '')
    || !/^[a-f0-9]{40}$/.test(env.AIHR_CI_HEAD ?? '') || !/^[a-f0-9]{40}$/.test(env.AIHR_CI_CONTROL_HEAD ?? '')
    || !Array.isArray(files) || files.length !== 1
    || !['test/assistant-model-ceiling.eval.test.ts','test/review/teras-review-model.eval.test.ts'].includes(files[0])) refuse();
  return true;
}
export const NATIVE_LEDGER_SQL = `select m.id::text as "runId",m.tenant_id::text as "tenantId",
  r.root_id::text as "rootId",m.feature_id as "featureId",r.capability_digest as "capabilityDigest",
  r.request_digest as "requestDigest",r.configuration_digest as "configurationDigest",
  r.reserved_nanos::text as "reservedNanos",r.confirmed_nanos::text as "confirmedNanos",
  r.state as "spendState",m.provider,m.model,m.operation,m.state as "runState",
  r.receipt_digest as "receiptDigest",r.generation_id as "generationId"
  from public.ai_model_run m left join app.ai_spend_reservation r
    on r.run_id=m.id and r.tenant_id=m.tenant_id
  where m.tenant_id=$1::uuid order by m.id limit $2`;
function complete(rows, maxAttempts) {
  if (!Array.isArray(rows) || rows.length > maxAttempts) refuse();
  return Array.from(rows);
}
/** Test/adapter interface only: caller supplies its independently authorized native connection. */
export async function readNativeLedger(client, scope) {
  const {tenantId, maxAttempts} = scopeOf(scope);
  return client.begin('read only', async tx => {
    await tx`set local statement_timeout = '5s'`;
    await tx`set local lock_timeout = '500ms'`;
    return complete(await tx.unsafe(NATIVE_LEDGER_SQL, [tenantId, maxAttempts + 1]), maxAttempts);
  });
}
function ownedContainer(env, inspect) {
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) refuse();
  const name = `aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-db-1`;
  // Follow the source-owned database image pin; never a candidate module or env-supplied image.
  const pins = readFileSync(new URL('../postgres.sh', import.meta.url), 'utf8').match(/postgres:16@sha256:[a-f0-9]{64}/g);
  if (pins?.length !== 1 || inspect?.Config?.Image !== pins[0]
    || inspect?.Config?.Labels?.['aihr-owner'] !== name || inspect?.State?.Running !== true
    || inspect?.HostConfig?.NetworkMode !== 'host') refuse();
  return name;
}
/** Real controller transport: absolute Docker executable + pinned owned container's SQL client.
 * execute is an explicit fake in mechanics tests; no candidate path/PATH/Node loader is consulted.
 */
export function readOwnedNativeLedger(scope, env, execute = spawnSync) {
  const {tenantId, maxAttempts} = scopeOf(scope);
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) refuse();
  const name = `aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-db-1`;
  const options = {encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    env: {PATH: '/usr/bin:/bin'}};
  const checked = execute('/usr/bin/docker', ['inspect', '--format', '{{json .}}', name], options);
  if (checked.error || checked.status !== 0) refuse();
  ownedContainer(env, JSON.parse(checked.stdout));
  const query = NATIVE_LEDGER_SQL.replace('$1', ":'tenant_id'").replace('$2', ':row_limit');
  const sql = `BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms';
SELECT coalesce(json_agg(row_to_json(native)), '[]'::json) FROM (${query}) native; COMMIT;`;
  const rows = [];
  for (const database of FOCUSED_NATIVE_DATABASES) {
    const result = execute('/usr/bin/docker', ['exec', '-i', name, 'psql', '--no-psqlrc', '--no-password',
      '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', `tenant_id=${tenantId}`, '-v', `row_limit=${maxAttempts + 1}`,
      '-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', database], {...options, input: sql});
    if (result.error || result.status !== 0) refuse();
    rows.push(...complete(JSON.parse(result.stdout), maxAttempts));
    complete(rows, maxAttempts); // One global bound, never a per-worker allocation.
  }
  return rows;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2 || process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true'
      || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'linux') refuse();
    const bytes = readFileSync(0); if (bytes.length > 4096) refuse();
    process.stdout.write(JSON.stringify(readOwnedNativeLedger(JSON.parse(bytes), process.env)));
  } catch {
    process.stderr.write('Independent native evaluation ledger unavailable.\n'); process.exitCode = 1;
  }
}
