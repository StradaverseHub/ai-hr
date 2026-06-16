// `statutory:sync` (ADR-0020 §4) — owner-role ingest of bundled + drop-in signed statutory packs. The ONLY
// writer of the national pack tables. Run out-of-band (CLI/cron) as the owner role, never from an HTTP path:
//   node --env-file=.env.local --import tsx scripts/statutory-sync.ts
//
// Sources: the build-bundled dir (baseline) + an out-of-build STATUTORY_PACK_DIR (genuinely redeploy-free
// drop-in). Trust bundles (*.trust.json) ingest first (sequence-advance enforced), then packs (*.pack.json),
// cross-pack best-effort — each pack is atomic, every failure is logged, and a non-zero exit alarms.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desc, isNotNull } from 'drizzle-orm';
import { createDb } from '../db/client';
import { statutoryPackSyncLog } from '../db/schema';
import { ingestPack, ingestTrustBundle, PackIngestError } from '../localization/statutory-pack/ingest';
import { pullAndIngest } from '../localization/statutory-pack/pull';

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), '..', 'localization', 'statutory-pack', 'bundled');

const listFiles = (dir: string, suffix: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(suffix))
        .map((f) => join(dir, f))
        .sort()
    : [];

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('statutory:sync requires MIGRATION_DATABASE_URL (the owner role).');
    process.exit(2);
  }
  const { db, client } = createDb(url);
  const now = new Date();
  const dirs = [BUNDLED, ...(process.env.STATUTORY_PACK_DIR ? [process.env.STATUTORY_PACK_DIR] : [])];

  let ingested = 0;
  let failed = 0;
  let sequenceSeen: number | null = null;
  const errors: string[] = [];

  for (const dir of dirs) {
    for (const f of listFiles(dir, '.trust.json')) {
      try {
        // Trust-bundle anti-rollback is internal (statutory_signing_key.trustSequence); sequence_seen in
        // the sync log is reserved for the pull INDEX sequence, so don't set it here.
        const r = await ingestTrustBundle(db, readFileSync(f, 'utf8'));
        console.log(`trust ${f}: seq=${r.sequence} keys=${r.keys} revoked=${r.revoked}`);
      } catch (e) {
        failed += 1;
        errors.push(`${f}: ${(e as Error).message}`);
        console.error(`trust FAIL ${f}: ${(e as Error).message}`);
      }
    }
  }

  for (const dir of dirs) {
    for (const f of listFiles(dir, '.pack.json')) {
      try {
        const r = await ingestPack(db, readFileSync(f, 'utf8'), { source: f, now });
        ingested += r.rulesets;
        console.log(`pack ${f}: +${r.rulesets} ruleset(s) (skipped ${r.skipped})`);
      } catch (e) {
        failed += 1;
        const code = e instanceof PackIngestError ? e.code : 'ERR';
        errors.push(`${f}: [${code}] ${(e as Error).message}`);
        console.error(`pack FAIL ${f}: [${code}] ${(e as Error).message}`);
      }
    }
  }

  // Optional hardened remote pull (ADR-0020 §5). Anti-rollback compares the index sequence against the
  // highest sequence ever seen (stored only by prior pulls in statutory_pack_sync_log.sequence_seen).
  const pullUrl = process.env.STATUTORY_PACK_URL;
  let source = dirs.join(',');
  if (pullUrl) {
    const [last] = await db
      .select({ s: statutoryPackSyncLog.sequenceSeen })
      .from(statutoryPackSyncLog)
      .where(isNotNull(statutoryPackSyncLog.sequenceSeen))
      .orderBy(desc(statutoryPackSyncLog.sequenceSeen))
      .limit(1);
    try {
      const r = await pullAndIngest(db, { url: pullUrl, now, lastSequence: last?.s ?? 0 });
      ingested += r.ingested;
      failed += r.failed;
      sequenceSeen = r.sequence;
      for (const e of r.errors) errors.push(`pull ${e}`);
      console.log(`pull ${pullUrl}: seq=${r.sequence} +${r.ingested} ruleset(s), ${r.failed} failure(s)`);
    } catch (e) {
      failed += 1;
      errors.push(`pull: ${(e as Error).message}`);
      console.error(`pull FAIL ${pullUrl}: ${(e as Error).message}`);
    }
    source += ` +pull:${pullUrl}`;
  }

  await db.insert(statutoryPackSyncLog).values({
    source,
    sequenceSeen,
    ingested,
    failed,
    error: errors.length ? errors.join(' | ') : null,
  });
  await client.end();
  console.log(`sync done: ingested ${ingested} ruleset(s), ${failed} failure(s).`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
