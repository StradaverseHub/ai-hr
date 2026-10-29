/** Static source hashing only. Run after final integration; --check refuses stale manifests.
 * WP11: the hashed set is the explicit AI behaviour surface in scripts/ai-agent-source-scope.mjs. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { AI_SOURCE_MANIFEST_OUTPUT as output, aiSourceFiles, aiSourceDigest } from './ai-agent-source-scope.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = aiSourceFiles(execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'));
const files = names.map(name => [name, createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex')]);
const digest = aiSourceDigest(files);
const text = '/** GENERATED static source manifest of the AI behaviour surface (scripts/ai-agent-source-scope.mjs).\n' +
  ' * Regenerate/check after all integration; no runtime source reads. */\n' +
  'export const MODULE_AGENT_SOURCE_DIGEST = ' + JSON.stringify(digest) + ' as const;\n' +
  'export const MODULE_AGENT_SOURCE_FILE_COUNT = ' + files.length + ' as const;\n';
if (process.argv.includes('--check')) {
  if (readFileSync(resolve(root, output), 'utf8') !== text) throw Error('Module-agent source manifest is stale.');
} else writeFileSync(resolve(root, output), text);
process.stdout.write(JSON.stringify({ files: files.length, digest }) + '\n');
