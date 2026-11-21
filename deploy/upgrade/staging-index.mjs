/** Staging-host entry point. The stage coordinator supplies its fenced lease. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {deriveExpansion, applyIndexExpansion, inspectExpansion} from './index-expansion.mjs';
import {expectedMigrationLedger} from '../../.github/ci/staging-migration-ledger.mjs';
import {installHash, installJson} from '../../.github/ci/ci-install-grant.mjs';

const canonical = '/opt/ai-hr';
const [action, source, migrationDigest, expectedSchema] = process.argv.slice(2);
assert(process.platform === 'linux' && process.cwd() === canonical && realpathSync(canonical) === canonical);
assert.match(source ?? '', /^\/var\/lib\/aihr-cutover\/source\/[a-f0-9]{64}$/);
assert.equal(realpathSync(source), source);
assert.match(migrationDigest ?? '', /^[a-f0-9]{64}$/);
assert.equal(installHash(installJson(expectedMigrationLedger(source))), expectedSchema);
const require = createRequire(canonical + '/package.json');
const postgres = require('postgres');
assert.match(process.env.MIGRATION_DATABASE_URL ?? '', /^postgres(?:ql)?:\/\//);
const client = postgres(process.env.MIGRATION_DATABASE_URL, {max:1, connect_timeout:5, onnotice:()=>{}});
try {
  let result;
  if (action === 'verify-promoted') {
    const installed = expectedMigrationLedger(canonical);
    assert.equal(installHash(installJson(installed)), expectedSchema);
    assert.equal(installed.at(-1).hash, migrationDigest);
    const {collectMigrationLedger} = await import('../../.github/ci/staging-migration-ledger.mjs');
    result = collectMigrationLedger();
  } else {
    assert(['inspect','apply'].includes(action));
    const plan = deriveExpansion(canonical, source);
    assert.equal(plan.index.digest, migrationDigest);
    result = action==='apply' ? await applyIndexExpansion(client, plan) : await inspectExpansion(client, plan);
    result = {...result, tag: plan.row.tag, digest: plan.index.digest};
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({error: error.name, code: error.code ?? 'upgrade-refused',
    detail: error.name === 'AssertionError' ? error.message.split('\n', 1)[0] : undefined}));
  process.exitCode = 1;
} finally {
  await client.end({timeout: 2});
}
