import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { customerEnvironmentErrors } from '../deploy/check-customer-env.mjs';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aihr-keycloak-preflight-'));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const safe = {
  NODE_ENV: 'production', AUTH_PROVIDER: 'keycloak', AUDIT_HASH_CHAIN_ENABLED: 'true',
  DATABASE_URL: 'postgresql://app:fixture@db.customer.internal/ai_hr?sslmode=verify-full',
  MIGRATION_DATABASE_URL: 'postgresql://owner:fixture@db.customer.internal/ai_hr?sslmode=verify-full',
  AI_CONFIG_SECRET: 'synthetic-encryption-key-for-test', AUTH_SESSION_KEY: 'a'.repeat(64),
  AUTH_PUBLIC_ORIGIN: 'https://hr.customer.internal',
  KEYCLOAK_ISSUER: 'https://id.customer.internal/identity/realms/ai-hr',
  KEYCLOAK_WEB_CLIENT_ID: 'aihr-web', KEYCLOAK_WEB_CLIENT_SECRET: 'synthetic-client-secret',
  KEYCLOAK_MOBILE_CLIENT_ID: 'aihr-mobile', KEYCLOAK_API_AUDIENCE: 'aihr-api',
};
const errors = (changes = {}) => customerEnvironmentErrors({ ...safe, ...changes }, cwd);
test('Keycloak customer passes with no WorkOS or Basic-auth configuration', () => {
  assert.deepEqual(errors(), []);
  assert.deepEqual(errors({ MIGRATION_DATABASE_URL: undefined }), []);
  assert.deepEqual(errors({ KEYCLOAK_BACKCHANNEL_ORIGIN: 'http://127.0.0.1:8080' }), []);
});
test('refuses missing provider, identity settings and invalid session keys without printing values', () => {
  for (const name of ['AUTH_PROVIDER', 'AUTH_PUBLIC_ORIGIN', 'KEYCLOAK_ISSUER', 'KEYCLOAK_WEB_CLIENT_ID', 'KEYCLOAK_WEB_CLIENT_SECRET', 'KEYCLOAK_MOBILE_CLIENT_ID', 'KEYCLOAK_API_AUDIENCE', 'AUTH_SESSION_KEY']) {
    assert.ok(errors({ [name]: undefined }).some(e => e.includes(name)), name);
  }
  for (const key of ['short', 'g'.repeat(64), 'a'.repeat(63), 'REPLACE_WITH_SECRET']) {
    const out = errors({ AUTH_SESSION_KEY: key }).join(' ');
    assert.match(out, /AUTH_SESSION_KEY/);
    assert.ok(!out.includes(key));
  }
});
test('refuses unsafe issuer, origin and network backchannel', () => {
  for (const value of ['http://id.customer.internal/realms/hr', 'https://localhost/realms/hr', 'https://id.customer.internal/realms/hr/', 'https://id.customer.internal/realms/hr?token=private', 'https://user:private@id.customer.internal/realms/hr']) {
    assert.ok(errors({ KEYCLOAK_ISSUER: value }).some(e => e.includes('KEYCLOAK_ISSUER')));
  }
  for (const value of ['http://hr.customer.internal', 'https://hr.customer.internal/path', 'https://hr.example.com']) {
    assert.ok(errors({ AUTH_PUBLIC_ORIGIN: value }).some(e => e.includes('AUTH_PUBLIC_ORIGIN')));
  }
  for (const value of ['http://10.0.0.4:8080', 'https://127.0.0.1:8080', 'http://127.0.0.1:8080/path']) {
    assert.ok(errors({ KEYCLOAK_BACKCHANNEL_ORIGIN: value }).some(e => e.includes('BACKCHANNEL')));
  }
});
test('refuses demo identity, unarmed audit, insecure DB and mixed-case role overrides', () => {
  for (const changes of [{ ALLOW_DEMO_SESSION: 'true' }, { DEV_USER_ID: 'demo' }, { AUDIT_HASH_CHAIN_ENABLED: 'false' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { AUTH_PROVIDER: 'custom' }, { DATABASE_URL: safe.DATABASE_URL + '&UsEr=postgres' }, { DATABASE_URL: safe.DATABASE_URL.replace('verify-full', 'require') }, { DATABASE_URL: safe.DATABASE_URL + '&SSL=disable' }, { MIGRATION_DATABASE_URL: safe.MIGRATION_DATABASE_URL.replace('db.customer.internal', 'different.internal') }]) {
    assert.ok(errors(changes).length > 0, JSON.stringify(Object.keys(changes)));
  }
});
