import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { bootstrapCustomer, readBootstrapConfig, validateBootstrapEnvironment } from '../scripts/bootstrap-customer';
import { closeAll, migrateTestDb, owner, resetDb } from './harness';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';
let directory: string;
let configFile: string;
let activationFile: string;
const input = { name: 'Fresh Customer Sdn Bhd', adminEmail: 'admin@fresh-customer.test',
  baseUrl: 'https://hr.fixture-company.com', country: 'MY', modules: ['payroll'] };

function environment(): NodeJS.ProcessEnv {
  // Local test PG uses trust auth and its URLs omit passwords. Supply a synthetic value so the
  // fixture satisfies the production config contract without adding a bypass to the CLI.
  const completeUrl = (value: string) => {
    const url = new URL(value);
    if (!url.password) url.password = 'synthetic-bootstrap-local-fixture';
    return url.toString();
  };
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', AUDIT_HASH_CHAIN_ENABLED: 'true',
    DATABASE_URL: completeUrl(process.env.TEST_DATABASE_URL!), MIGRATION_DATABASE_URL: completeUrl(process.env.TEST_MIGRATION_DATABASE_URL!),
    WORKOS_API_KEY: 'sk_synthetic_bootstrap_test_key', WORKOS_CLIENT_ID: 'client_synthetic_bootstrap',
    WORKOS_COOKIE_PASSWORD: 'synthetic-bootstrap-cookie-password-at-least-32',
    SHARE_PASSWORD: 'synthetic-bootstrap-share-password', AI_CONFIG_SECRET: 'synthetic-bootstrap-ai-secret',
    WORKOS_API_HTTPS: 'true', NEXT_PUBLIC_WORKOS_REDIRECT_URI: 'https://hr.fixture-company.com/callback' };
  for (const key of ['ALLOW_DEMO_SESSION', 'DEV_TENANT_ID', 'DEV_USER_ID', 'NODE_TLS_REJECT_UNAUTHORIZED']) delete env[key];
  return env;
}
const options = () => ({ configFile, cwd: directory });
const apply = (file = activationFile) => bootstrapCustomer({ ...options(), apply: true, activationFile: file }, environment());
async function count(table: string) {
  const [row] = await owner.db.execute(sql.raw(`select count(*)::int as count from ${table}`));
  return row.count;
}
async function customerCount() {
  const [row] = await owner.db.execute(sql`select count(*)::int as count from tenant where id <> ${SYSTEM_TENANT}::uuid`);
  return row.count;
}
function cli(args: string[], env: Record<string, string | undefined> = environment(), entry = path.join(ROOT, 'scripts/bootstrap-customer.ts')): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', path.join(ROOT, 'node_modules/tsx/dist/loader.mjs'),
      entry, '--config', configFile, ...args], {
      // The private fixture cwd deliberately has no development env file. Point the loader at the
      // real TS aliases explicitly, as running from the documented application cwd does naturally.
      cwd: directory, env: { ...env, TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json') } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (value) => { out += value; });
    child.stderr.on('data', (value) => { out += value; });
    child.on('error', reject);
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => { clearTimeout(watchdog); resolve({ code, out }); });
  });
}

