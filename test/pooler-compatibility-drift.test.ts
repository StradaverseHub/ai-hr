/**
 * Transaction pooling keeps correct only if no web code depends on a session outliving one transaction.
 * The audit behind deploy/pgbouncer/README.md found these features only on connections that stay direct.
 * This allowlist only shrinks: a new entry means routing that code away from the pooled path.
 */
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const ROOTS = ['app', 'core', 'db', 'lib', 'packs'];
const WORKER_LOCK_OWNERS = ['core/bank-import-worker.ts', 'core/individual-import-worker.ts', 'core/leave-import-worker.ts', 'core/loops/tick.ts'];
const RULES: {name: string; pattern: RegExp; allowed: string[]}[] = [
  {name: 'session advisory lock', pattern: /pg_(try_)?advisory_lock(_shared)?\(/, allowed: WORKER_LOCK_OWNERS},
  // Authentication reads hold no session state: their reserved connection only serializes autocommit reads.
  {name: 'reserved connection', pattern: /\.reserve\(\)/, allowed: [...WORKER_LOCK_OWNERS, 'lib/internal-auth/store.ts']},
  {name: 'session GUC', pattern: /set_config\([^)]*,\s*false\s*\)/, allowed: []},
  {name: 'session SET', pattern: /sql`\s*set\s+(?!local\b|transaction\b)[a-z_.]+\s*(=|to)\s/i, allowed: []},
  {name: 'LISTEN or NOTIFY', pattern: /\bpg_notify\(|sql`\s*(listen|notify)\s/i, allowed: []},
  {name: 'temporary table', pattern: /create\s+(local\s+)?temp(orary)?\s+table/i, allowed: []},
  {name: 'WITH HOLD cursor', pattern: /\bwith\s+hold\b/i, allowed: []},
];

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) { if (name !== 'migrations' && name !== 'node_modules') sourceFiles(path, found); }
    else if (/\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

describe('code on the pooled path uses no session state', () => {
  const files = ROOTS.flatMap(root => sourceFiles(root));
  it.each(RULES)('$name appears only where it is allowed', ({pattern, allowed}) => {
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.filter(file => pattern.test(readFileSync(file, 'utf8'))).filter(file => !allowed.includes(file));
    expect(offenders).toEqual([]);
  });
});
