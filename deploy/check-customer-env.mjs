#!/usr/bin/env node
// No dependencies or database access: deploy.sh runs this before its first install. This validates
// configuration, not provider credentials, a registered callback, or a successful first login.
import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared by deployment, systemd runtime startup and fresh-customer bootstrap. No I/O beyond env-file access checks. */
export function customerEnvironmentErrors(env = process.env, cwd = process.cwd()) {
  const errors = [];
  const placeholder = /change[-_ ]?me|replace[-_ ]?me|your[-_ ]|<|>|\.\.\./i;

  if (Number(process.versions.node.split('.')[0]) < 22) {
    errors.push('Customer deployments require Node.js 22 or newer; install the customer toolchain in /opt/node22/bin.');
  }

  function required(name, minLength = 1) {
    const value = env[name] ?? '';
    if (value.trim().length < minLength || value !== value.trim() || placeholder.test(value)) {
      errors.push(`${name} must contain a real value${minLength > 1 ? ` of at least ${minLength} characters` : ''}, with no surrounding whitespace or template placeholder.`);
      return false;
    }
    return true;
  }

  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV must be production; other values enable development identity resolution.');
  if (env.ALLOW_DEMO_SESSION && env.ALLOW_DEMO_SESSION !== 'false') {
    errors.push('ALLOW_DEMO_SESSION must be absent or false; --customer does not disable the runtime identity switcher.');
  }
  for (const name of ['DEV_TENANT_ID', 'DEV_USER_ID']) {
    if (env[name]) errors.push(`${name} must be absent from a customer deployment.`);
  }
  if (env.AUDIT_HASH_CHAIN_ENABLED !== 'true') {
    errors.push('AUDIT_HASH_CHAIN_ENABLED must be true before the first customer record is written.');
  }

  required('WORKOS_API_KEY');
  required('WORKOS_CLIENT_ID');
  // AuthKit treats every nonempty value other than the exact string 'true' as plain HTTP.
  if (env.WORKOS_API_HTTPS && env.WORKOS_API_HTTPS !== 'true') {
    errors.push('WORKOS_API_HTTPS must be absent or true; sending identity credentials over HTTP is refused.');
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    errors.push('NODE_TLS_REJECT_UNAUTHORIZED must not disable certificate verification.');
  }
  required('WORKOS_COOKIE_PASSWORD', 32);
  required('SHARE_PASSWORD', 16);
  required('AI_CONFIG_SECRET', 16);

  function databaseUrl(name) {
    if (!required(name)) return;
    try {
      const url = new URL(env[name]);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
        !url.username || !url.password || url.pathname.length <= 1 || url.hash ||
        placeholder.test(decodeURIComponent(url.href))) throw new Error('Invalid database configuration');
      // postgres.js merges query parameters into its startup message after the URL's user/database.
      // Checking only URL.username would accept ?user=postgres as an app-role connection.
      if (['user', 'username', 'password', 'pass', 'database', 'dbname', 'host', 'hostname', 'port', 'role', 'options']
        .some((key) => url.searchParams.has(key))) {
        errors.push(`${name} must not override identity or connection details in query parameters.`);
        return;
      }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
      if (!loopback && (url.searchParams.getAll('sslmode').length !== 1 ||
        url.searchParams.get('sslmode') !== 'verify-full' || url.searchParams.has('ssl'))) {
        errors.push(`${name} must use sslmode=verify-full for a remote database; use a trusted certificate and its private DNS name.`);
        return;
      }
      return url;
    } catch {
      errors.push(`${name} must be a PostgreSQL URL with a host, database, username and non-placeholder password.`);
    }
  }
  const appDb = databaseUrl('DATABASE_URL');
  if (appDb && ['ai_hr_owner', 'ai_hr_platform', 'postgres'].includes(decodeURIComponent(appDb.username).toLowerCase())) {
    errors.push('DATABASE_URL must use the non-privileged app role, never postgres, ai_hr_owner or ai_hr_platform.');
  }
  // Runtime deliberately has no migration credential. deploy.sh requires one separately before calling
  // this checker, while the service reuses it with only its restricted runtime environment.
  const migrationDb = env.MIGRATION_DATABASE_URL ? databaseUrl('MIGRATION_DATABASE_URL') : undefined;
  if (appDb && migrationDb && appDb.hostname === migrationDb.hostname &&
    (appDb.port || '5432') === (migrationDb.port || '5432') && appDb.pathname === migrationDb.pathname &&
    decodeURIComponent(appDb.username) === decodeURIComponent(migrationDb.username)) {
    errors.push('DATABASE_URL and MIGRATION_DATABASE_URL must use separate database roles.');
  }

  if (required('NEXT_PUBLIC_WORKOS_REDIRECT_URI')) {
    let valid = false;
    try {
      const uri = new URL(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI);
      const host = uri.hostname.toLowerCase();
      const reserved = host === 'localhost' || host === '[::1]' || host === '[::]' ||
        /^127\./.test(host) || host === '0.0.0.0' ||
        /(^|\.)(example\.(com|net|org)|invalid|test|localhost|example)$/.test(host);
      valid = uri.protocol === 'https:' && !uri.username && !uri.password && !reserved &&
        uri.pathname === '/callback' && !uri.search && !uri.hash;
    } catch {
      // Report the setting name, never its value (a mistaken URL can contain credentials).
    }
    if (!valid) errors.push('NEXT_PUBLIC_WORKOS_REDIRECT_URI must be an HTTPS URL on the customer host ending in /callback, without credentials, query, fragment, loopback or example hosts. Register the identical URI in WorkOS.');
  }

  // Next also reads these files. A leftover development file could restore a demo flag that is absent
  // from the checked .env.production after the deploy process exits. Keep one production env source.
  for (const file of ['.env', '.env.local', '.env.production.local']) {
    try {
      accessSync(path.join(cwd, file), constants.R_OK);
      errors.push(`Remove ${file} from the customer release directory; it can supply unchecked runtime settings. Use .env.production for this deployment.`);
    } catch (error) {
      // The hardened service masks these files with InaccessiblePaths. If its app user cannot read
      // them, neither can Next; the inherited service environment remains the only effective source.
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }

  return errors;
}

// Node canonicalizes the ESM entry URL. Canonicalize argv too, or a symlinked release silently
// skips preflight and returns success without checking any configuration.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const errors = customerEnvironmentErrors();
  if (errors.length) {
    console.error('✗ Customer deployment refused before install, build or migrations:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('✓ Customer authentication and audit configuration passed (provider login still requires verification).');
}
