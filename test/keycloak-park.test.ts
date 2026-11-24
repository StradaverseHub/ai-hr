import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * deploy/keycloak/park.sh stops the dormant Keycloak and identity-email agent on an embedded-login
 * installation (staging memory pressure, 24 Nov 2026). These run the REAL script against a fake systemctl
 * that records every call and keeps unit state in files, and assert what it would do to the units.
 */
const PARK = resolve(__dirname, '../deploy/keycloak/park.sh');
const KC = 'aihr-keycloak.service', MAIL = 'aihr-identity-email.service', SOCK = 'aihr-identity-email.socket', WEB = 'aihr.service';
let dir: string;

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls"
unit="\${@: -1}"
case "$1" in
  show) cat "$FAKE_DIR/$unit.$3" 2>/dev/null || true ;;
  is-enabled) cat "$FAKE_DIR/$2.enabled" 2>/dev/null || echo enabled ;;
  stop) cat "$FAKE_DIR/$unit.stopState" 2>/dev/null > "$FAKE_DIR/$unit.ActiveState" || echo inactive > "$FAKE_DIR/$unit.ActiveState" ;;
  disable) echo disabled > "$FAKE_DIR/$unit.enabled"
    if [ "$2" = --now ]; then cat "$FAKE_DIR/$unit.stopState" 2>/dev/null > "$FAKE_DIR/$unit.ActiveState" || echo inactive > "$FAKE_DIR/$unit.ActiveState"; fi; true ;;
  reset-failed) grep -qx failed "$FAKE_DIR/$unit.ActiveState" && echo inactive > "$FAKE_DIR/$unit.ActiveState"; true ;;
  enable) echo enabled > "$FAKE_DIR/$unit.enabled"; [ "$2" = --now ] && echo active > "$FAKE_DIR/$unit.ActiveState"; true ;;
  *) exit 2 ;;
