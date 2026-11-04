import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { issueEntraRecoveryAuthorization, assertEntraRecoveryAuthorization } from './entra-precleanup-authorization.mjs';
import { driveNormalCleanup, openNormalCleanupChannel } from './normal-cleanup-operator.mjs';
import { stagingTransport } from './staging-transport.mjs';
import { validateFinalCleanup } from './staging-ci-promotion.mjs';
import { expectedMigrationLedger } from './staging-migration-ledger.mjs';
import { guardCommand, readLease, leasePhase, redactLeaseError } from '../../scripts/staging/lease.mjs';

const runId = 41683594993;
const baseline = '848c7be36414a1a5216bb33d0ecd49429fcdd60f';
const overlayFiles = [
  'entra-precleanup-authorization.mjs', 'entra-precleanup-inventory.mjs', 'entra-precleanup-server.mjs',
  'normal-cleanup-session.mjs', 'staging-cleanup-protocol.mjs', 'staging-build-install.mjs',
];
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const json = path => JSON.parse(readFileSync(path, 'utf8'));

async function recover(candidate, trusted, original, output, checkRunId) {
  const load = path => import(pathToFileURL(path).href);
  const { cleanHead, verifyCi } = await load(join(trusted, '.github/ci/release-ci.mjs'));
  const controller = cleanHead(resolve(import.meta.dirname, '../..'));
  const source = cleanHead(candidate);
  const frozen = () => {
    assert.equal(cleanHead(candidate), source);
    assert.equal(cleanHead(trusted), baseline);
    assert.equal(cleanHead(resolve(import.meta.dirname, '../..')), controller);
  };
  frozen();
  assert(/^[0-9]+$/.test(checkRunId), 'Exact hosted recovery check required');
  const check = JSON.parse(execFileSync('gh', ['run', 'view', checkRunId, '--json', 'conclusion,headSha,jobs'], { encoding: 'utf8' }));
  assert(check.headSha === controller && check.conclusion === 'success' &&
    check.jobs.some(job => job.name === 'normal-cleanup' && job.conclusion === 'success'),
    'Exact recovery controller hosted cleanup checks must pass');

  const grant = json(join(original, 'installation-grant.json'));
  assert.equal(source, grant.source);
  const lease = readLease(source);
  const leaseIdentity = { batch: lease.batch, epoch: String(lease.epoch) };
  const transport = stagingTransport(candidate, process.env);
  const sshRaw = (command, options = {}) => execFileSync('ssh', transport.sshArgs(command),
    { encoding: 'utf8', timeout: 60_000, ...options });
  const ssh = (command, options) => sshRaw(guardCommand(lease, command), options);
  const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  const imported = await load(join(candidate, 'scripts/improve/release.ts'));
  const official = { ...imported.default, ...imported };
  const current = () => official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
  const running = current();
  assert(running.state === 'ok' && running.built_ref === source &&
    running.built_build_id === grant.build.nextBuildId && running.stale_build === '0', 'Exact live build required');
  const evidence = await verifyCi({ candidatePath: candidate, runId, baseline });
  const certificate = issueEntraRecoveryAuthorization({ grant, lease: leaseIdentity, evidence });
  save('authorization.json', certificate);
  const authorizeGrant = (originalGrant, options = {}) =>
    assertEntraRecoveryAuthorization(certificate, { grant: originalGrant, lease: leaseIdentity, evidence, now: options.now });

  const root = ssh('umask 077; mktemp -d /home/ubuntu/.aihr-entra-recovery.XXXXXXXX').trim();
  assert(/^\/home\/ubuntu\/\.aihr-entra-recovery\.[A-Za-z0-9]{8}$/.test(root), 'Unexpected private recovery path');
  const ci = root + '/.github/ci';
  ssh('mkdir -p ' + quote(ci) + ' && ln -s /opt/ai-hr/scripts ' + quote(root + '/scripts') +
    ' && for f in /opt/ai-hr/.github/ci/*; do ln -s "$f" ' + quote(ci) + '/; done');
  for (const name of overlayFiles) {
    const path = quote(ci + '/' + name);
    const bytes = readFileSync(join(import.meta.dirname, name));
    ssh('umask 077; if test -L ' + path + '; then unlink ' + path + '; fi; set -C; cat > ' + path, { input: bytes });
    const actual = ssh('sha256sum ' + path).split(/\s+/)[0];
    const { installHash } = await import('./ci-install-grant.mjs');
    assert.equal(actual, installHash(bytes), 'Recovery controller transfer changed');
  }
  const privateEvidence = root + '/authorization.json';
  ssh('umask 077; set -C; cat > ' + quote(privateEvidence), { input: JSON.stringify({ certificate, evidence }) });
  const installed = { authorizationSha256: certificate.selection.authorizationSha256, releaseAuthorized: false };
  const install = '/home/ubuntu/.aihr-ci-builds/' + grant.installId;
  for (const name of ['verified', 'activated']) installed[name] = JSON.parse(ssh('cat ' + quote(install + '/' + name + '.json')));
  const checksum = () => execFileSync('rsync',
    ['--dry-run', '--checksum', '--itemize-changes', ...transport.rsyncArgs(official, candidate)],
    { encoding: 'utf8', timeout: 150_000, maxBuffer: 16 * 1024 ** 2 });
  assert.equal(checksum(), '', 'Source differs before recovery');
  frozen();
  const command = 'cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx ' +
    [ci + '/entra-precleanup-server.mjs', source, grant.installId, grant.build.buildRecordId, privateEvidence].map(quote).join(' ');
  leasePhase(lease, sshRaw, 'installing');
  const channel = openNormalCleanupChannel(
    ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', ...transport.sshArgs(guardCommand(lease, command))],
    { terminalTimeout: 2_400_000, frameTimeout: 1_200_000 },
  );
  const arrival = { ...certificate.selection, healthStatus: 200 };
  const result = await driveNormalCleanup({ channel, grant, arrival, checksum, frozen, save, authorizeGrant });
  const verified = validateFinalCleanup(result, { grant, installed, expectedLedger: expectedMigrationLedger(candidate) });
  save('owned-cleanup.json', result);
  assert.equal(checksum(), '', 'Source differs after recovery');
  frozen();
  assert.deepEqual(current().built_ref, source);
  leasePhase(lease, sshRaw, 'arrived', grant.build.nextBuildId);
  save('recovered-arrival.json', verified);
}

try {
  await recover(...process.argv.slice(2));
} catch (error) {
  console.error(redactLeaseError(error));
  process.exitCode = 1;
}
