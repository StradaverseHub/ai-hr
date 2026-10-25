/// <reference types="next" />
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { operatorSsh, operatorRsyncShell, operatorSshCommand } from '../scripts/operator-ssh.mjs';

const bashConfig = resolve('scripts/operator-ssh.sh');
const shell = (env: Partial<NodeJS.ProcessEnv> = {}, cwd = tmpdir()) => execFileSync('bash', ['-c',
  '. "$1" || exit $?; printf "%s\\n" "$AIHR_OPERATOR_TARGET" "${AIHR_OPERATOR_SSH_OPTS[@]}"', '_', bashConfig],
  { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env, NODE_ENV: 'test' } }).trim().split('\n');

describe('private operator SSH configuration', () => {
  it('uses the alias without overriding the OpenSSH username or port', () => {
    const settings = operatorSsh({}, tmpdir());
    expect(settings.target).toBe('aihr-staging');
    expect(settings.options).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12']);
    expect(shell()).toEqual([settings.target, ...settings.options]);
  });
  it('preserves explicit endpoint overrides in both callers', () => {
    const env = { IMPROVE_SSH_HOST: 'staging.example.com', IMPROVE_SSH_USER: 'test-operator', IMPROVE_SSH_PORT: '2222' };
    const settings = operatorSsh(env, tmpdir());
    expect(settings.target).toBe('test-operator@staging.example.com');
    expect(settings.options.slice(-2)).toEqual(['-p', '2222']);
    expect(shell(env)).toEqual([settings.target, ...settings.options]);
  });
  it.each([
    { IMPROVE_SSH_HOST: '-oProxyCommand=bad' }, { IMPROVE_SSH_USER: 'bad user' },
    { IMPROVE_SSH_PORT: '0' }, { IMPROVE_SSH_PORT: '65536' }, { IMPROVE_SSH_PORT: '22;false' },
    { IMPROVE_SSH_PORT: '000000022' }, { AIHR_SSH_CONFIG: '/nonexistent/operator-ssh-config' },
  ])('refuses malformed options before starting SSH: %j', env => {
    expect(() => operatorSsh(env, tmpdir())).toThrow();
    expect(() => shell(env)).toThrow();
  });
  it('selects a private config and passes paths with spaces/quotes safely through rsync', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "operator's SSH ")));
    try {
      mkdirSync(join(cwd, '.improve'));
      const config = join(cwd, '.improve/ssh_config');
      writeFileSync(config, 'Host aihr-staging\n HostName staging.example.com\n', { mode: 0o600 });
      const settings = operatorSsh({}, cwd);
      expect(settings.options.slice(-2)).toEqual(['-F', config]);
      expect(shell({}, cwd)).toEqual([settings.target, ...settings.options]);
      const command = operatorSshCommand(settings);
      // Diagnostic commands use shell quoting, while rsync -e uses its own parser.
      const result = execFileSync('bash', ['-c', 'ssh() { printf "%s\\n" "$@"; }; ' + command], { encoding: 'utf8' }).trim().split('\n');
      expect(result).toEqual(settings.options);
      const bin = join(cwd, 'bin'); mkdirSync(bin);
      const source = join(cwd, 'source'); mkdirSync(source);
      const argvFile = join(cwd, 'argv.json');
      writeFileSync(join(bin, 'ssh'), '#!' + process.execPath + '\nrequire("node:fs").writeFileSync(' + JSON.stringify(argvFile) + ', JSON.stringify(process.argv.slice(2)));process.exit(1);\n', { mode: 0o755 });
      expect(() => execFileSync('rsync', ['-an', '-e', operatorRsyncShell(settings), source + '/', 'aihr-staging:/tmp/example/'], { env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdio: 'pipe' })).toThrow();
      const actual = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
      expect(actual.slice(0, settings.options.length)).toEqual(settings.options);
      expect(actual[settings.options.length]).toBe('aihr-staging');
      const explicit = operatorSsh({ AIHR_SSH_CONFIG: config }, tmpdir());
      expect(explicit.options).toEqual(settings.options);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
