/**
 * ADR-0030 Layer-1 per-subject crypto-shred vault. Stateful key custody over the pii_key table; the pure
 * crypto is in lib/pii/vault.ts. Admin/DPO-only via RLS.
 *
 *  - sealForSubject   → encrypt a value under the subject's DEK (creating + wrapping one on first use)
 *  - unsealForSubject → decrypt it; throws SubjectShreddedError once the DEK is destroyed
 *  - shredSubject     → destroy the wrapped DEK(s) → every value sealed under them is unrecoverable, with
 *                       NO event row deleted (the append-only log stays intact). Appends pii.key.destroyed.
 *
 * Fail-closed: if the master key is unavailable, sealing is refused so cleartext is never silently stored.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { piiKey } from '../db/schema';
import {
  kidOf,
  masterKeyAvailable,
  newDek,
  newKid,
  sealUnderDek,
  unsealUnderDek,
  unwrapDek,
  wrapDek,
} from '../lib/pii/vault';

export class MasterKeyUnavailableError extends Error {
  constructor() {
    super('PII master key unavailable — sealing refused (fail-closed, ADR-0030 §2 Layer 1).');
    this.name = 'MasterKeyUnavailableError';
  }
}
export class SubjectShreddedError extends Error {
  constructor(public readonly subjectEmploymentId: string) {
    super(`PII for subject ${subjectEmploymentId} has been crypto-shredded and is unrecoverable.`);
    this.name = 'SubjectShreddedError';
  }
}

const wrapAad = (tenantId: string, subjectEmploymentId: string) => `pii-dek:${tenantId}:${subjectEmploymentId}`;
const sealAad = (tenantId: string, subjectEmploymentId: string, kid: string) =>
  `pii:${tenantId}:${subjectEmploymentId}:${kid}`;

/** Seal a value under the subject's active DEK (minting + wrapping one on first use). Returns the sealed
 *  token ("kid.iv.ct.tag"); store it wherever the value would otherwise sit. */
export async function sealForSubject(ctx: SessionContext, subjectEmploymentId: string, plaintext: string): Promise<string> {
  if (!masterKeyAvailable()) throw new MasterKeyUnavailableError();
  return withTenant(ctx, async (tx) => {
    const [active] = await tx
      .select({ kid: piiKey.kid, wrappedDek: piiKey.wrappedDek })
      .from(piiKey)
      .where(and(eq(piiKey.subjectEmploymentId, subjectEmploymentId), isNull(piiKey.destroyedAt)))
      .orderBy(desc(piiKey.createdAt))
      .limit(1);
    let kid: string;
    let dek: Buffer;
    if (active?.wrappedDek) {
      kid = active.kid;
      dek = unwrapDek(active.wrappedDek, wrapAad(ctx.tenantId, subjectEmploymentId));
    } else {
      kid = newKid();
      dek = newDek();
      await tx.insert(piiKey).values({
        tenantId: ctx.tenantId,
        subjectEmploymentId,
        kid,
        wrappedDek: wrapDek(dek, wrapAad(ctx.tenantId, subjectEmploymentId)),
      });
    }
    return sealUnderDek(dek, kid, plaintext, sealAad(ctx.tenantId, subjectEmploymentId, kid));
  });
}

/** Decrypt a sealed token. Throws SubjectShreddedError if the subject's DEK has been destroyed. */
export async function unsealForSubject(ctx: SessionContext, subjectEmploymentId: string, token: string): Promise<string> {
  return withTenant(ctx, async (tx) => {
    const kid = kidOf(token);
    const [k] = await tx
      .select({ wrappedDek: piiKey.wrappedDek })
      .from(piiKey)
      .where(and(eq(piiKey.subjectEmploymentId, subjectEmploymentId), eq(piiKey.kid, kid)))
      .limit(1);
    if (!k || !k.wrappedDek) throw new SubjectShreddedError(subjectEmploymentId);
    const dek = unwrapDek(k.wrappedDek, wrapAad(ctx.tenantId, subjectEmploymentId));
    return unsealUnderDek(dek, token, sealAad(ctx.tenantId, subjectEmploymentId, kid));
  });
}

/** Crypto-shred inside an existing transaction — destroy every active wrapped DEK (NULL + destroyed_at),
 *  append pii.key.destroyed. For composing into a larger atomic erasure (core/pdpa.ts erasePersonPii). */
export async function shredSubjectInTx(
  tx: Tx,
  ctx: SessionContext,
  subjectEmploymentId: string,
  reason: string,
): Promise<{ shredded: number }> {
  const rows = await tx
    .update(piiKey)
    .set({ wrappedDek: null, destroyedAt: new Date() })
    .where(and(eq(piiKey.subjectEmploymentId, subjectEmploymentId), isNull(piiKey.destroyedAt)))
    .returning({ kid: piiKey.kid });
  if (rows.length > 0) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pii-key',
      aggregateId: subjectEmploymentId,
      eventType: 'pii.key.destroyed',
      actor: actorOf(ctx),
      subjectEmploymentId,
      payload: { subjectEmploymentId, kids: rows.map((r) => r.kid), reason },
    });
  }
  return { shredded: rows.length };
}

/** Crypto-shred a subject: destroy every active wrapped DEK (NULL + destroyed_at). Idempotent. Appends a
 *  pii.key.destroyed event (no PII payload). Returns how many keys were destroyed. */
export async function shredSubject(
  ctx: SessionContext,
  subjectEmploymentId: string,
  reason: string,
): Promise<{ shredded: number }> {
  return withTenant(ctx, (tx) => shredSubjectInTx(tx, ctx, subjectEmploymentId, reason));
}

/** Whether the subject currently has a usable (non-shredded) key — for readiness checks / erasePersonPii. */
export async function subjectHasActiveKey(ctx: SessionContext, subjectEmploymentId: string): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const [k] = await tx
      .select({ id: piiKey.id })
      .from(piiKey)
      .where(and(eq(piiKey.subjectEmploymentId, subjectEmploymentId), isNull(piiKey.destroyedAt)))
      .limit(1);
    return !!k;
  });
}
