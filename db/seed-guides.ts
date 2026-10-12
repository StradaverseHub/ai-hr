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
import { and, eq, ne, asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Tx } from './client';
import { kbDocument, tenant } from './schema';
import { loadGuides } from '../lib/guide-catalog';
import { SYSTEM_TENANT_ID, sweepSkipReason } from '../core/sweep-scope';
export { loadGuides } from '../lib/guide-catalog';

/**
 * Upsert all guide articles for one tenant. `db` must be an owner handle (RLS-bypassing).
 *
 * Accepts an open TRANSACTION as well as a connection, so tenant provisioning (db/provision.ts) can
 * seed the guides inside its single all-or-nothing owner transaction rather than committing them
 * separately — a customer whose creation rolled back must not be left holding a knowledge base.
 * Existing callers (db/seed.ts, pnpm kb:seed) pass a plain db handle and are unaffected.
 */
export async function seedGuides(
  db: Pick<Tx, 'insert'>,
  tenantId: string,
): Promise<number> {
  const guides = loadGuides();
  let refreshed = 0;
  for (const { meta, body, i18n } of guides) {
    const translations = Object.keys(i18n).length ? i18n : null;
    const rows = await db
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
        // A customer article can use a bundled slug; never promote or overwrite it.
        setWhere: eq(kbDocument.isSystem, true),
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
      }).returning({ id: kbDocument.id });
    refreshed += rows.length;
  }
  return refreshed;
}

/** Refresh every existing tenant, or one explicitly selected tenant, atomically per tenant. */
export async function refreshSystemGuides(db: ReturnType<typeof drizzle>, tenantId?: string) {
  // Validate the complete catalog before writing any tenant.
  const expected = loadGuides().length;
  const tenants = await db.select({ id: tenant.id, status: tenant.status }).from(tenant)
    .where(and(ne(tenant.id, SYSTEM_TENANT_ID), tenantId ? eq(tenant.id, tenantId) : undefined)).orderBy(asc(tenant.id));
  if (tenantId && tenants.length === 0) throw new Error('Knowledge-base tenant does not exist.');
  const results: { tenantId: string; refreshed: number; preserved: number; skipped?: string }[] = [];
  for (const row of tenants) {
    const skipped = sweepSkipReason(row.status);
    if (skipped) {
      results.push({ tenantId: row.id, refreshed: 0, preserved: 0, skipped });
      continue;
    }
    const refreshed = await db.transaction(tx => seedGuides(tx, row.id));
    results.push({ tenantId: row.id, refreshed, preserved: expected - refreshed });
  }
  return results;
}

// pnpm kb:seed remains the development shortcut. Deployments explicitly pass --all.
async function main() {
  const args = process.argv.slice(2);
  const all = args.length === 1 && args[0] === '--all';
  if (args.length && !all) throw new Error('Usage: seed-guides.ts [--all]; select one tenant with KB_SEED_TENANT_ID.');
  if (all && process.env.KB_SEED_TENANT_ID) throw new Error('Choose --all or KB_SEED_TENANT_ID, not both.');
  const tenantId = all ? undefined : process.env.KB_SEED_TENANT_ID || '11111111-1111-1111-1111-111111111111';
  if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error('Invalid KB_SEED_TENANT_ID.');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required to refresh system guides.');
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const results = await refreshSystemGuides(drizzle(client), tenantId);
    for (const row of results) console.log('Knowledge Base: ' + row.tenantId + (row.skipped ? ' skipped=' + row.skipped : ' refreshed=' + row.refreshed + ' preserved-customer-slugs=' + row.preserved));
    console.log('Knowledge Base: refreshed ' + results.filter(row => !row.skipped).length + ' tenant(s).');
  } finally { await client.end({ timeout: 10 }); }
}
if (process.argv[1] && process.argv[1].endsWith('seed-guides.ts')) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
