/**
 * One replay receipt per (tenant, actor, requestId) for native v2 commands — the generalisation of the
 * leave command receipt (core/mobile-leave-command.ts). The domain_event ledger owns replay evidence, as
 * there; no new table.
 *
 *   advisory xact lock on tenant:actor:requestId  →  prior receipt?  same digest ⇒ the stored response
 *                                                                     other digest ⇒ request_conflict
 *                                                  none ⇒ run(tx), then the receipt, in the SAME tx
 *
 * The receipt's subject is the ACTOR's own employment, never the target employee's. domain_event reads are
 * subject-scoped (0037, 0515): an approver loses sight of an employee-keyed event when the employee's
 * manager changes, and a receipt keyed that way would vanish, so the replay would run the command twice.
 *
 * `run` throwing records nothing (the transaction rolls back). Whatever `run` returns — acceptance or a
 * business refusal — is parsed through `response`, recorded and replayed verbatim; a command that wants a
 * retry to re-decide must throw instead. `response` must be a JSON-shaped schema (the stored copy is
 * re-parsed on replay). Kept free of 'server-only': packs' services may reach this module.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { domainEvent, employment } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { COMMAND_CONFLICT, type CommandConflict } from '../lib/mobile-api/v2/common';

export const MOBILE_COMMAND_AGGREGATE = 'mobile-command';
export const MOBILE_COMMAND_EVENT = 'mobile.command.recorded';
const RECEIPT_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND = /^[a-z][a-z0-9_.-]{0,63}$/;

/** The actor is not a signed-in user, or `actorEmploymentId` is not one of the actor's own employments. */
export class MobileCommandOwnerRequired extends Error {
  constructor() { super('A command receipt needs the actor’s own employment'); this.name = 'MobileCommandOwnerRequired'; }
}

/** JSON with object keys sorted at every depth; `undefined` members dropped as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Non-finite number in command intent'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  const proto = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (proto === Object.prototype || proto === null) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  throw new TypeError('Command intent must be plain JSON');
}

export function mobileCommandDigest(kind: string, actorEmploymentId: string, intent: unknown): string {
  return createHash('sha256').update(canonicalJson([RECEIPT_VERSION, kind, actorEmploymentId.toLowerCase(), intent])).digest('hex');
}

export type MobileCommand<S extends z.ZodType> = {
  /** Command family, e.g. `leave.decision`. Part of the digest: one requestId cannot serve two kinds. */
  kind: string;
  requestId: string;
  /** Everything that decides the outcome, excluding requestId. Key order is irrelevant. */
  intent: unknown;
  /** The ACTOR's own employment; the receipt's RLS subject. */
  actorEmploymentId: string;
  response: S;
};

export async function withMobileCommandReceipt<S extends z.ZodType>(
  scope: SessionContext | { ctx: SessionContext; tx: Tx },
  command: MobileCommand<S>,
  run: (tx: Tx) => Promise<z.input<S>>,
): Promise<z.output<S> | CommandConflict> {
  const ctx = 'ctx' in scope ? scope.ctx : scope;
  const { kind, requestId, actorEmploymentId, response } = command;
  if (!ctx.userId || !ctx.personId || !UUID.test(actorEmploymentId)) throw new MobileCommandOwnerRequired();
  if (!KIND.test(kind) || !UUID.test(requestId)) throw new TypeError('Invalid command reference');
  const digest = mobileCommandDigest(kind, actorEmploymentId, command.intent);
  const userId = ctx.userId, personId = ctx.personId, subject = actorEmploymentId.toLowerCase(), aggregateId = requestId.toLowerCase();
  const body = async (tx: Tx): Promise<z.output<S> | CommandConflict> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':mobile-command:' + userId + ':' + aggregateId},0))`);
    const [own] = await tx.select({ id: employment.id }).from(employment).where(and(
      eq(employment.tenantId, ctx.tenantId), eq(employment.id, subject), eq(employment.personId, personId))).limit(1);
    if (!own) throw new MobileCommandOwnerRequired();
    const [prior] = await tx.select({ payload: domainEvent.payload }).from(domainEvent).where(and(
      eq(domainEvent.tenantId, ctx.tenantId), eq(domainEvent.aggregateType, MOBILE_COMMAND_AGGREGATE),
      eq(domainEvent.aggregateId, aggregateId), eq(domainEvent.actorId, userId), eq(domainEvent.eventType, MOBILE_COMMAND_EVENT),
    )).limit(1);
    if (prior) {
      const payload = prior.payload as { digest?: unknown; response?: unknown } | null;
      if (payload?.digest !== digest) return COMMAND_CONFLICT;
      return response.parse(payload.response);
    }
    const out = response.parse(await run(tx));
    await appendEvent(tx, {
      tenantId: ctx.tenantId, aggregateType: MOBILE_COMMAND_AGGREGATE, aggregateId, eventType: MOBILE_COMMAND_EVENT,
      actor: actorOf(ctx), subjectEmploymentId: subject, payload: { version: RECEIPT_VERSION, kind, digest, response: out },
    });
    return out;
  };
  return 'ctx' in scope ? body(scope.tx) : withTenant(ctx, body);
}
