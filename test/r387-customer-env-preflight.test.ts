/** Real deployment entry points + real preflight, with all later install/DB/service commands stubbed. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const dirs: string[] = [];
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
// Structurally configured fixtures only: this test never contacts WorkOS or a database.
const SAFE_ENV: Record<string, string> = {
  NODE_ENV: 'production', AUTH_PROVIDER: 'workos',
  MIGRATION_DATABASE_URL: 'postgresql://owner:fixture@127.0.0.1:1/preflight',
  DATABASE_URL: 'postgresql://app:fixture@127.0.0.1:1/preflight',
  SHARE_PASSWORD: 'fixture-holding-gate-password',
  AI_CONFIG_SECRET: 'fixture-encryption-password',
  AUDIT_HASH_CHAIN_ENABLED: 'true',
  WORKOS_API_KEY: 'sk_customer_fixture',
  WORKOS_CLIENT_ID: 'client_customer_fixture',
  WORKOS_COOKIE_PASSWORD: 'fixture-cookie-password-with-32-characters',
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: 'https://hr.customer.com/callback',
};

function runDeploy(
  changes: Record<string, string | undefined> = {},
  options: { args?: string[]; script?: string; extraFile?: string; inherited?: Record<string, string>; removeGuard?: boolean; template?: boolean; nodeVersion?: string } = {},
) {
  // deploy.sh prepends this host-specific toolchain; make a shadowed shim a loud test failure.
  expect(fs.existsSync('/opt/node20/bin')).toBe(false);
  expect(fs.existsSync('/opt/node22/bin')).toBe(false);
  expect(fs.existsSync('/opt/node24/bin')).toBe(false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r387-customer-env-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const trace = path.join(dir, 'trace');
  for (const subdir of [bin, path.join(dir, 'deploy'), path.join(dir, 'node_modules')]) fs.mkdirSync(subdir);
  for (const file of ['deploy.sh', 'deploy-customer.sh', 'deploy-state.sh', 'check-customer-env.mjs']) {
    fs.copyFileSync(path.join(REPO, 'deploy', file), path.join(dir, 'deploy', file));
    fs.chmodSync(path.join(dir, 'deploy', file), 0o755);
  }
  if (options.removeGuard) {
    const file = path.join(dir, 'deploy/deploy.sh');
    const source = fs.readFileSync(file, 'utf8');
    expect(source.split('  node deploy/check-customer-env.mjs\n')).toHaveLength(2);
    fs.writeFileSync(file, source.replace('  node deploy/check-customer-env.mjs\n', '  :\n'));
  }
  const values = { ...SAFE_ENV, ...changes };
  fs.writeFileSync(path.join(dir, '.env.production'), options.template
    ? fs.readFileSync(path.join(REPO, 'deploy/.env.customer.example'), 'utf8')
    : Object.entries(values).filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}=${quote(value!)}`).join('\n'));
  if (options.extraFile) fs.writeFileSync(path.join(dir, options.extraFile), 'ALLOW_DEMO_SESSION=true\n');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'fixture\n');
  // Exercise the production check in a process reporting an obsolete runtime, without requiring an
  // obsolete executable on the developer's machine. This only affects the disposable Node shim.
  const versionImport = options.nodeVersion ? ` --import ${quote(path.join(bin, 'node-version.mjs'))}` : '';
  if (options.nodeVersion) fs.writeFileSync(path.join(bin, 'node-version.mjs'),
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(options.nodeVersion)} });\n`);
  for (const command of ['pnpm', 'node', 'psql', 'sudo', 'systemctl', 'sha256sum']) {
    const body = command === 'node'
      ? `if [ "$1" = "deploy/check-customer-env.mjs" ]; then exec ${quote(process.execPath)}${versionImport} "$@"; fi\n`
      : command === 'sha256sum' ? "printf 'fixturehash  %s\\n' \"$1\"\n" : '';
    const file = path.join(bin, command);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> "$DEPLOY_TRACE"\n${body}exit 0\n`);
    fs.chmodSync(file, 0o755);
  }
  const result = spawnSync('/bin/bash', [path.join(dir, 'deploy', options.script ?? 'deploy-customer.sh'), ...(options.args ?? [])], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir,
      DEPLOY_TRACE: trace, AIHR_DEPLOY_STATE_DIR: path.join(dir, 'state'),
      ...options.inherited,
    } as unknown as NodeJS.ProcessEnv,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '',
    state: fs.readFileSync(path.join(dir, 'state/current'), 'utf8'),
  };
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function refused(result: ReturnType<typeof runDeploy>, setting: string) {
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('Customer deployment refused');
  expect(result.output).toContain(setting);
  expect(result.trace).not.toMatch(/pnpm|psql|sha256sum|systemctl|check-audit-chain-gate|seed-catalogs|db\/seed/);
  expect(result.state).toContain('result=failed');
  expect(result.state).toContain('phase=preflight');
}

describe('customer deploy refuses unsafe configuration before any install or database work', () => {
  it('refuses unsafe configuration when the native checker is invoked through a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r387-preflight-symlink-'));
    dirs.push(dir);
    const linked = path.join(dir, 'check.mjs');
    fs.symlinkSync(path.join(REPO, 'deploy/check-customer-env.mjs'), linked);
    const result = spawnSync(process.execPath, [linked], {
      cwd: dir, encoding: 'utf8', env: { ...SAFE_ENV, NODE_ENV: 'development' }, timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NODE_ENV must be production');
  });

  it('refuses an obsolete customer Node runtime before installation', () => {
    refused(runDeploy({}, { nodeVersion: '20.20.0' }), 'Node.js 22');
  });
  it.each(['true', 'TRUE', '1'])('refuses ALLOW_DEMO_SESSION=%s even with --customer', (value) => {
    refused(runDeploy({ ALLOW_DEMO_SESSION: value }), 'ALLOW_DEMO_SESSION');
  });
  it.each(['DEV_USER_ID', 'DEV_TENANT_ID'])('refuses a leftover %s', (key) => {
    refused(runDeploy({ [key]: '11111111-1111-1111-1111-111111111111' }), key);
  });
  it.each(['false', 'TRUE', '1'])('refuses WORKOS_API_HTTPS=%s', (value) => {
    refused(runDeploy({ WORKOS_API_HTTPS: value }), 'WORKOS_API_HTTPS');
  });
  it('refuses process-wide disabled certificate verification', () => {
    refused(runDeploy({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), 'NODE_TLS_REJECT_UNAUTHORIZED');
  });
  it.each(['DATABASE_URL', 'MIGRATION_DATABASE_URL'])('requires verified TLS for remote %s', (key) => {
    for (const query of ['', '?sslmode=require', '?sslmode=prefer', '?sslmode=disable',
      '?sslmode=verify-full&sslmode=disable', '?sslmode=verify-full&ssl=false']) {
      refused(runDeploy({ [key]: `postgresql://restricted:fixture@db.internal/preflight${query}` }), 'sslmode=verify-full');
    }
    const result = runDeploy({ DATABASE_URL: 'postgresql://app:fixture@db.internal/preflight?sslmode=verify-full', MIGRATION_DATABASE_URL: 'postgresql://owner:fixture@db.internal/preflight?sslmode=verify-full' });
    expect(result.status, result.output).toBe(0);
  });
  it.each([undefined, 'development', 'test'])('refuses NODE_ENV=%s', (value) => {
    refused(runDeploy({ NODE_ENV: value }), 'NODE_ENV');
  });
  it.each([undefined, '', 'false', 'TRUE', '1'])('refuses AUDIT_HASH_CHAIN_ENABLED=%s', (value) => {
    refused(runDeploy({ AUDIT_HASH_CHAIN_ENABLED: value }), 'AUDIT_HASH_CHAIN_ENABLED');
  });
  it.each(['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_COOKIE_PASSWORD', 'NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'AI_CONFIG_SECRET'])('refuses absent %s', (key) => {
    refused(runDeploy({ [key]: undefined }), key);
  });
  it.each([
    undefined, '', 'not-a-url', 'https://app:secret@db.internal/ai_hr',
    'postgresql://app@db.internal/ai_hr', 'postgresql://app:CHANGE_ME@db.internal/ai_hr',
    'postgresql://app:CHANGE%5FME@db.internal/ai_hr',
    ...['postgres', 'ai_hr_owner', 'ai_hr_platform'].map((role) => `postgresql://${role}:secret@db.internal/ai_hr`),
  ])('refuses unsafe app database configuration without logging credentials', (value) => {
    const result = runDeploy({ DATABASE_URL: value });
    refused(result, 'DATABASE_URL');
    if (value) expect(result.output).not.toContain(value);
  });
  it('refuses migrating a different database from the application', () => {
    refused(runDeploy({ MIGRATION_DATABASE_URL: SAFE_ENV.MIGRATION_DATABASE_URL.replace('/preflight', '/different') }), 'same database endpoint');
  });
  it('refuses the migration role reused by the app on the same database', () => {
    refused(runDeploy({ DATABASE_URL: SAFE_ENV.MIGRATION_DATABASE_URL }), 'separate database roles');
  });
  it.each(['user=postgres', 'database=another_database', 'role=ai_hr_owner', 'options=-c%20role%3Dai_hr_owner'])('refuses PostgreSQL query override %s', (query) => {
    refused(runDeploy({ DATABASE_URL: `${SAFE_ENV.DATABASE_URL}?${query}` }), 'query parameters');
  });
  it.each(['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_COOKIE_PASSWORD', 'SHARE_PASSWORD', 'AI_CONFIG_SECRET'])('refuses placeholder %s without printing the secret', (key) => {
    const value = 'CHANGE_ME_this-is-sensitive-and-must-not-be-logged';
    const result = runDeploy({ [key]: value });
    refused(result, key);
    expect(result.output).not.toContain(value);
  });
  it.each(['', 'x'.repeat(31), ` ${'x'.repeat(32)}`])('refuses short, empty or padded cookie secrets', (value) => {
    refused(runDeploy({ WORKOS_COOKIE_PASSWORD: value }), 'WORKOS_COOKIE_PASSWORD');
  });
  it.each([
    'http://hr.customer.com/callback', 'https://hr.customer.com/',
    'https://hr.customer.com/callback?next=/admin', 'https://hr.customer.com/callback#fragment',
    'https://user:do-not-log-this@hr.customer.com/callback',
    'https://localhost/callback', 'https://127.0.0.1/callback', 'https://[::1]/callback',
    'https://hr.example.com/callback', 'https://your-host/callback', 'not-a-url',
  ])('refuses unsafe callback %s', (value) => {
    const result = runDeploy({ NEXT_PUBLIC_WORKOS_REDIRECT_URI: value });
    refused(result, 'NEXT_PUBLIC_WORKOS_REDIRECT_URI');
    expect(result.output).not.toContain(value);
  });
  it.each(['.env', '.env.local', '.env.production.local'])('refuses unchecked Next configuration in %s', (extraFile) => {
    refused(runDeploy({}, { extraFile }), extraFile);
  });
  it('checks inherited demo variables as well as .env.production', () => {
    refused(runDeploy({}, { inherited: { ALLOW_DEMO_SESSION: 'true' } }), 'ALLOW_DEMO_SESSION');
  });
  it('checks inferred customer mode on a plain deploy.sh invocation', () => {
    refused(runDeploy({ WORKOS_API_KEY: undefined }, { script: 'deploy.sh' }), 'WORKOS_API_KEY');
  });
  it('does not let --migrate-only bypass customer configuration', () => {
    refused(runDeploy({ ALLOW_DEMO_SESSION: 'true' }, { args: ['--migrate-only'] }), 'ALLOW_DEMO_SESSION');
  });
  it('refuses the unedited customer template before any external work', () => {
    refused(runDeploy({}, { template: true }), 'KEYCLOAK_WEB_CLIENT_SECRET');
  });
});

describe('configured customer bootstrap and the guard sensitivity', () => {
  it('validates the service environment without any migration credential or env file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r387-customer-runtime-'));
    dirs.push(dir);
    const { MIGRATION_DATABASE_URL: _, ...runtimeEnv } = SAFE_ENV;
    const result = spawnSync(process.execPath, [path.join(REPO, 'deploy/check-customer-env.mjs')], {
      cwd: dir, encoding: 'utf8', env: runtimeEnv as NodeJS.ProcessEnv,
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it('ignores a masked override file the service user cannot read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r387-masked-runtime-'));
    dirs.push(dir);
    const masked = path.join(dir, '.env.local');
    fs.writeFileSync(masked, 'ALLOW_DEMO_SESSION=true\n', { mode: 0o000 });
    expect(() => fs.accessSync(masked, fs.constants.R_OK)).toThrow();
    const { MIGRATION_DATABASE_URL: _, ...runtimeEnv } = SAFE_ENV;
    const result = spawnSync(process.execPath, [path.join(REPO, 'deploy/check-customer-env.mjs')], {
      cwd: dir, encoding: 'utf8', env: runtimeEnv as NodeJS.ProcessEnv,
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(['deploy.sh', 'deploy-customer.sh'])('allows %s to complete without demo identity or existing tenant', (script) => {
    const result = runDeploy({}, { script });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Customer authentication and audit configuration passed');
    expect(result.trace).toContain('pnpm build');
    expect(result.trace).toContain('pnpm db:migrate');
    expect(result.trace).toContain('systemctl restart aihr');
    expect(result.trace).not.toContain('db/seed.ts');
    expect(result.trace.indexOf('check-customer-env.mjs')).toBeLessThan(result.trace.indexOf('pnpm install'));
  });
  it('allows explicit false and migration bootstrap while leaving the service stopped', () => {
    const result = runDeploy({ ALLOW_DEMO_SESSION: 'false' }, { args: ['--migrate-only'] });
    expect(result.status, result.output).toBe(0);
    expect(result.trace).toContain('pnpm db:migrate');
    expect(result.trace).not.toContain('systemctl restart');
  });
  it('the named refusal disappears if only the guard invocation is removed from a copy', () => {
    const result = runDeploy({ ALLOW_DEMO_SESSION: 'true' }, { removeGuard: true });
    expect(result.status, result.output).toBe(0);
    expect(result.trace).toContain('pnpm build');
    expect(result.trace).toContain('systemctl restart aihr');
    expect(result.output).not.toContain('Customer deployment refused');
  });
});

// Keycloak uses the same shell entry point, before dependency installation or database access.
describe('Keycloak customer deploy entry point', () => {
  const keycloak = {
    AUTH_PROVIDER: 'keycloak', AUTH_PUBLIC_ORIGIN: 'https://hr.customer.com',
    KEYCLOAK_ISSUER: 'https://hr.customer.com/identity/realms/ai-hr',
    KEYCLOAK_WEB_CLIENT_ID: 'aihr-web', KEYCLOAK_WEB_CLIENT_SECRET: 'synthetic-client-secret',
    KEYCLOAK_MOBILE_CLIENT_ID: 'aihr-mobile', KEYCLOAK_API_AUDIENCE: 'aihr-api', AUTH_SESSION_KEY: 'a'.repeat(64),
    WORKOS_API_KEY: undefined, WORKOS_CLIENT_ID: undefined, WORKOS_COOKIE_PASSWORD: undefined,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: undefined, SHARE_PASSWORD: undefined,
  };
  it('deploys without legacy auth configuration or demo seeding', () => {
    const result = runDeploy(keycloak);
    expect(result.status, result.output).toBe(0);
    expect(result.trace).toContain('pnpm db:migrate');
    expect(result.trace).not.toContain('db/seed.ts');
  });
  it('rejects broken Keycloak settings before any install or migration', () => {
    refused(runDeploy({ ...keycloak, AUTH_SESSION_KEY: 'short' }), 'AUTH_SESSION_KEY');
    refused(runDeploy({ ...keycloak, KEYCLOAK_ISSUER: 'http://id.customer.com/realms/hr' }), 'KEYCLOAK_ISSUER');
  });
});
