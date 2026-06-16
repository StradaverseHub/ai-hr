/**
 * Statutory-pack ingest (ADR-0020 §4) — owner-role only. Verifies signed artifacts, validates ruleset
 * CONTENT (signature proves origin, not correctness), enforces monotonic packVersion + first-of-month
 * effective dates, and writes per-pack-atomically with idempotent / identity-conflict handling.
 *
 * The ONLY writer of the national pack tables. Invoked exclusively out-of-band by `pnpm statutory:sync`
 * as the owner role — never from an HTTP request path.
 */
import { and, desc, eq } from 'drizzle-orm';
import { createDb } from '../../db/client';
import { statutoryPack, statutorySigningKey } from '../../db/schema';
import { validateStatutoryRuleset } from '../my/statutory-config';
import type { StatutoryRuleset } from '../my/statutory-tables';
import { sha256Hex } from './crypto';
import { PackVerifyError, verifyPack, verifyTrustBundle } from './verify';
import type { PackPayload, TrustSet } from './types';

type OwnerDb = ReturnType<typeof createDb>['db'];

export class PackIngestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PackIngestError';
  }
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const rulesetChecksum = (data: unknown): string => sha256Hex(Buffer.from(JSON.stringify(data), 'utf8'));

/** Materialize the trust set (operational keys + revocation/expiry) from statutory_signing_key. */
export async function loadTrustFromDb(db: OwnerDb): Promise<TrustSet> {
  const rows = await db.select().from(statutorySigningKey);
  const keys: TrustSet['keys'] = new Map();
  let sequence = 0;
  for (const r of rows) {
    keys.set(r.keyId, {
      publicKey: r.publicKey,
      expiresAt: iso(r.expiresAt),
      revokedAt: r.status === 'revoked' || r.revokedAt ? iso(r.revokedAt ?? new Date()) : null,
    });
    sequence = Math.max(sequence, r.trustSequence);
  }
  return { sequence, keys };
}

/** Verify a root-signed trust bundle and materialize its keys. Anti-rollback: sequence must advance. */
export async function ingestTrustBundle(
  db: OwnerDb,
  bundleText: string,
): Promise<{ sequence: number; keys: number; revoked: number }> {
  const { bundle } = verifyTrustBundle(bundleText); // verified against build-bundled trusted roots
  // ATOMIC: the anti-rollback gate + all key writes run in ONE transaction. A crash mid-way must NOT advance
  // the stored sequence (which would then reject a retry of the SAME bundle as a rollback and lock out the
  // security-critical revocation/rotation path) — the transaction guarantees all-or-nothing.
  await db.transaction(async (tx) => {
    const [maxRow] = await tx
      .select({ s: statutorySigningKey.trustSequence })
      .from(statutorySigningKey)
      .orderBy(desc(statutorySigningKey.trustSequence))
      .limit(1);
    const stored = maxRow?.s ?? 0;
    // Reject a STRICTLY OLDER bundle (genuine rollback). Re-ingesting the SAME sequence is idempotent: there
    // is exactly one root-signed bundle per sequence (a revocation bumps the sequence), and the per-key
    // upserts below re-apply identical content as a no-op — so a normal repeated `sync` (cron) and a retry
    // after a crash both succeed instead of being wrongly rejected as a rollback.
    if (bundle.sequence < stored) {
      throw new PackIngestError('TRUST_ROLLBACK', `Trust bundle sequence ${bundle.sequence} < stored ${stored}`);
    }
    const revoked = new Map(bundle.revoked.map((r) => [r.keyId, r.revokedAt]));
    for (const k of bundle.keys) {
      const revokedAt = revoked.get(k.keyId) ?? null;
      const values = {
        keyId: k.keyId,
        publicKey: k.publicKey,
        status: revokedAt ? 'revoked' : 'active',
        certifiedAt: new Date(k.certifiedAt),
        expiresAt: new Date(k.expiresAt),
        revokedAt: revokedAt ? new Date(revokedAt) : null,
        trustSequence: bundle.sequence,
        updatedAt: new Date(),
      };
      await tx.insert(statutorySigningKey).values(values).onConflictDoUpdate({
        target: statutorySigningKey.keyId,
        set: {
          publicKey: values.publicKey,
          status: values.status,
          expiresAt: values.expiresAt,
          revokedAt: values.revokedAt,
          trustSequence: values.trustSequence,
          updatedAt: values.updatedAt,
        },
      });
    }
    // Revocations of keys no longer listed in `keys` (revoke-and-drop): mark them revoked.
    for (const r of bundle.revoked) {
      if (!bundle.keys.find((k) => k.keyId === r.keyId)) {
        await tx
          .update(statutorySigningKey)
          .set({ status: 'revoked', revokedAt: new Date(r.revokedAt), trustSequence: bundle.sequence, updatedAt: new Date() })
          .where(eq(statutorySigningKey.keyId, r.keyId));
      }
    }
  });
  return { sequence: bundle.sequence, keys: bundle.keys.length, revoked: bundle.revoked.length };
}

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;
/** Zero-padded YYYY.MM.DD — enforced so the lexical monotonic compare is sound (2026.02.01 < 2026.10.01). */
const PACK_VERSION_RE = /^\d{4}\.\d{2}\.\d{2}$/;
/** Reject a far-future effective date (ADR-0020 §4) — kills a dormant pre-emption pack. */
const MAX_EFFECTIVE_HORIZON_MONTHS = 18;

