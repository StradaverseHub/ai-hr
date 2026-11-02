/** Shipping-input acceptance using the genuine pinned EAS archive copier, without Expo auth/services. */
import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
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
    const privateInput = join(work, 'private-input'), privateOutput = join(work, 'private-output');
    mkdirSync(privateInput); copyFileSync(join(source, '.easignore'), join(privateInput, '.easignore'));
    const forbidden = ['.env.local', 'mobile/credentials.json', 'mobile/private.key', 'db/client.ts', 'lib/session.ts'];
    const allowed = ['mobile/entry.ts', 'lib/mobile-api/v2/team.ts'];
    for (const path of [...forbidden, ...allowed]) {
      mkdirSync(dirname(join(privateInput, path)), { recursive: true });
      writeFileSync(join(privateInput, path), 'FICTIONAL_ARCHIVE_SENTINEL ' + path);
    }
    run(process.execPath, ['-e', `require(${JSON.stringify(copier)}).makeShallowCopyAsync(${JSON.stringify(privateInput)},${JSON.stringify(privateOutput)}).catch(e=>{console.error(e);process.exitCode=1})`], tool, 60000);
    for (const path of forbidden) expect(existsSync(join(privateOutput, path))).toBe(false);
    for (const path of allowed) expect(readFileSync(join(privateOutput, path), 'utf8')).toBe('FICTIONAL_ARCHIVE_SENTINEL ' + path);
    // This is the unmodified implementation used by the EAS archive stage. Its local copier/Ignore
    // module has no authentication or network operation; do not invoke build/upload/submit/init.
    run(process.execPath, ['-e', `require(${JSON.stringify(copier)}).makeShallowCopyAsync(${JSON.stringify(source)},${JSON.stringify(archive)}).catch(e=>{console.error(e);process.exitCode=1})`], tool, 60000);
    const witness = {
      version, lockSha256: createHash('sha256').update(readFileSync(join(tool, 'package-lock.json'))).digest('hex'),
      copierSha256: createHash('sha256').update(readFileSync(copier)).digest('hex'),
      source: process.env.AIHR_CI_HEAD ?? 'unbound', realEasCopier: true, expoServiceCalled: false,
      ignoreSha256: createHash('sha256').update(readFileSync(join(source, '.easignore'))).digest('hex'), privateSentinelsRefused: forbidden,
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
    const output = join(work, 'bundles');
    const metadata = JSON.parse(readFileSync(join(output, 'metadata.json'), 'utf8'));
    expect(metadata.bundler).toBe('metro');
    const platforms = ['ios', 'android'].map(platform => {
      const record = metadata.fileMetadata[platform];
      expect(typeof record?.bundle).toBe('string'); expect(Array.isArray(record?.assets)).toBe(true);
      const file = resolve(output, record.bundle), local = relative(output, file);
      expect(local.startsWith('..')).toBe(false);
      const bytes = readFileSync(file); expect(bytes.length).toBeGreaterThan(0);
      for (const asset of record.assets) {
        const assetFile = resolve(output, asset.path);
        expect(relative(output, assetFile).startsWith('..')).toBe(false);
        expect(lstatSync(assetFile).isFile()).toBe(true);
      }
      return { platform, bundle: local, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), assets: record.assets.length };
    });
    const inventory: { path: string; bytes: number; sha256: string }[] = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory).sort()) {
        const file = join(directory, name), stat = lstatSync(file);
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile()) inventory.push({ path: relative(archive, file), bytes: stat.size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
      }
    };
    // Record shipping input only, before considering installed dependencies as application bytes.
    for (const directory of [join(archive, 'lib')]) visit(directory);
    const results = { ...witness, platforms, sharedSourceInventory: inventory, isolatedCompilePassed: true, nativeBinaryOrDeviceAcceptance: false };
    console.log('Isolated EAS bundle results', results.platforms);
    if (process.env.RUNNER_TEMP) writeFileSync(join(process.env.RUNNER_TEMP, 'aihr-focused/eas-archive-results.json'), JSON.stringify(results));
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 900000);
