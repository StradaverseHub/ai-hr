/** Static source hashing only. Run after final integration; --check refuses stale manifests. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = 'lib/ai/module-agent-source-manifest.ts';
const names = [...new Set(execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
  .filter(name => /\.(ts|tsx|mjs|sql|json)$/.test(name) && name !== output && !name.startsWith('.'))
  .sort();
const files = names.map(name => [name, createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex')]);
const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const text = '/** GENERATED static source manifest. Regenerate/check after all integration; no runtime source reads. */\n' +
  'export const MODULE_AGENT_SOURCE_DIGEST = ' + JSON.stringify(digest) + ' as const;\n' +
  'export const MODULE_AGENT_SOURCE_FILE_COUNT = ' + files.length + ' as const;\n';
if (process.argv.includes('--check')) {
  if (readFileSync(resolve(root, output), 'utf8') !== text) throw Error('Module-agent source manifest is stale.');
} else writeFileSync(resolve(root, output), text);
process.stdout.write(JSON.stringify({ files: files.length, digest }) + '\n');
