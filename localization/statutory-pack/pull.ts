/**
 * Remote pull (ADR-0020 §5): fetch a vendor-signed INDEX, verify it, enforce anti-rollback on its
 * monotonic `sequence` (defeats a stale/withheld/rolled-back index from a hostile or cached endpoint), then
 * fetch + ingest each listed pack through the SAME owner-role ingest pipeline (signature + content validation
 * + monotonic + atomic). The fetcher is injectable so the orchestration is unit-tested without a network.
 */
import { createDb } from '../../db/client';
import { sha256Hex } from './crypto';
import { safeFetchText } from './fetch';
import { ingestPack, loadTrustFromDb, PackIngestError } from './ingest';
import { verifyIndex } from './verify';

type OwnerDb = ReturnType<typeof createDb>['db'];

export class PullError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PullError';
  }
}

export type PullResult = { sequence: number; ingested: number; failed: number; errors: string[] };

export async function pullAndIngest(
  db: OwnerDb,
  opts: { url: string; now: Date; lastSequence: number; fetchText?: (u: string) => Promise<string> },
): Promise<PullResult> {
  const host = new URL(opts.url).hostname;
  const fetchText = opts.fetchText ?? ((u: string) => safeFetchText(u, { allowedHosts: [host] }));

  const trust = await loadTrustFromDb(db);
  const indexText = await fetchText(opts.url);
  const { index } = verifyIndex(indexText, { trust, now: opts.now });

  // Anti-rollback / anti-freeze: the index sequence must not go backwards.
  if (index.sequence < opts.lastSequence) {
    throw new PullError('INDEX_ROLLBACK', `Index sequence ${index.sequence} < last seen ${opts.lastSequence}`);
  }

  let ingested = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const entry of index.packs) {
    try {
      const packUrl = new URL(entry.location, opts.url).href;
      const packText = await fetchText(packUrl);
      if (entry.checksum && sha256Hex(Buffer.from(packText, 'utf8')) !== entry.checksum) {
        throw new PullError('CHECKSUM', `pack ${entry.packVersion}: index checksum mismatch`);
      }
      const r = await ingestPack(db, packText, { source: `pull:${packUrl}`, now: opts.now });
      ingested += r.rulesets;
    } catch (e) {
      failed += 1;
      const code = e instanceof PackIngestError || e instanceof PullError ? `[${e.code}] ` : '';
      errors.push(`${entry.packVersion}: ${code}${(e as Error).message}`);
    }
  }
  return { sequence: index.sequence, ingested, failed, errors };
}
