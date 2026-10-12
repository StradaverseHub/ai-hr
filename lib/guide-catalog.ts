/** Bundled documentation only. No database or session reads; callers own audience authorization. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KbAudience } from '../core/knowledge-base';
import { locales, defaultLocale } from '../i18n/config';

export type GuideMeta = { slug: string; title: string; audience: KbAudience; category: string; order: number };
export type GuideI18n = Record<string, { title: string; body: string }>;
export function guideSourceHash(title: string, body: string): string {
  return createHash('sha256').update(title + '\n' + body.trim()).digest('hex');
}
function json<T>(file: string, fallback: T): T {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : fallback;
}
export function loadGuides(directory = join(process.cwd(), 'content', 'guides')): { meta: GuideMeta; body: string; i18n: GuideI18n }[] {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { guides: GuideMeta[] };
  const translations = join(directory, 'i18n');
  const titles = json<Record<string, Record<string, string>>>(join(translations, 'titles.json'), {});
  const hashes = json<Record<string, Record<string, string>>>(join(translations, 'source-hashes.json'), {});
  const seen = new Set<string>();
  return manifest.guides.slice().sort((a, b) => a.order - b.order).map(meta => {
    if (!/^[a-z0-9-]+$/.test(meta.slug) || seen.has(meta.slug)) throw new Error('Invalid or duplicate guide slug: ' + meta.slug);
    if (!['all', 'employee', 'manager', 'hr_admin'].includes(meta.audience)) throw new Error('Invalid tenant guide audience: ' + meta.slug);
    seen.add(meta.slug);
    const body = readFileSync(join(directory, meta.slug + '.md'), 'utf8').trim();
    if (!body || !meta.title.trim()) throw new Error('Empty guide: ' + meta.slug);
    const hash = guideSourceHash(meta.title, body);
    const i18n: GuideI18n = {};
    for (const locale of locales.filter(l => l !== defaultLocale)) {
      const file = join(translations, meta.slug + '.' + locale + '.md');
      const title = titles[meta.slug]?.[locale];
      if (title && hashes[meta.slug]?.[locale] === hash && existsSync(file)) {
        const translatedBody = readFileSync(file, 'utf8').trim();
        if (translatedBody) i18n[locale] = { title, body: translatedBody };
      }
    }
    return { meta, body, i18n };
  });
}

/** Only render after the operator and non-demo checks; never seed these into a tenant library. */
export function loadOperatorGuides() {
  const directory = join(process.cwd(), 'content', 'operator-guides');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { guides: { slug: string; title: string }[] };
  return manifest.guides.map(meta => {
    if (!/^[a-z0-9-]+$/.test(meta.slug)) throw new Error('Invalid operator guide slug');
    return { ...meta, body: readFileSync(join(directory, meta.slug + '.md'), 'utf8').trim() };
  });
}
