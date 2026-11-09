/** Transfer only the validated development preflight summary to the selected job. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const numericFields = ['runId', 'resolveJobId', 'selectedJobId', 'artifactId'];
const sealFields = ['archiveSha256', 'captureSha256', 'renderedUnionSha256', 'harnessSha256', 'scenarioSha256'];
const fields = ['kind', 'releaseEligible', 'source', ...numericFields, ...sealFields];
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);

/** Encode a closed data shape. Authenticity is established only by the hosted resolver. */
export function encodeMeasuredWorkerPrerequisite(result) {
  assert(result !== null && typeof result === 'object' && !Array.isArray(result)
    && Object.keys(result).length === fields.length && fields.every(field => Object.hasOwn(result, field))
    && result.kind === 'AUTHENTICATED_FULL_DEVELOPMENT_PREFLIGHT_SCOPE_ONLY' && result.releaseEligible === false
    && hex(result.source, 40) && numericFields.every(field => Number.isSafeInteger(result[field]) && result[field] > 0)
    && result.resolveJobId !== result.selectedJobId && sealFields.every(field => hex(result[field], 64)),
  'Measured worker prerequisite summary refused');
  const row = Object.fromEntries(fields.map(field => [field, result[field]]));
  const bytes = Buffer.from(JSON.stringify(row) + '\n', 'utf8');
  return Object.freeze({ admission: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') });
}

function publish(transport) {
  const { RUNNER_TEMP: temp, GITHUB_OUTPUT: path } = process.env;
  assert(temp && path && realpathSync(temp) === temp, 'Measured worker output root refused');
  const directory = join(temp, '_runner_file_commands');
  const name = basename(path);
  assert(/^set_output_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name)
    && path === join(directory, name) && realpathSync(directory) === directory, 'Measured worker output path refused');
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    const matches = row => row.isFile() && row.nlink === 1n && row.uid === BigInt(process.getuid())
      && !(row.mode & 0o022n) && row.dev === before.dev && row.ino === before.ino;
    assert(matches(before) && before.size === 0n && matches(lstatSync(path, { bigint: true })),
      'Measured worker output identity refused');
    const output = Buffer.from(`admission=${transport.admission}\nsha256=${transport.sha256}\n`, 'ascii');
    writeFileSync(fd, output);
    const after = fstatSync(fd, { bigint: true });
    assert(matches(after) && after.size === BigInt(output.length) && matches(lstatSync(path, { bigint: true })),
      'Measured worker output identity changed');
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let stage = 'dispatch', readArchiveRefusal;
  try {
    assert(process.argv.length === 2, 'Measured worker prerequisite takes no arguments');
    const archive = await import('./measured-browser-preflight-archive.mjs');
    readArchiveRefusal = archive.readMeasuredPreflightArchiveRefusalStage;
    let handle;
    stage = 'provider archive';
    try {
      handle = await archive.authenticateMeasuredPreflightArchive();
    } finally {
      delete process.env.GH_TOKEN;
    }
    stage = 'browser evidence';
    const { validateAuthenticatedMeasuredPreflight } = await import('./measured-browser-preflight-semantics.mjs');
    const result = await validateAuthenticatedMeasuredPreflight(handle);
    stage = 'output';
    publish(encodeMeasuredWorkerPrerequisite(result));
  } catch (reason) {
    const detail = stage === 'provider archive' ? readArchiveRefusal(reason) : null;
    process.stderr.write(`Measured worker prerequisite refused during ${stage}${detail ? ' (' + detail + ')' : ''}\n`);
    process.exitCode = 1;
  }
}
