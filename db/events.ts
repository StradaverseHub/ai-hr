/**
 * Domain-event substrate (ADR-0006). `appendEvent` writes an immutable event in the
 * CURRENT transaction, so a state change and its audit record commit together —
 * no change without an event, no event without its change.
 */
import { and, eq, sql } from 'drizzle-orm';
import { domainEvent, employment } from './schema';
import type { SessionContext, Tx } from './client';

export type Actor = { type: 'user' | 'system' | 'agent' | 'external'; id?: string };

/**
 * Movement tab redesign (78853b97) — an OPTIONAL classification tag a writer merges into its event
 * payload as `payload.movement`. Employment History is a read-model projection over this ledger; the
 * tag records the INTENT behind a change (Promotion vs a plain assignment edit) at the single entry
 * point that knows it (core/movement.ts createMovementEvent). Untagged events keep their factual
 * fallback labels, so the tag is never required. `secondary` marks the companion event of a paired
 * write (e.g. the grade half of a Promotion) so the history renders ONE row per movement. Comp events
 * never carry `remarks` in the tag (ADR-0030 redact-to-reference — remarks live on the compensation
 * row); no key here is on the PII ban list.
 */
export type MovementTag = {
  type: string;
  remarks?: string | null;
  endDate?: string | null;
  secondary?: boolean;
  /** 08913328 — correlates every leg of ONE movement submitted from the comparison form (assignment,
   *  grade, flat org columns, reporting line, pay). The history detail needs it because the flat
   *  `employment` columns are not effective-dated and therefore cannot be reconstructed as-of: their
   *  before/after has to come from the sibling `employment.info.updated` event of the SAME movement.
   *  Absent on legacy events and on single-leg writes made outside the Movement module. */
  groupId?: string;
};

export type AppendEventArgs = {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string; // past-tense, dotted: e.g. 'employment.hired'
  actor: Actor;
  /**
   * The employment this event is ABOUT — used by domain_event RLS to scope non-admin reads
   * (ADR-0015). Set it whenever the event concerns a single employee. Leave undefined for
   * tenant-, company-, or batch-level events with no single subject: those become admin-only to
   * read (fail-closed). Never derive it from an untrusted value — pass a real, tenant-local
   * employment id. Note: an event whose payload carries a value the SUBJECT must not see (e.g. a
   * pre-release rating or a merit recommendation) must keep that value OUT of the payload, since
   * subject-scoping makes the event visible to the subject.
   */
  subjectEmploymentId?: string | null;
  payload?: unknown;
};

export async function appendEvent(tx: Tx, e: AppendEventArgs): Promise<void> {
  await tx.insert(domainEvent).values({
    tenantId: e.tenantId,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    eventType: e.eventType,
    actorType: e.actor.type,
    actorId: e.actor.id ?? null,
    subjectEmploymentId: e.subjectEmploymentId ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: (e.payload ?? null) as any,
  });
}

/** Derive an Actor from the session context (USER if we have a user id, else SYSTEM). */
export function actorOf(ctx: SessionContext): Actor {
  return ctx.userId ? { type: 'user', id: ctx.userId } : { type: 'system' };
}

/**
 * Resolve a subject employment for a person-keyed event (statutory profile, core person edit),
 * so it scopes to the person's employment rather than falling back to admin-only. Deterministic
 * pick: prefer an active employment, then the earliest hire, then the lowest id. Null if the
 * person has no employment.
 */
export async function subjectEmploymentForPerson(
  tx: Tx,
  tenantId: string,
  personId: string | null | undefined,
): Promise<string | null> {
  if (!personId) return null;
  const [row] = await tx
    .select({ id: employment.id })
    .from(employment)
    .where(and(eq(employment.tenantId, tenantId), eq(employment.personId, personId)))
    .orderBy(sql`(${employment.terminatedOn} is not null)`, employment.hiredOn, employment.id)
    .limit(1);
  return row?.id ?? null;
}
