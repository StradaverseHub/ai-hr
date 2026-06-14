/**
 * Seed the default Knowledge Base user guides (ADR-0017).
 *
 * Reads content/guides/manifest.json + each <slug>.md and upserts every guide as a system article
 * (kind='article', is_system=true), keyed by (tenant_id, slug). Idempotent: re-running refreshes the
 * bodies in place and never duplicates. Runs as the owner role (bypasses RLS), like the demo seed.
 *
 *   pnpm kb:seed            # seed into the dev tenant
 *   (also invoked by db/seed.ts after the demo seed)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from './client';
import { kbDocument } from './schema';
import type { KbAudience } from '../core/knowledge-base';
import { locales, defaultLocale } from '../i18n/config';

type GuideMeta = {
  slug: string;
  title: string;
  audience: KbAudience;
  category: string;
  order: number;
};

type GuideI18n = Record<string, { title: string; body: string }>;

const GUIDES_DIR = join(process.cwd(), 'content', 'guides');
const I18N_DIR = join(GUIDES_DIR, 'i18n');
const TARGET_LOCALES = locales.filter((l) => l !== defaultLocale);

function loadTitles(): Record<string, Record<string, string>> {
  const p = join(I18N_DIR, 'titles.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

export function loadGuides(): { meta: GuideMeta; body: string; i18n: GuideI18n }[] {
  const manifest = JSON.parse(readFileSync(join(GUIDES_DIR, 'manifest.json'), 'utf8')) as {
    guides: GuideMeta[];
  };
  const titles = loadTitles();
  return manifest.guides
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((meta) => {
      const body = readFileSync(join(GUIDES_DIR, `${meta.slug}.md`), 'utf8').trim();
      // Per-locale translated content (English is the base columns, never duplicated here).
      const i18n: GuideI18n = {};
      for (const loc of TARGET_LOCALES) {
        const file = join(I18N_DIR, `${meta.slug}.${loc}.md`);
        const title = titles[meta.slug]?.[loc];
        if (existsSync(file) && title) {
          i18n[loc] = { title, body: readFileSync(file, 'utf8').trim() };
        }
      }
      return { meta, body, i18n };
    });
}

/** Upsert all guide articles for one tenant. `db` must be an owner connection (RLS-bypassing). */
export async function seedGuides(
  db: ReturnType<typeof createDb>['db'],
  tenantId: string,
): Promise<number> {
  const guides = loadGuides();
  for (const { meta, body, i18n } of guides) {
    const translations = Object.keys(i18n).length ? i18n : null;
    await db
      .insert(kbDocument)
      .values({
        tenantId,
        kind: 'article',
        title: meta.title,
        slug: meta.slug,
        category: meta.category,
        audience: meta.audience,
        isSystem: true,
        body,
        i18n: translations,
      })
      .onConflictDoUpdate({
        target: [kbDocument.tenantId, kbDocument.slug],
        set: {
          title: meta.title,
          category: meta.category,
          audience: meta.audience,
          body,
          i18n: translations,
          kind: 'article',
          isSystem: true,
          archivedAt: null,
          updatedAt: new Date(),
        },
      });
  }
  return guides.length;
}

// Standalone entry: pnpm kb:seed
async function main() {
  const DEV_TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const tenantId = process.env.KB_SEED_TENANT_ID || DEV_TENANT_ID;
  const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
  const n = await seedGuides(owner.db, tenantId);
  console.log(`✓ Seeded ${n} Knowledge Base guides into tenant ${tenantId}.`);
  await owner.client.end();
}

// Run only when invoked directly (not when imported by db/seed.ts).
if (process.argv[1] && process.argv[1].endsWith('seed-guides.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
