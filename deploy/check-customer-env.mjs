#!/usr/bin/env node
// No dependencies or database access: deploy.sh runs this before its first install. This validates
// configuration, not provider credentials, a registered callback, or a successful first login.
import { existsSync } from 'node:fs';

const errors = [];
const env = process.env;
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
required('WORKOS_COOKIE_PASSWORD', 32);
required('SHARE_PASSWORD', 16);
required('AI_CONFIG_SECRET', 16);

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
  if (existsSync(file)) errors.push(`Remove ${file} from the customer release directory; it can supply unchecked runtime settings. Use .env.production for this deployment.`);
}

if (errors.length) {
  console.error('✗ Customer deployment refused before install, build or migrations:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('✓ Customer authentication and audit configuration passed (provider login still requires verification).');