esac
`;

const set = (unit: string, prop: string, value: string) => writeFileSync(join(dir, `${unit}.${prop}`), value + '\n');
const get = (unit: string, prop: string) => readFileSync(join(dir, `${unit}.${prop}`), 'utf8').trim();
const env = (text: string) => writeFileSync(join(dir, 'app.env'), text);
const calls = () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []);
const mutating = () => calls().filter(c => !/^(show|is-enabled) /.test(c));
const run = (mode?: string) => {
  const result = spawnSync('bash', [PARK, ...(mode ? [mode] : [])], {
    encoding: 'utf8',
    env: { NODE_ENV: 'test', PATH: `${dir}:/usr/bin:/bin`, FAKE_DIR: dir, AIHR_APP_ENV_FILE: join(dir, 'app.env') },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kc-park-'));
  writeFileSync(join(dir, 'systemctl'), FAKE_SYSTEMCTL);
  chmodSync(join(dir, 'systemctl'), 0o755);
  // The staging shape observed on 24 Nov 2026.
  env('PORT=3000\nAUTH_PROVIDER=internal\nAIHR_DB_POOL_MAX=10\n');
  for (const unit of [KC, MAIL, SOCK, WEB]) set(unit, 'ActiveState', 'active');
  set(KC, 'RequiredBy', MAIL); set(KC, 'BoundBy', ''); set(KC, 'RequisiteOf', '');
  set(SOCK, 'NConnections', '0'); set(SOCK, 'NAccepted', '0');
  set(KC, 'MemoryCurrent', '232275968'); set(KC, 'MemorySwapCurrent', '386617344');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('deploy/keycloak/park.sh', () => {
  it('status is read-only and reports the memory evidence', () => {
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain('AUTH_PROVIDER=internal');
    expect(out).toMatch(/aihr-keycloak\.service\s+active\s+enabled=enabled\s+memory=232275968 swap=386617344/);
    expect(calls().length).toBeGreaterThan(0);
    expect(mutating()).toEqual([]);
  });

  it.each([
    ['Keycloak is the selected provider', 'AUTH_PROVIDER=keycloak\n', /not internal/],
    ['a quoted Keycloak selection', 'AUTH_PROVIDER="keycloak"\n', /not internal/],
    ['no provider is set', 'PORT=3000\n', /found 0/],
    ['two provider assignments', 'AUTH_PROVIDER=internal\nAUTH_PROVIDER=keycloak\n', /found 2/],
    ['the app still carries Keycloak settings', 'AUTH_PROVIDER=internal\nKEYCLOAK_ISSUER=https://id.example.test/identity/realms/ai-hr\n', /KEYCLOAK_/],
  ])('park refuses, changing nothing, when %s', (_label, text, message) => {
    env(text);
    const { code, err } = run('park');
    expect(code).not.toBe(0);
    expect(err).toMatch(message);
    expect(mutating()).toEqual([]);
    expect(get(KC, 'ActiveState')).toBe('active');
  });

  it('accepts a quoted internal selection and an empty leftover KEYCLOAK_ key', () => {
    env('export AUTH_PROVIDER="internal"\nKEYCLOAK_EMAIL_ENABLED=\n');
    expect(run().code).toBe(0);
  });

  it('refuses when another unit requires Keycloak', () => {
    set(KC, 'RequiredBy', `${MAIL} aihr-something-else.service`);
    const { code, err } = run('park');
    expect(code).not.toBe(0);
    expect(err).toContain('aihr-something-else.service depends on aihr-keycloak.service');
    expect(mutating()).toEqual([]);
  });

  it('refuses while the email socket has an open connection', () => {
    set(SOCK, 'NConnections', '1');
    const { code, err } = run('park');
    expect(code).not.toBe(0);
    expect(err).toContain('open connection');
    expect(mutating()).toEqual([]);
  });

  it('refuses when the web service is not running', () => {
    set(WEB, 'ActiveState', 'failed');
    const { code, err } = run('park');
    expect(code).not.toBe(0);
    expect(err).toContain('aihr.service is not active');
    expect(mutating()).toEqual([]);
  });

  it('parks the email agent before Keycloak, leaves the web service alone, and unpark reverses it', () => {
    const parked = run('park');
    expect(parked.code).toBe(0);
    expect(mutating()).toEqual([`disable --now ${SOCK}`, `stop ${MAIL}`, `disable --now ${KC}`]);
    for (const unit of [KC, MAIL, SOCK]) expect(get(unit, 'ActiveState')).toBe('inactive');
    expect(get(KC, 'enabled')).toBe('disabled');
    expect(get(WEB, 'ActiveState')).toBe('active');
    expect(calls().some(c => / aihr\.service$/.test(c) && !c.startsWith('show '))).toBe(false);
    expect(parked.out).toContain('Preserved:');

    writeFileSync(join(dir, 'calls'), '');
    const unparked = run('unpark');
    expect(unparked.code).toBe(0);
    expect(mutating().filter(Boolean)).toEqual([`enable --now ${KC}`, `enable --now ${SOCK}`]);
    expect(get(KC, 'ActiveState')).toBe('active');
    expect(get(SOCK, 'ActiveState')).toBe('active');
  });

  // Staging, 24 Nov 2026: the JVM exits 143 on SIGTERM and the unit has no SuccessExitStatus=143, so a clean
  // stop leaves aihr-keycloak.service "failed". The first real park printed ✗ here and was then unparked.
  it('accepts the JVM SIGTERM exit 143 as a clean stop and clears the failed mark', () => {
    set(KC, 'stopState', 'failed'); set(KC, 'Result', 'exit-code'); set(KC, 'ExecMainStatus', '143');
    const parked = run('park');
    expect(parked.err).toBe('');
    expect(parked.code).toBe(0);
    expect(mutating()).toEqual([`disable --now ${SOCK}`, `stop ${MAIL}`, `disable --now ${KC}`, `reset-failed ${KC}`]);
    expect(get(KC, 'ActiveState')).toBe('inactive');
    expect(parked.out).toContain('normal SIGTERM exit 143');
    expect(parked.out).toContain('✓ parked.');
  });

  it('reports any other failed stop without clearing it, and warns that units already changed', () => {
    set(KC, 'stopState', 'failed'); set(KC, 'Result', 'exit-code'); set(KC, 'ExecMainStatus', '1');
    const { code, out, err } = run('park');
    expect(code).not.toBe(0);
    expect(err).toContain('exit status=1');
    expect(err).toContain('Do not run unpark unless you mean to roll back');
    expect(err).toMatch(/aihr-keycloak\.service\s+failed/);
    expect(mutating()).toEqual([`disable --now ${SOCK}`, `stop ${MAIL}`, `disable --now ${KC}`]);
    expect(get(KC, 'ActiveState')).toBe('failed');
    expect(out).not.toContain('✓ parked.');
  });

  it('a refusal before any change does not claim units changed', () => {
    env('AUTH_PROVIDER=keycloak\n');
    expect(run('park').err).not.toContain('Do not run unpark');
  });

  it('rejects an unknown mode', () => {
    const { code, err } = run('remove');
    expect(code).not.toBe(0);
    expect(err).toContain('usage');
    expect(mutating()).toEqual([]);
  });
});
