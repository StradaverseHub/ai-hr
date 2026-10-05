/** Fresh installation only. Read/check by default; --apply writes one tenant and a private activation file.
 * DB modules are dynamically imported only AFTER configuration and production credentials pass.
 */
import { constants } from 'node:fs';
import { access, lstat, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ALL_MODULE_CODES, CORE_MODULE_CODES, missingModuleDependencies } from '../packs/catalog';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';
const configuration = z.object({
  name: z.string().trim().min(1).max(200).refine((v) => !/[\x00-\x1f\x7f]/.test(v)),
  adminEmail: z.string().trim().toLowerCase().email().max(254),
  baseUrl: z.string().url(),
  country: z.literal('MY'),
  modules: z.array(z.string()).max(ALL_MODULE_CODES.length),
}).strict();

class BootstrapRefusal extends Error {}
function refuse(message: string): never { throw new BootstrapRefusal(message); }

export async function readBootstrapConfig(filename: string) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 65536) {
      refuse('Config must be a private regular file owned by the invoking account, at most 64 KiB.');
    }
    const parsed = configuration.safeParse(JSON.parse(await handle.readFile('utf8')));
    if (!parsed.success) refuse('Config is invalid; check name, adminEmail, HTTPS baseUrl, country MY and modules.');
    const value = parsed.data;
    const base = new URL(value.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      refuse('baseUrl must be an HTTPS origin without credentials, query, fragment or a path.');
    }
    if (new Set(value.modules).size !== value.modules.length ||
        value.modules.some((code) => !ALL_MODULE_CODES.includes(code) || CORE_MODULE_CODES.includes(code)) ||
        missingModuleDependencies(value.modules).length) {
      refuse('Modules must be unique known non-core codes with all required dependencies.');
    }
    return { ...value, baseUrl: base.origin };
  } finally { await handle.close(); }
}

export async function validateBootstrapEnvironment(env: NodeJS.ProcessEnv, cwd = process.cwd()) {
  if (Number(process.versions.node.split('.')[0]) < 22) refuse('Customer bootstrap requires Node.js 22 or newer.');
  const placeholder = /change[-_ ]?me|replace[-_ ]?me|replace[-_ ]?with|your[-_ ]|<|>|\.\.\./i;
  const required = (name: string, minimum = 1) => {
    const value = env[name] ?? '';
    if (value !== value.trim() || value.length < minimum || placeholder.test(value)) {
      refuse(`${name} must contain a complete non-placeholder production value.`);
    }
    return value;
  };
  if (env.NODE_ENV !== 'production' || env.AUDIT_HASH_CHAIN_ENABLED !== 'true') {
    refuse('Bootstrap requires NODE_ENV=production and AUDIT_HASH_CHAIN_ENABLED=true.');
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') refuse('TLS certificate verification cannot be disabled.');
  for (const key of ['ALLOW_DEMO_SESSION', 'DEV_TENANT_ID', 'DEV_USER_ID']) {
    if (Object.hasOwn(env, key)) refuse('Demo configuration is forbidden for customer bootstrap.');
  }
  required('WORKOS_API_KEY');
  required('WORKOS_CLIENT_ID');
  required('WORKOS_COOKIE_PASSWORD', 32);
  required('SHARE_PASSWORD', 16);
  required('AI_CONFIG_SECRET', 16);
  if (env.WORKOS_API_HTTPS && env.WORKOS_API_HTTPS !== 'true') refuse('WorkOS credentials require HTTPS.');
  let callback: URL;
  try { callback = new URL(required('NEXT_PUBLIC_WORKOS_REDIRECT_URI')); }
  catch { return refuse('A configured HTTPS customer WorkOS callback is required.'); }
  const host = callback.hostname.toLowerCase();
  const reserved = ['localhost', '[::1]', '[::]', '0.0.0.0'].includes(host) || /^127\./.test(host) ||
    /(^|\.)(example\.(com|net|org)|invalid|test|localhost|example)$/.test(host);
  if (callback.protocol !== 'https:' || callback.username || callback.password || reserved ||
      callback.pathname !== '/callback' || callback.search || callback.hash) {
    refuse('WorkOS callback must be a real customer HTTPS origin ending in /callback.');
  }
  for (const name of ['.env', '.env.local', '.env.production.local']) {
    try { await access(path.join(cwd, name), constants.R_OK); }
    catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    refuse('Remove readable Next environment override files before customer bootstrap.');
  }
  let app: URL; let owner: URL;
  try { app = new URL(required('DATABASE_URL')); owner = new URL(required('MIGRATION_DATABASE_URL')); }
  catch { return refuse('Separate valid app and migration database URLs are required.'); }
  for (const url of [app, owner]) {
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password ||
        !url.hostname || url.pathname.length <= 1 || url.hash || placeholder.test(decodeURIComponent(url.toString()))) {
      refuse('Separate complete app and migration database credentials are required.');
    }
    const overrideKeys = ['user', 'username', 'password', 'pass', 'role', 'host', 'hostname', 'port', 'database', 'dbname', 'options', 'ssl'];
    if ([...url.searchParams.keys()].some((key) => overrideKeys.includes(key.toLowerCase()))) {
      refuse('Database URLs must not carry connection identity or TLS overrides in query parameters.');
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        (url.searchParams.getAll('sslmode').length !== 1 || url.searchParams.get('sslmode') !== 'verify-full')) {
      refuse('Remote database connections require sslmode=verify-full and trusted CA configuration.');
    }
  }
  const appRole = decodeURIComponent(app.username);
  const ownerRole = decodeURIComponent(owner.username);
  if (appRole === ownerRole || ['postgres', 'ai_hr_owner', 'ai_hr_platform'].includes(appRole.toLowerCase()) ||
      app.hostname !== owner.hostname || (app.port || '5432') !== (owner.port || '5432') || app.pathname !== owner.pathname) {
    refuse('App and migration URLs must identify the same database using distinct nonprivileged-app and owner roles.');
  }
  return { appRole, ownerRole, ownerUrl: owner.toString(), callbackOrigin: callback.origin };
}

