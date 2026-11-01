import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.expo', 'android', 'ios', 'builds'].includes(entry.name)) return [];
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}

// EAS uses gitignore semantics. Exercise Git's matcher with the actual upload rules,
// independently of the source checkout's .gitignore and global excludes.
function excluded(paths: string[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'aihr-store-archive-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    writeFileSync(join(directory, '.gitignore'), readFileSync('.easignore'));
    try {
      return execFileSync('git', ['-c', 'core.excludesFile=/dev/null', '-C', directory,
        'check-ignore', '--no-index', '--stdin'], { input: paths.join('\n') + '\n', encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch (error) {
      if ((error as { status?: number }).status === 1) return [];
      throw error;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('store upload source boundary', () => {
  it('includes the complete shared native import graph in the EAS archive', () => {
    const root = process.cwd(), queue = sourceFiles(resolve('mobile')), visited = new Set<string>(), shared = new Set<string>();
    while (queue.length) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const imported of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
        if (!imported.fileName.startsWith('.')) continue;
        const base = resolve(dirname(file), imported.fileName);
        const dependency = [base + '.ts', base + '.tsx', base + '.js', base + '.json', join(base, 'index.ts')].find(existsSync);
        if (!dependency) continue;
        const name = relative(root, dependency);
        if (name.startsWith('mobile/')) continue;
        expect(name, `Native import from ${relative(root, file)}`).toMatch(/^lib\//);
        if (shared.has(name)) continue;
        shared.add(name); queue.push(dependency);
      }
    }
    expect(shared.size).toBeGreaterThan(20);
    expect(excluded([...shared])).toEqual([]);
  });

  it('keeps server source, secrets, credentials and generated build inputs out', () => {
    const privatePaths = ['package.json', 'core/mobile-attendance.ts', 'db/schema.ts', 'deploy/DEPLOY.md',
      'lib/mobile-api/handler.ts', 'lib/mobile-api/v2/profile-routes.ts',
      'mobile/google-services.json', 'mobile/firebase-service-account.json',
      'mobile/.env.local', 'mobile/credentials.json', 'mobile/signing.p8', 'mobile/upload.keystore',
      'mobile/android/app/build.gradle', 'mobile/ios/App/Info.plist', 'mobile/node_modules/expo/package.json'];
    expect(excluded(privatePaths).sort()).toEqual(privatePaths.sort());
  });
});
