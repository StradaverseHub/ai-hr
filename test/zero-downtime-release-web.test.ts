/**
 * ADR-0181 — drift guards for the zero-downtime web release files. The behaviour itself (real systemd,
 * real Nginx, the probe across adopt/switch/rollback, the lock bound against real PostgreSQL, a real
 * Next build) is proven by .github/workflows/zero-downtime-rehearsal.yml; these pin what that workflow
 * cannot notice going stale later:
 *   - the online migration sequence keeps deploy.sh's order of database steps;
 *   - the slot unit keeps the customer unit's hardening and credential exclusions line for line;
 *   - the Nginx snippet keeps the static union in front of the slot and the fallback to the app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const DB_STEP = /(scripts\/check-audit-chain-gate\.ts|db:migrate|scripts\/post-migrate-online\.ts|scripts\/seed-catalogs\.ts|scripts\/backfill-plan-history\.ts|scripts\/backfill-country-modules\.ts|db\/seed-guides\.ts --all)/g;

describe('online migration sequence', () => {
  it('runs the same database steps in the same order as deploy.sh (audit gate repeated after, as on 14 Nov)', () => {
    const code = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const deploy = [...code(read('deploy/deploy.sh')).matchAll(DB_STEP)].map((m) => m[1]);
    const online = [...code(read('deploy/zero-downtime/migrate-online.sh')).matchAll(DB_STEP)].map((m) => m[1]);
    expect(deploy.length).toBeGreaterThanOrEqual(6);
    const firstOccurrence = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);
    expect(firstOccurrence(online)).toEqual(firstOccurrence(deploy));
    expect(online.filter((x) => x === 'scripts/check-audit-chain-gate.ts')).toHaveLength(2);
    expect(online.indexOf('db:migrate')).toBeGreaterThan(online.indexOf('scripts/check-audit-chain-gate.ts'));
  });

  it('refuses to run unless the classifier says online, and bounds the migration lock wait', () => {
    const s = read('deploy/zero-downtime/migrate-online.sh');
    const mode = s.indexOf('migration-release-mode.mjs');
    expect(mode).toBeGreaterThan(0);
    expect(mode).toBeLessThan(s.indexOf('step audit-chain-gate'));
    expect(s).toMatch(/die "release mode is not online/);
    expect(s).toMatch(/searchParams\.set\(\\"lock_timeout\\"/);
    expect(s).toMatch(/AIHR_BOUND_LOCKS=\$LOCK_TIMEOUT step "migrate-attempt-\$attempt" pnpm db:migrate/);
  });
});

describe('slot unit', () => {
  const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  it('keeps every hardening and environment line of the customer unit', () => {
    const customer = lines(read('deploy/aihr-customer.service'));
    const slot = new Set(lines(read('deploy/zero-downtime/aihr-web@.service')));
    // The only lines allowed to differ: identity, paths, and stop behaviour.
    const differs = /^(Description|WorkingDirectory|ExecStartPre|ExecStart|ReadWritePaths|InaccessiblePaths|UnsetEnvironment|TimeoutStopSec)=/;
    const missing = customer.filter((l) => !differs.test(l) && !slot.has(l));
    expect(missing).toEqual([]);
  });

  it('excludes every credential the customer unit excludes, plus an inherited deployment id', () => {
    const unset = (s: string) => new Set(/^UnsetEnvironment=(.*)$/m.exec(s)![1].split(/\s+/));
    const customer = unset(read('deploy/aihr-customer.service'));
    const slot = unset(read('deploy/zero-downtime/aihr-web@.service'));
    expect([...customer].filter((k) => !slot.has(k))).toEqual([]);
    expect(slot.has('NEXT_DEPLOYMENT_ID')).toBe(true);
  });

  it('runs the slot release and lets Next drain on stop', () => {
    const s = read('deploy/zero-downtime/aihr-web@.service');
    expect(s).toMatch(/^WorkingDirectory=\/opt\/aihr-web\/slots\/%i$/m);
    expect(s).toMatch(/^EnvironmentFile=\/etc\/aihr\/web-slot-%i\.env$/m);
    expect(s).toMatch(/^KillSignal=SIGTERM$/m);
    expect(Number(/^TimeoutStopSec=(\d+)$/m.exec(s)![1])).toBeGreaterThanOrEqual(60);
  });
});

describe('Nginx snippet', () => {
  it('serves the static union first and falls back to the active slot', () => {
    const s = read('deploy/zero-downtime/nginx-aihr-web.conf');
    expect(s).toMatch(/location \^~ \/_next\/static\/ \{\s*root \/opt\/aihr-web\/static;\s*try_files \$uri @aihr_web;/);
    expect(s).toMatch(/location @aihr_web \{\s*proxy_pass http:\/\/aihr_web;/);
    expect(s).toMatch(/location \/ \{\s*proxy_pass http:\/\/aihr_web;/);
  });

  it('matches what release-web.sh writes and reads in the upstream file', () => {
    const c = read('deploy/zero-downtime/release-web.sh');
    expect(c).toContain('upstream aihr_web {');
    expect(c).toContain('server 127.0.0.1:$port;');
    expect(c).toMatch(/upstream_port\(\) \{ sed -n 's\/\^ \*server 127\\\.0\\\.0\\\.1:/);
  });
});
