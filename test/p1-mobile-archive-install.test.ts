/** Shipping-input acceptance using the genuine pinned EAS archive copier, without Expo auth/services. */
import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

it('the real EAS archive implementation produces isolated input that typechecks and bundles both native platforms', () => {
  const source = resolve('.'), work = mkdtempSync(join(tmpdir(), 'aihr-eas-archive-'));
  const tool = join(work, 'oracle'), archive = join(work, 'archive');
  try {
    mkdirSync(tool);
    for (const file of ['package.json', 'package-lock.json']) {
      copyFileSync(join(source, 'test/fixtures/eas-archive-tool', file), join(tool, file));
    }
    const env = { ...process.env, EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', NODE_OPTIONS: '--max-old-space-size=6144' };
    const run = (command: string, args: string[], cwd: string, timeout: number) => {
      const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
      expect(result.error).toBeUndefined(); expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
    };
    // No package scripts or global CLI installation; the complete oracle dependency graph is locked.
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], tool, 300000);
    const version = JSON.parse(readFileSync(join(tool, 'node_modules/eas-cli/package.json'), 'utf8')).version;
    expect(version).toBe('27.2.0');
    const copier = join(tool, 'node_modules/eas-cli/build/vcs/local.js');
    // This is the unmodified implementation used by the EAS archive stage. Its local copier/Ignore
    // module has no authentication or network operation; do not invoke build/upload/submit/init.
    run(process.execPath, ['-e', `require(${JSON.stringify(copier)}).makeShallowCopyAsync(${JSON.stringify(source)},${JSON.stringify(archive)}).catch(e=>{console.error(e);process.exitCode=1})`], tool, 60000);
    const witness = {
      version, lockSha256: createHash('sha256').update(readFileSync(join(tool, 'package-lock.json'))).digest('hex'),
      copierSha256: createHash('sha256').update(readFileSync(copier)).digest('hex'),
      source: process.env.AIHR_CI_HEAD ?? 'unbound', realEasCopier: true, expoServiceCalled: false,
    };
    console.log('EAS archive oracle', witness);
    if (process.env.RUNNER_TEMP) writeFileSync(join(process.env.RUNNER_TEMP, 'aihr-focused/eas-archive-oracle.json'), JSON.stringify(witness));
    expect(existsSync(join(archive, 'lib/mobile-api/v2/team.ts'))).toBe(true);
    for (const path of ['package.json', 'node_modules', 'db', 'lib/session.ts', '.env.local', '.git']) {
      expect(existsSync(join(archive, path))).toBe(false);
    }
    const mobile = join(archive, 'mobile');
    run('npm', ['ci', '--no-audit', '--no-fund'], mobile, 300000);
    expect(existsSync(join(archive, 'node_modules'))).toBe(false);
    run('npm', ['exec', '--offline', '--', 'tsc', '--noEmit'], mobile, 90000);
    run('npm', ['exec', '--offline', '--', 'expo', 'export', '--platform', 'ios', '--platform', 'android', '--max-workers', '2', '--output-dir', join(work, 'bundles')], mobile, 180000);
    expect(existsSync(join(work, 'bundles/metadata.json'))).toBe(true);
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 900000);
