import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {inspectCiBuildPacket} from '../../.github/ci/build-artifact.mjs';

const [packet, jobJson, applicationSource] = process.argv.slice(2);
const job = JSON.parse(jobJson);
const build = inspectCiBuildPacket(packet, {
  candidate: applicationSource,
  controller: job.head_sha,
  runId: job.run_id,
  controllerBranch: job.head_branch,
  producerStartedAt: job.started_at,
  producerCompletedAt: job.completed_at,
});
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(hash('pnpm-lock.yaml'), build.lockSha256);
assert.equal(hash('package.json'), build.packageSha256);
const source = process.cwd();
const moved = build.buildSourcePath !== source;
execFileSync('python3', [
  '.github/ci/build-bundle.py', moved ? 'unpack-with-origin' : 'unpack',
  join(packet, 'bytes/build-bundle.tar.gz'), join(packet, 'bytes/build-bundle-files.json'),
  '.next', source, ...(moved ? [build.buildSourcePath] : []),
], {stdio: 'inherit'});
assert.equal(readFileSync('.next/BUILD_ID', 'utf8').trim(), build.nextBuildId);
