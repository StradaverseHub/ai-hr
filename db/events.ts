/**
 * Domain-event substrate (ADR-0006). `appendEvent` writes an immutable event in the
 * CURRENT transaction, so a state change and its audit record commit together —
 * no change without an event, no event without its change.
 */
import { domainEvent } from './schema';
import type { SessionContext, Tx } from './client';

export type Actor = { type: 'user' | 'system' | 'agent' | 'external'; id?: string };

export type AppendEventArgs = {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string; // past-tense, dotted: e.g. 'employment.hired'
  actor: Actor;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: (e.payload ?? null) as any,
  });
}

/** Derive an Actor from the session context (USER if we have a user id, else SYSTEM). */
export function actorOf(ctx: SessionContext): Actor {
  return ctx.userId ? { type: 'user', id: ctx.userId } : { type: 'system' };
}
