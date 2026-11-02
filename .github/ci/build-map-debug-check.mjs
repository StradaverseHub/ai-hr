/** Bounded real Node source-map lookups. Reads build data only; never loads generated JavaScript. */
import assert from 'node:assert/strict';
import {SourceMap} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync, lstatSync, realpathSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';

const MAX_MAP_BYTES = 4 * 1024 ** 2;
const MAX_READ_BYTES = 128 * 1024 ** 2;
const MAX_ATTEMPTS = 48;
const TARGET_MAPS = 6;
const MIN_MAPS = 4;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Decode only enough segments to select actual generated mapping positions. Node,
// independently, resolves those positions to original sources below.
function positions(payload, depth = 0) {
  assert(depth <= 8 && payload?.version === 3, 'Bounded version-3 source map required');
  if (Array.isArray(payload.sections)) {
    assert(payload.sections.length <= 10000, 'Bounded sections required');
    const found = [];
    for (const section of payload.sections) {
      const {line, column} = section.offset ?? {};
      assert(Number.isSafeInteger(line) && line >= 0 && Number.isSafeInteger(column) && column >= 0);
      for (const point of positions(section.map, depth + 1)) {
        found.push({line: point.line + line, column: point.column + (point.line === 0 ? column : 0)});
        if (found.length >= 24) return found;
      }
    }
    return found;
  }
  assert(Array.isArray(payload.sources) && typeof payload.mappings === 'string', 'Source-map fields required');
  // Indexed maps may contain empty generated wrappers alongside real mappings.
  // A selected whole map must still yield actual original-source entries below.
  if (!payload.mappings || !payload.sources.some(s => typeof s === 'string' && s.length > 0)) return [];
  const found = [];
  let line = 0, column = 0, offset = 0, segments = 0;
  while (offset < payload.mappings.length && segments++ < 16384) {
    const character = payload.mappings[offset];
    if (character === ';') { line++; column = 0; offset++; continue; }
    if (character === ',') { offset++; continue; }
    const values = [];
    while (offset < payload.mappings.length && !',;'.includes(payload.mappings[offset])) {
      let value = 0, shift = 0, digit;
      do {
        assert(offset < payload.mappings.length && shift <= 30, 'Bounded VLQ segment required');
        digit = BASE64.indexOf(payload.mappings[offset++]);
        assert(digit >= 0, 'Invalid VLQ character');
        value += (digit & 31) * 2 ** shift;
        shift += 5;
      } while (digit & 32);
      values.push((value & 1) ? -Math.floor(value / 2) : Math.floor(value / 2));
      assert(values.length <= 5, 'Invalid source-map segment');
    }
    assert(values.length > 0, 'Empty source-map segment');
    column += values[0];
    assert(Number.isSafeInteger(column) && column >= 0, 'Invalid generated column');
    if (values.length >= 4) {
      found.push({line, column});
      if (found.length >= 24) break;
    }
  }
  return found;
}

function mappedEntry(map, point) {
  const entry = map.findEntry(point.line, point.column);
  assert(typeof entry.originalSource === 'string' && entry.originalSource.length > 0,
    'Node did not resolve an original source');
  for (const field of ['generatedLine', 'generatedColumn', 'originalLine', 'originalColumn'])
    assert(Number.isSafeInteger(entry[field]) && entry[field] >= 0, 'Node returned an invalid mapped position');
  assert(entry.generatedLine === point.line && entry.generatedColumn === point.column,
    'Probe must hit an actual mapping, not an unrelated preceding entry');
  return entry;
}

function run(original, restored, manifestPath, output) {
  assert(realpathSync(original) === original && realpathSync(restored) === restored);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(Array.isArray(manifest.files) && manifest.files.length <= 40000);
  const buckets = new Map();
  for (const row of manifest.files) {
    if (!row.path.endsWith('.map') || row.size < 64 || row.size > MAX_MAP_BYTES) continue;
    const bucket = row.path.split('/').slice(0, 2).join('/');
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(row);
  }
  for (const rows of buckets.values()) rows.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const candidates = [];
  for (let index = 0; candidates.length < MAX_ATTEMPTS; index++) {
    let added = false;
    for (const rows of buckets.values()) if (rows[index]) { candidates.push(rows[index]); added = true; }
    if (!added) break;
  }
  const cases = [], skipped = [], seen = new Set();
  let readBytes = 0, attempts = 0;
  for (const row of candidates) {
    if (cases.length === TARGET_MAPS || attempts === MAX_ATTEMPTS) break;
    if (seen.has(row.sha256)) continue;
    seen.add(row.sha256); attempts++;
    assert(typeof row.path === 'string' && !row.path.startsWith('/') && !row.path.split('/').includes('..'));
    const bytes = [original, restored].map(root => {
      const file = join(root, row.path), before = lstatSync(file);
      assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size === row.size);
      readBytes += before.size;
      assert(readBytes <= MAX_READ_BYTES, 'Debug probe byte budget exceeded');
      const data = readFileSync(file), after = lstatSync(file);
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(before[key], after[key]);
      assert.equal(hash(data), row.sha256, 'Probe map differs from original manifest');
      return data;
    });
    let payload, points;
    try {
      payload = JSON.parse(bytes[0].toString('utf8'));
      points = positions(payload);
    } catch {
      skipped.push({path: row.path, reason: 'unsupported-or-unmapped-within-bounded-probe'});
      continue;
    }
    if (points.length === 0) { skipped.push({path: row.path, reason: 'no-mapped-positions'}); continue; }
    const maps = [new SourceMap(payload), new SourceMap(JSON.parse(bytes[1].toString('utf8')))];
    const probes = points.slice(0, 6).map(point => {
      const before = mappedEntry(maps[0], point), after = mappedEntry(maps[1], point);
      assert.deepEqual(after, before, 'Actual Node source-map lookup changed');
      return {generated: point, resolved: before};
    });
    cases.push({path: row.path, sha256: row.sha256, probes});
  }
  assert(cases.length >= MIN_MAPS, 'Several real maps with actual Node mappings must succeed');
  const result = {kind: 'ACTUAL_NODE_SOURCE_MAP_COMPARISON_NOT_APPLICATION_ACCEPTANCE', node: process.version,
    attemptedMaps: attempts, readBytes, maps: cases, skipped, applicationCodeExecuted: false, releaseAuthorized: false};
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  process.stdout.write(JSON.stringify({maps: cases.length, mappedProbes: cases.reduce((n, c) => n + c.probes.length, 0)}) + '\n');
}

assert(process.argv.length === 6, 'Usage: node build-map-debug-check.mjs ORIGINAL_TREE RESTORED_TREE ORIGINAL_MANIFEST NEW_OUTPUT_JSON');
run(...process.argv.slice(2).map(value => resolve(value)));
