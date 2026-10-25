/** Operator-only SSH settings. Real endpoints belong in OpenSSH config, outside Git. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** @param {Partial<NodeJS.ProcessEnv>} env @param {string} cwd */
export function operatorSsh(env = process.env, cwd = process.cwd()) {
  const host = env.IMPROVE_SSH_HOST || 'aihr-staging';
  const user = env.IMPROVE_SSH_USER || '';
  const port = env.IMPROVE_SSH_PORT || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(host)) throw new Error('Invalid IMPROVE_SSH_HOST');
  if (user && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) throw new Error('Invalid IMPROVE_SSH_USER');
  if (port && (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('Invalid IMPROVE_SSH_PORT');
  const localConfig = resolve(cwd, '.improve/ssh_config');
  const config = env.AIHR_SSH_CONFIG || (existsSync(localConfig) ? localConfig : '');
  if (config && !existsSync(config)) throw new Error('AIHR_SSH_CONFIG does not exist');
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12'];
  if (config) options.push('-F', resolve(config));
  if (port) options.push('-p', port);
  const target = user ? user + '@' + host : host;
  return { options, target, remoteDir: env.IMPROVE_REMOTE_DIR || '/opt/ai-hr' };
}

/** rsync -e has its own parser: double an embedded quote, rather than using shell backslashes. */
export function operatorRsyncShell(settings = operatorSsh()) {
  return ['ssh', ...settings.options].map(value => "'" + value.replace(/'/g, "''") + "'").join(' ');
}

/** A copyable shell command for operator diagnostics (POSIX quoting differs from rsync -e). */
export function operatorSshCommand(settings = operatorSsh()) {
  return ['ssh', ...settings.options].map(value => "'" + value.replace(/'/g, "'\\''") + "'").join(' ');
}
