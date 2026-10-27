/** Bounded immutable Git object reads for official build provenance. No worktree writes or mutable cache. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const MAX_BLOB = 16 * 1024 * 1024;
const BATCH_BYTES = 32 * 1024 * 1024;
const validPath = (path: string) => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\0') && !path.includes('\\') && !path.split('/').some(p => !p || p === '.' || p === '..');
export function createCommittedSourceReader(worktree: string, candidate: string) {
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error('Exact immutable source commit required.');
  const git = (args: string[], input?: string, maxBuffer = 40 * 1024 * 1024): Buffer => execFileSync('git', ['-C', worktree, ...args], { input, maxBuffer, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
  const tree = git(['ls-tree', '-rz', '--full-tree', candidate]);
  const entries = new Map<string, { mode: string; type: string; oid: string }>();
  const records = tree.toString('utf8').split('\0');
  if (records.pop() !== '' || records.length > 100000) throw new Error('Bounded complete immutable tree required.');
  for (const record of records) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match || entries.has(match[4])) throw new Error('Malformed or duplicate immutable tree record.');
    entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
  }
  function readObjects<Value>(paths: readonly string[], limit: number, transform: (body: Buffer) => Value, buffered: boolean): Map<string, Value> {
      if (!Array.isArray(paths) || !paths.length || paths.length > 32000 || new Set(paths).size !== paths.length || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BLOB) throw new Error('Bounded unique immutable source paths required.');
      const selected = paths.map(path => {
        const entry = entries.get(path);
        if (!validPath(path) || !entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error('Reviewed System Testing source must be a committed regular file.');
        return { path, oid: entry.oid };
      });
      const ids = [...new Set(selected.map(v => v.oid))];
      const lines = git(['cat-file', '--batch-check'], ids.join('\n') + '\n').toString('ascii').split('\n');
      if (lines.pop() !== '' || lines.length !== ids.length) throw new Error('Incomplete immutable object sizes.');
      const objects = lines.map((line, i) => {
        const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(line);
        const size = match ? Number(match[2]) : NaN;
        if (!match || match[1] !== ids[i] || !Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('Immutable source object exceeds its regular-file bound.');
        return { oid: ids[i], size };
      });
      if (buffered && objects.reduce((sum, object) => sum + object.size, 0) > BATCH_BYTES) throw new Error('Buffered immutable sources exceed the supported bound; use streaming hashes.');
      const bytes = new Map<string, Value>();
      for (let first = 0; first < objects.length;) {
        let last = first, expected = 0;
        while (last < objects.length && expected + objects[last].size + 128 <= BATCH_BYTES) { expected += objects[last].size + 128; last++; }
        if (last === first) throw new Error('Immutable object exceeds batch boundary.');
        const batch = objects.slice(first, last), output = git(['cat-file', '--batch'], batch.map(v => v.oid).join('\n') + '\n');
        let offset = 0;
        for (const object of batch) {
          const end = output.indexOf(10, offset);
          if (end < offset || output.subarray(offset, end).toString('ascii') !== object.oid + ' blob ' + object.size || end + 1 + object.size >= output.length || output[end + 1 + object.size] !== 10) throw new Error('Immutable object frame differs.');
          const body = output.subarray(end + 1, end + 1 + object.size);
          if (createHash('sha1').update('blob ' + body.length + '\0').update(body).digest('hex') !== object.oid) throw new Error('Immutable source bytes differ from the selected Git object.');
          bytes.set(object.oid, transform(body)); offset = end + object.size + 2;
        }
        if (offset !== output.length) throw new Error('Unexpected trailing immutable object bytes.');
        first = last;
      }
      return new Map(selected.map(({ path, oid }) => { const value = bytes.get(oid); if (value === undefined) throw new Error('Missing immutable source object.'); return [path, value]; }));
  }
  return {
    read: (paths: readonly string[], limit = MAX_BLOB) => readObjects(paths, limit, body => Buffer.from(body), true),
    hashes: (paths: readonly string[]) => readObjects(paths, MAX_BLOB, body => createHash('sha256').update(body).digest('hex'), false),
  };
}
