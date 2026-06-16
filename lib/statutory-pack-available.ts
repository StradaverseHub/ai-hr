import 'server-only';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The highest packVersion present on disk (bundled dir + STATUTORY_PACK_DIR), as a staleness HINT only
 * (ADR-0020 §8) — it reads the envelope's declared packVersion without verifying the signature (verification
 * happens at ingest). Lets the UI surface "a newer pack file is on disk but not yet ingested — run sync".
 * Best-effort: unreadable files/dirs are skipped. Returns null if no pack files are found.
 */
export function latestAvailablePackVersion(): string | null {
  const dirs = [
    join(process.cwd(), 'localization', 'statutory-pack', 'bundled'),
    ...(process.env.STATUTORY_PACK_DIR ? [process.env.STATUTORY_PACK_DIR] : []),
  ];
  let latest: string | null = null;
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.pack.json')) continue;
        try {
          const env = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { payload?: string };
          const pv = (JSON.parse(env.payload ?? '{}') as { packVersion?: string }).packVersion;
          if (typeof pv === 'string' && (latest === null || pv > latest)) latest = pv;
        } catch {
          /* skip unreadable/malformed pack file */
        }
      }
    } catch {
      /* skip unreadable dir */
    }
  }
  return latest;
}