describe('fresh customer bootstrap — one audited customer without a privileged operator login', () => {
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aihr-first-customer-'));
    await fs.chmod(directory, 0o700);
    configFile = path.join(directory, 'config.json');
    activationFile = path.join(directory, 'activation.txt');
    await fs.writeFile(configFile, JSON.stringify(input), { mode: 0o600 });
  });
  afterAll(closeAll);
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('default CLI checks write no tenant, invitation or activation file and exit normally twice', async () => {
    const configured = environment();
    const keys = ['NODE_ENV', 'AUDIT_HASH_CHAIN_ENABLED', 'DATABASE_URL', 'MIGRATION_DATABASE_URL',
      'WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_COOKIE_PASSWORD', 'WORKOS_API_HTTPS',
      'SHARE_PASSWORD', 'AI_CONFIG_SECRET', 'NEXT_PUBLIC_WORKOS_REDIRECT_URI'];
    await fs.writeFile(path.join(directory, '.env.production'),
      keys.map((key) => `${key}=${JSON.stringify(configured[key])}`).join('\n'), { mode: 0o600 });
    for (let i = 0; i < 2; i++) {
      // Credentials exist only in the file; eager db/client imports would fail before it is loaded.
      const result = await cli([], { PATH: process.env.PATH });
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain('CHECK PASSED');
      expect(result.out).not.toContain(input.adminEmail);
    }
    expect(await customerCount()).toBe(0);
    expect(await count('app_invitation')).toBe(0);
    await expect(fs.access(activationFile)).rejects.toThrow();
  });

  it('rejects missing production authentication and an untrusted activation origin before any apply', async () => {
    const linked = path.join(directory, 'bootstrap-customer.ts');
    await fs.symlink(path.join(ROOT, 'scripts/bootstrap-customer.ts'), linked);
    const result = await cli(['--apply', '--activation-file', activationFile], { ...environment(), WORKOS_API_KEY: '' }, linked);
    expect(result.code).toBe(1);
    expect(result.out).toContain('WORKOS_API_KEY');
    expect(result.out).not.toContain(input.adminEmail);
    await fs.writeFile(configFile, JSON.stringify({ ...input, baseUrl: 'https://untrusted.fixture-company.com' }));
    await expect(apply()).rejects.toThrow('callback origin');
    expect(await customerCount()).toBe(0);
    expect(await count('app_invitation')).toBe(0);
    await expect(fs.access(activationFile)).rejects.toThrow();
  });

  it('creates one empty customer, hashes its private invitation and chains every provisioning event', async () => {
    const result = await cli(['--apply', '--activation-file', activationFile]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('CREATED');
    const link = (await fs.readFile(activationFile, 'utf8')).trim();
    const token = link.split('/invite/')[1];
    expect(link).toMatch(/^https:\/\/hr\.fixture-company\.com\/invite\/[\w-]+$/);
    expect(result.out).not.toContain(token);
    expect(result.out).not.toContain(input.adminEmail);
    expect((await fs.stat(activationFile)).mode & 0o777).toBe(0o600);
    expect(await customerCount()).toBe(1);
    expect(await count('company')).toBe(1);
    expect(await count('person')).toBe(1);
    expect(await count('app_user')).toBe(1);
    expect(await count('employment')).toBe(0);
    expect(await count('platform_user')).toBe(0);
    expect(await count('role_assignment')).toBe(0);
    const [invitation] = await owner.db.execute(sql`select token_hash, role, person_id, status from app_invitation`);
    expect(invitation.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(invitation.role).toBe('hr_admin');
    expect(invitation.status).toBe('pending');
    expect(invitation.person_id).toBeTruthy();
    const [audit] = await owner.db.execute(sql`select count(*)::int as total, count(chain_seq)::int as chained from domain_event`);
    expect(Number(audit.total)).toBeGreaterThan(0);
    expect(audit.chained).toBe(audit.total);
    const [setting] = await owner.db.execute(sql`select value, source from tenant_setting where key='audit.hash_chain_enabled'`);
    expect(setting).toMatchObject({ value: true, source: 'platform' });
    const [bound] = await owner.db.execute(sql`select app_user_id from app.consume_invitation(${token}, 'workos_fresh_bootstrap_subject')`);
    expect(bound.app_user_id).toBeTruthy();
    const grants = await owner.db.execute(sql`select role, company_id from role_assignment`);
    expect(grants).toEqual([{ role: 'hr_admin', company_id: null }]);
    const events = await owner.db.execute(sql`select payload from domain_event`);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('refuses repeat apply without changing rows or minting a second activation token', async () => {
    await apply();
    const events = await count('domain_event');
    const initial = await fs.readFile(activationFile, 'utf8');
    const second = path.join(directory, 'second.txt');
    await expect(apply(second)).rejects.toThrow('already contains a customer');
    expect(await customerCount()).toBe(1);
    expect(await count('app_invitation')).toBe(1);
    expect(await count('domain_event')).toBe(events);
    expect(await fs.readFile(activationFile, 'utf8')).toBe(initial);
    await expect(fs.access(second)).rejects.toThrow();
  });

  it('serializes concurrent applies so only one transaction and output succeed', async () => {
    const second = path.join(directory, 'second.txt');
    const results = await Promise.allSettled([apply(), apply(second)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await customerCount()).toBe(1);
    expect(await count('app_invitation')).toBe(1);
    const files = await fs.readdir(directory);
    expect(files.filter((name) => name.endsWith('.txt'))).toHaveLength(1);
  });

  it('refuses existing output/symlinks without modifying either existing file or database', async () => {
    await fs.writeFile(activationFile, 'keep-existing', { mode: 0o600 });
    await expect(apply()).rejects.toThrow('failed before commit');
    const link = path.join(directory, 'link.txt');
    await fs.symlink(activationFile, link);
    await expect(apply(link)).rejects.toThrow('failed before commit');
    expect(await fs.readFile(activationFile, 'utf8')).toBe('keep-existing');
    expect(await customerCount()).toBe(0);
    expect(await count('domain_event')).toBe(0);
  });

  it('rolls back all provisioning rows and deletes its reserved file when token writing fails', async () => {
    const handle = await fs.open(path.join(directory, 'probe'), 'w');
    let attemptedActivation = '';
    let failure: unknown;
    const spy = vi.spyOn(Object.getPrototypeOf(handle), 'writeFile').mockImplementation(async (data: unknown) => {
      attemptedActivation = String(data).trim();
      // Lower-level errors can include values (as SQL errors include params). The CLI boundary must
      // neither preserve a secret-bearing cause nor expose its message after the transaction fails.
      throw new Error('simulated disk full while writing ' + attemptedActivation);
    });
    try { await apply(); } catch (error) { failure = error; }
    finally { spy.mockRestore(); await handle.close(); }
    expect(attemptedActivation).toContain('/invite/');
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('failed before commit');
    expect((failure as Error).message).not.toContain(attemptedActivation);
    expect((failure as Error).cause).toBeUndefined();
    expect(await customerCount()).toBe(0);
    expect(await count('app_invitation')).toBe(0);
    expect(await count('domain_event')).toBe(0);
    await expect(fs.access(activationFile)).rejects.toThrow();
  });

  it('refuses a restricted migration-role impostor before interpreting RLS-filtered zero as fresh', async () => {
    const role = `bootstrap_reader_${randomUUID().replaceAll('-', '')}`;
    const password = 'synthetic-private-test-password';
    await owner.db.execute(sql.raw(`create role "${role}" login password '${password}' nosuperuser nobypassrls`));
    const env = environment();
    const impostor = new URL(env.MIGRATION_DATABASE_URL!);
    impostor.username = role;
    impostor.password = password;
    env.MIGRATION_DATABASE_URL = impostor.toString();
    const connection = postgres(impostor.toString(), { max: 1 });
    try {
      await owner.db.execute(sql.raw(`grant select on tenant to "${role}"`));
      // The database really contains a customer, but the restricted caller sees zero through RLS.
      await owner.db.execute(sql`insert into tenant(workos_org_id,name) values('existing-customer','Existing customer')`);
      const [row] = await connection`select count(*)::int as count from tenant`;
      expect(row.count).toBe(0);
      await expect(bootstrapCustomer({ ...options(), apply: true, activationFile }, env)).rejects.toThrow('role privileges');
      // A custom app-role name is not proof of isolation: table owners bypass their own RLS.
      const ownedTable = `bootstrap_owned_${randomUUID().replaceAll('-', '')}`;
      await owner.db.execute(sql.raw(`create table "${ownedTable}" (id integer)`));
      await owner.db.execute(sql.raw(`alter table "${ownedTable}" owner to "${role}"`));
      await expect(bootstrapCustomer({ ...options(), apply: true, activationFile }, {
        ...environment(), DATABASE_URL: impostor.toString(),
      })).rejects.toThrow('role privileges');
      expect(await customerCount()).toBe(1);
      await expect(fs.access(activationFile)).rejects.toThrow();
    } finally {
      await connection.end({ timeout: 5 });
      await owner.db.execute(sql.raw(`drop owned by "${role}"`));
      await owner.db.execute(sql.raw(`drop role "${role}"`));
    }
  });

  it('refuses unsafe configuration/environment before opening or mutating a customer', async () => {
    for (const overrides of [{ modules: ['not-a-module'] }, { modules: ['multi_cycle_payroll'] }, { country: 'XX' },
      { baseUrl: 'http://customer.test' }, { baseUrl: 'https://user:password@customer.test' }]) {
      await fs.writeFile(configFile, JSON.stringify({ ...input, ...overrides }));
      await expect(readBootstrapConfig(configFile)).rejects.toThrow();
    }
    await fs.writeFile(configFile, JSON.stringify(input));
    await fs.chmod(configFile, 0o644);
    await expect(readBootstrapConfig(configFile)).rejects.toThrow('private regular file');
    for (const patch of [{ NODE_ENV: 'development' }, { AUDIT_HASH_CHAIN_ENABLED: 'false' },
      { ALLOW_DEMO_SESSION: 'true' }, { DATABASE_URL: environment().MIGRATION_DATABASE_URL },
      { DATABASE_URL: environment().DATABASE_URL + '?user=postgres' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      { WORKOS_API_KEY: '' }, { WORKOS_CLIENT_ID: '' }, { WORKOS_COOKIE_PASSWORD: 'short' },
      { SHARE_PASSWORD: 'short' }, { AI_CONFIG_SECRET: 'CHANGE_ME' }, { WORKOS_API_HTTPS: 'false' },
      { NEXT_PUBLIC_WORKOS_REDIRECT_URI: '' }, { NEXT_PUBLIC_WORKOS_REDIRECT_URI: 'http://hr.fixture-company.com/callback' },
      { NEXT_PUBLIC_WORKOS_REDIRECT_URI: 'https://customer.test/callback' }]) {
      // Deliberately malformed process input; Next narrows NODE_ENV on ProcessEnv at type level.
      await expect(validateBootstrapEnvironment({ ...environment(), ...patch } as NodeJS.ProcessEnv, directory)).rejects.toThrow();
    }
    expect(await customerCount()).toBe(0);
    expect(await count('domain_event')).toBe(0);
  });

  it('refuses app roles that own the database or an application schema without owning tables', async () => {
    const role = `bootstrap_scope_${randomUUID().replaceAll('-', '')}`;
    const [original] = await owner.db.execute(sql`select current_database() as database,
      pg_get_userbyid(d.datdba) as db_owner, pg_get_userbyid(n.nspowner) as schema_owner
      from pg_database d cross join pg_namespace n where d.datname=current_database() and n.nspname='public'`);
    await owner.db.execute(sql.raw(`create role "${role}" login password 'synthetic-scope-fixture' nosuperuser nobypassrls`));
    const env = environment();
    const app = new URL(env.DATABASE_URL!);
    app.username = role;
    app.password = 'synthetic-scope-fixture';
    env.DATABASE_URL = app.toString();
    try {
      await owner.db.execute(sql`alter schema public owner to ${sql.identifier(role)}`);
      await expect(bootstrapCustomer({ ...options(), apply: true, activationFile }, env)).rejects.toThrow('role privileges');
      // Use the explicit migration owner for the schema, so the implicit pg_database_owner role
      // cannot make the next assertion pass on schema ownership instead of database ownership.
      await owner.db.execute(sql`alter schema public owner to ${sql.identifier(String(original.db_owner))}`);
      await owner.db.execute(sql`alter database ${sql.identifier(String(original.database))} owner to ${sql.identifier(role)}`);
      await expect(bootstrapCustomer({ ...options(), apply: true, activationFile }, env)).rejects.toThrow('role privileges');
      expect(await customerCount()).toBe(0);
      await expect(fs.access(activationFile)).rejects.toThrow();
    } finally {
      await owner.db.execute(sql`alter database ${sql.identifier(String(original.database))} owner to ${sql.identifier(String(original.db_owner))}`);
      await owner.db.execute(sql`alter schema public owner to ${sql.identifier(String(original.schema_owner))}`);
      await owner.db.execute(sql.raw(`drop owned by "${role}"`));
      await owner.db.execute(sql.raw(`drop role "${role}"`));
    }
  });
});