export type BootstrapOptions = { configFile: string; apply?: boolean; activationFile?: string; cwd?: string };

export async function bootstrapCustomer(options: BootstrapOptions, env: NodeJS.ProcessEnv = process.env) {
  const input = await readBootstrapConfig(options.configFile);
  const credentials = await validateBootstrapEnvironment(env, options.cwd);
  if (credentials.callbackOrigin !== input.baseUrl) {
    refuse('baseUrl must match the configured WorkOS callback origin.');
  }
  if (options.apply && !options.activationFile) refuse('--apply requires a new --activation-file in a private directory.');
  if (!options.apply && options.activationFile) refuse('--activation-file is used only with --apply.');

  // All imports that can reach db/client's app singleton happen after validation. The owner URL is
  // never substituted for DATABASE_URL, and all provisioning uses the explicit owner transaction.
  const [{ default: postgres }, { drizzle }, { sql }, schema, { provisionTenant }] = await Promise.all([
    import('postgres'), import('drizzle-orm/postgres-js'), import('drizzle-orm'),
    import('../db/schema'), import('../db/provision'),
  ]);
  const client = postgres(credentials.ownerUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let outputIdentity: { dev: number; ino: number } | undefined;
  let commitAttempted = false;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ai-hr:fresh-customer-bootstrap')::bigint)`);
      const [roles] = await tx.execute(sql`
        select exists(select 1 from pg_roles r join pg_class c on c.oid = 'public.tenant'::regclass
          where r.rolname = current_user and current_user = ${credentials.ownerRole}
          and (r.rolsuper or r.rolbypassrls or (c.relowner = r.oid and not c.relforcerowsecurity))) as correct_owner,
          exists(select 1 from pg_roles r where r.rolname = ${credentials.appRole}
            and not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole and not r.rolcreatedb
            and not exists(select 1 from pg_roles privileged where
              (privileged.rolsuper or privileged.rolbypassrls or privileged.rolcreaterole or privileged.rolcreatedb
               or privileged.rolname in ('pg_read_all_data','pg_write_all_data','pg_execute_server_program','pg_read_server_files','pg_write_server_files')
               or privileged.oid in (select c.relowner from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname in ('public','app') and c.relkind in ('r','p','S','v','m','f')))
              and pg_has_role(r.oid, privileged.oid, 'MEMBER'))) as safe_app
      `);
      if (!roles?.correct_owner || !roles?.safe_app) refuse('Database role privileges do not satisfy owner/app separation.');
      // Only inspect tenant rows after proving the caller sees past RLS; filtered zero is not empty.
      // Also serialize against provisioning paths that do not participate in this CLI's lock.
      await tx.execute(sql`lock table tenant in share row exclusive mode`);
      const existing = await tx.execute(sql`select id from tenant where id <> ${SYSTEM_TENANT}::uuid limit 1`);
      if (existing.length) refuse('Installation already contains a customer; bootstrap refuses without changing it.');
      if (!options.apply) return { status: 'checked' as const };

      const destination = path.resolve(options.activationFile!);
      const parent = await stat(path.dirname(destination));
      if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
        refuse('Activation output directory must be owned by the invoking account with mode 0700.');
      }
      output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      outputIdentity = await output.stat();
      await tx.execute(sql`select set_config('app.audit_hash_chain', 'on', true)`);
      const result = await provisionTenant(tx, input);
      await tx.insert(schema.tenantSetting).values({
        tenantId: result.tenantId, key: 'audit.hash_chain_enabled', value: true, source: 'platform',
      }).onConflictDoUpdate({ target: [schema.tenantSetting.tenantId, schema.tenantSetting.key], set: { value: true, source: 'platform' } });
      await output.writeFile(result.activationUrl + '\n', 'utf8');
      await output.sync();
      await output.close();
      output = undefined;
      const directory = await open(path.dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
      // No database/filesystem two-phase commit exists here. Preserve output on ambiguous COMMIT
      // failure; a retry refuses both existing customers and existing output files.
      commitAttempted = true;
      return { status: 'created' as const, tenantId: result.tenantId, appUserId: result.appUserId };
    });
  } catch (error) {
    if (output) await output.close().catch(() => {});
    if (outputIdentity && !commitAttempted) {
      try {
        const current = await lstat(path.resolve(options.activationFile!));
        if (current.dev === outputIdentity.dev && current.ino === outputIdentity.ino) await unlink(path.resolve(options.activationFile!));
      } catch { /* A partial output may need manual recovery; never remove somebody else's file. */ }
    }
    if (commitAttempted) refuse('Commit outcome is uncertain. Keep the private activation file and inspect database state before retrying.');
    if (error instanceof BootstrapRefusal) throw error;
    refuse('Bootstrap failed before commit; inspect configuration, migrations and the private output location. No activation URL was printed.');
  } finally { await client.end({ timeout: 5 }); }
}

async function main() {
  const args = process.argv.slice(2);
  const options: BootstrapOptions = { configFile: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !options.apply) options.apply = true;
    else if (args[i] === '--config' && !options.configFile && args[i + 1] && !args[i + 1].startsWith('--')) options.configFile = args[++i];
    else if (args[i] === '--activation-file' && !options.activationFile && args[i + 1] && !args[i + 1].startsWith('--')) options.activationFile = args[++i];
    else refuse('Usage: bootstrap-customer.ts --config PRIVATE_JSON [--apply --activation-file NEW_PRIVATE_FILE]');
  }
  if (!options.configFile) refuse('--config is required; no customer information belongs in command arguments.');
  try { process.loadEnvFile('.env.production'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refuse('Could not load production environment configuration.'); }
  const result = await bootstrapCustomer(options);
  console.log(result.status === 'checked'
    ? 'CHECK PASSED: fresh installation and configuration verified; no customer or activation file created.'
    : 'CREATED: customer and pending administrator invitation committed; activation URL is only in the requested private file.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), (error: unknown) => {
    console.error(error instanceof BootstrapRefusal ? error.message : 'Bootstrap refused; check private configuration and production environment. No secret details were printed.');
    process.exit(1);
  });
}