/** Plausibility envelope beyond shape (validateStatutoryRuleset): a signed-but-absurd pack is rejected. */
function sanityBounds(rs: StatutoryRuleset): string[] {
  const e: string[] = [];
  if (!(rs.epf.employeeRate >= 0.01 && rs.epf.employeeRate <= 0.3)) e.push('EPF employee rate outside [1%, 30%]');
  if (!(rs.epf.employerRateLow >= 0.01 && rs.epf.employerRateLow <= 0.3)) e.push('EPF employer rate (low) implausible');
  if (!(rs.ot.wageCeiling >= 0 && rs.ot.wageCeiling <= 100_000)) e.push('OT wage ceiling implausible');
  if (!(rs.contribCeiling >= 0 && rs.contribCeiling <= 100_000)) e.push('Contribution ceiling implausible');
  if (rs.pcb.bands.length === 0 || rs.socso.category1.length === 0 || rs.eis.bands.length === 0)
    e.push('A band table is empty');
  return e;
}

/**
 * Verify + content-validate a pack and ingest it PER-PACK-ATOMICALLY. Identity is
 * (country, packVersion, rulesetVersion, effectiveFrom): an exact re-ingest is idempotent; a reused identity
 * with DIFFERENT content is a hard error. packVersion must be ≥ the latest already stored for the country.
 */
export async function ingestPack(
  db: OwnerDb,
  packText: string,
  opts: { source: string; now: Date },
): Promise<{ packVersion: string; rulesets: number; skipped: number }> {
  const trust = await loadTrustFromDb(db);
  let pack: PackPayload;
  let signedKeyId: string;
  try {
    const v = verifyPack(packText, { trust, now: opts.now });
    pack = v.pack;
    signedKeyId = v.keyId;
  } catch (e) {
    throw new PackIngestError(e instanceof PackVerifyError ? e.code : 'VERIFY', (e as Error).message);
  }

  // Format guard — makes the lexical monotonic compare below sound (a mis-padded version mis-orders).
  if (!PACK_VERSION_RE.test(pack.packVersion)) {
    throw new PackIngestError('BAD_PACK_VERSION', `packVersion ${pack.packVersion} must be YYYY.MM.DD`);
  }
  const horizon = new Date(pack.issuedAt);
  horizon.setMonth(horizon.getMonth() + MAX_EFFECTIVE_HORIZON_MONTHS);

  // Content validation — signature proved origin, not correctness.
  for (const r of pack.rulesets) {
    if (!FIRST_OF_MONTH.test(r.effectiveFrom)) {
      throw new PackIngestError('NOT_FIRST_OF_MONTH', `effectiveFrom ${r.effectiveFrom} must be the first of a month`);
    }
    if (new Date(`${r.effectiveFrom}T00:00:00Z`) > horizon) {
      throw new PackIngestError('EFFECTIVE_TOO_FAR', `effectiveFrom ${r.effectiveFrom} is > ${MAX_EFFECTIVE_HORIZON_MONTHS}mo after issuedAt`);
    }
    const data = r.data as StatutoryRuleset;
    const shape = validateStatutoryRuleset(data);
    if (shape.length) throw new PackIngestError('INVALID_RULESET', shape.join('; '));
    const sane = sanityBounds(data);
    if (sane.length) throw new PackIngestError('IMPLAUSIBLE', sane.join('; '));
  }

  // Monotonic packVersion per country (lexical compare is sound given the format guard above).
  const [maxRow] = await db
    .select({ pv: statutoryPack.packVersion })
    .from(statutoryPack)
    .where(eq(statutoryPack.country, pack.country))
    .orderBy(desc(statutoryPack.packVersion))
    .limit(1);
  if (maxRow && pack.packVersion < maxRow.pv) {
    throw new PackIngestError('NON_MONOTONIC', `packVersion ${pack.packVersion} < latest ${maxRow.pv}`);
  }

  let rulesets = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    for (const r of pack.rulesets) {
      const checksum = rulesetChecksum(r.data);
      const [existing] = await tx
        .select({ checksum: statutoryPack.checksum })
        .from(statutoryPack)
        .where(
          and(
            eq(statutoryPack.country, pack.country),
            eq(statutoryPack.packVersion, pack.packVersion),
            eq(statutoryPack.rulesetVersion, r.version),
            eq(statutoryPack.effectiveFrom, r.effectiveFrom),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new PackIngestError(
            'IDENTITY_CONFLICT',
            `Pack ${pack.packVersion}/${r.version}@${r.effectiveFrom} re-issued with different content`,
          );
        }
        skipped += 1;
        continue; // idempotent replay
      }
      await tx.insert(statutoryPack).values({
        country: pack.country,
        schemaVersion: 1,
        packVersion: pack.packVersion,
        rulesetVersion: r.version,
        effectiveFrom: r.effectiveFrom,
        data: r.data as StatutoryRuleset,
        checksum,
        signedKeyId,
        issuedAt: new Date(pack.issuedAt),
        validUntil: new Date(pack.validUntil),
        ingestedSource: opts.source,
      });
      rulesets += 1;
    }
  });
  return { packVersion: pack.packVersion, rulesets, skipped };
}
