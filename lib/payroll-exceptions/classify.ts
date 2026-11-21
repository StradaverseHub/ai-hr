/**
 * The three buckets the grouped Exceptions page sorts open payroll exceptions into (approved mockup, 11 November 2026):
 *  - `check`   — look like real pay errors: check each one (everything that blocks a run, unless it is a missing detail,
 *                and every review finding that is about the figures themselves);
 *  - `missing` — missing details on the person's record: one fix per person, on the record;
 *  - `setup`   — look like the company's set-up rather than an error (no clock-in, a pay item that is new this month).
 *
 * PURE AND DETERMINISTIC: the bucket is a function of the stored check id and severity only. No figure, no model and
 * no threshold is consulted, so the same finding always lands in the same bucket.
 *
 * THE SAFETY RULE IS HERE, NOT IN THE SCREEN. A finding with severity `block` is never in `setup`, whatever its check,
 * so nothing that blocks a run can be offered for a bulk "Mark as expected" (bulk.ts refuses it again on the server).
 * An uncatalogued check falls into `check`: the cautious place, where each one is looked at.
 */
import type { Severity } from '../../core/payroll-anomaly-detectors';
import { entryOf } from './catalogue';

export type Bucket = 'check' | 'missing' | 'setup';
/** Display order: the errors first, then the record fixes, then the set-up patterns. */
export const BUCKETS: readonly Bucket[] = Object.freeze(['check', 'missing', 'setup']);

export type FindingKind = Readonly<{ checkId: string; severity: string }>;

export const isBlocking = (severity: string) => severity === 'block';

export function bucketOf(checkId: string, severity: Severity | string): Bucket {
  const natural = entryOf(checkId)?.natural ?? 'check';
  if (natural === 'missing') return 'missing';
  if (isBlocking(severity)) return 'check';
  return natural;
}

const RANK: Record<Bucket, number> = { check: 0, missing: 1, setup: 2 };

/**
 * One exception (a verdict, with all its findings) counts once, in its most serious bucket, so the three summary
 * figures add up to the number waiting. A verdict that blocks a run is never counted as set-up.
 */
export function verdictBucket(disposition: string, findings: readonly FindingKind[]): Bucket {
  let best: Bucket | null = null;
  for (const f of findings) {
    const b = bucketOf(f.checkId, f.severity);
    if (best === null || RANK[b] < RANK[best]) best = b;
  }
  if (best === null) return 'check';
  if (best === 'setup' && disposition === 'block') return 'check';
  return best;
}

/** A stored signature entry is `<check id>:<severity>`; check ids never contain a colon. */
export function parseSignature(signature: readonly string[]): FindingKind[] {
  return signature.flatMap(entry => {
    const at = entry.lastIndexOf(':');
    return at > 0 ? [{ checkId: entry.slice(0, at), severity: entry.slice(at + 1) }] : [];
  });
}

export type SignatureCount = Readonly<{ disposition: string; signature: readonly string[]; count: number }>;

/** The three summary figures, over every open exception (one per verdict). */
export function bucketCounts(rows: readonly SignatureCount[]): Record<Bucket, number> {
  const out: Record<Bucket, number> = { check: 0, missing: 0, setup: 0 };
  for (const row of rows) out[verdictBucket(row.disposition, parseSignature(row.signature))] += row.count;
  return out;
}
