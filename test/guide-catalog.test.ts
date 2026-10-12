import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guideSourceHash, loadGuides, loadOperatorGuides } from '../lib/guide-catalog';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aihr-guides-'));
  temporary.push(dir);
  mkdirSync(join(dir, 'i18n'));
  const meta = { slug: 'example', title: 'Current guide', audience: 'employee', category: 'general', order: 1 };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ guides: [meta] }));
  writeFileSync(join(dir, 'example.md'), 'Current instructions');
  writeFileSync(join(dir, 'i18n', 'titles.json'), JSON.stringify({ example: { ms: 'Panduan' } }));
  writeFileSync(join(dir, 'i18n', 'example.ms.md'), 'Arahan');
  return { dir, meta };
}

describe('bundled guide catalog', () => {
  it('publishes translations only for the exact reviewed source, including the title', () => {
    const { dir, meta } = fixture();
    expect(loadGuides(dir)[0].i18n).toEqual({});
    writeFileSync(join(dir, 'i18n', 'source-hashes.json'), JSON.stringify({ example: { ms: guideSourceHash(meta.title, 'Current instructions') } }));
    expect(loadGuides(dir)[0].i18n.ms).toEqual({ title: 'Panduan', body: 'Arahan' });
    writeFileSync(join(dir, 'example.md'), 'Changed workflow');
    expect(loadGuides(dir)[0].i18n).toEqual({});
    writeFileSync(join(dir, 'example.md'), 'Current instructions');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ guides: [{ ...meta, title: 'Changed title' }] }));
    expect(loadGuides(dir)[0].i18n).toEqual({});
  });

  it('rejects unsafe slugs, duplicates and operator audience in a tenant catalog', () => {
    const { dir, meta } = fixture();
    for (const guides of [[{ ...meta, slug: '../secret' }], [meta, meta], [{ ...meta, audience: 'operator' }]]) {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ guides }));
      expect(() => loadGuides(dir)).toThrow(/Invalid|duplicate/);
    }
  });

  it('keeps operator content separate and every shipped guide link points to a page', () => {
    const tenantGuides = loadGuides();
    const operatorGuides = loadOperatorGuides();
    expect(tenantGuides.some(g => g.meta.slug === 'employee-claims')).toBe(true);
    expect(tenantGuides.some(g => g.meta.slug === 'admin-lifecycle')).toBe(true);
    expect(tenantGuides.some(g => g.meta.slug === 'admin-rewards')).toBe(true);
    expect(operatorGuides.some(g => g.slug === 'operator-provisioning')).toBe(true);
    expect(tenantGuides.some(g => operatorGuides.some(o => o.slug === g.meta.slug))).toBe(false);
    const bodies = [...tenantGuides.map(g => g.body), ...operatorGuides.map(g => g.body)];
    let checked = 0;
    for (const body of bodies) for (const match of body.matchAll(/\]\((\/[^)]+)\)/g)) {
      const route = match[1].split(/[?#]/)[0];
      expect(existsSync(join(process.cwd(), 'app', route, 'page.tsx')), route).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    const sourceFiles = readdirSync('content/guides').filter(f => f.endsWith('.md'));
    expect(sourceFiles.sort()).toEqual(tenantGuides.map(g => g.meta.slug + '.md').sort());
  });

  it('refreshes documentation in the normal deployment before restart, outside demo seeding', () => {
    const deploy = readFileSync('deploy/deploy.sh', 'utf8');
    const refresh = deploy.indexOf('node --env-file=.env.production --import tsx db/seed-guides.ts --all');
    expect(refresh).toBeGreaterThan(0);
    expect(refresh).toBeGreaterThan(deploy.indexOf('Customer deployment — the demo seeder was not run'));
    expect(refresh).toBeLessThan(deploy.indexOf('dstate phase restart'));
  });
});
