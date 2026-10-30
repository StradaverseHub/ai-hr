/**
 * ADR-0151 §4.5 (amendment 2026-10-29). The tenant's named agent principal for unattended Automatic-tier
 * work: the nightly orchestrator pass and its two specialists. Not a login and never an administrator —
 * an agent context carries no grant, and the database admits it only through migration 0672's policies.
 *
 * The switches stay the existing tenant settings (ADR-0116, changed in AI management). Who switched a
 * specialist on is not stored again: it is the actor of the latest `tenant-setting.changed` event for that
 * key, when that event set it to true. A switch that is on without such an event is unattributed, and its
 * specialist does not run under the principal.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AgentEnablement, Db, SessionContext, Tx } from '../db/client';
import type { Actor } from '../db/events';
import * as schema from '../db/schema';
import type { EntitlementSnapshot } from './entitlement-types';
import { settingEnabled } from './entitlements';
import { AGENT_PRINCIPAL_SPECIALISTS } from '../lib/ai/agent-capability-inventory';

/** The specialists and their switches, from the reviewed list in the capability inventory. */
export const AGENT_SPECIALISTS = (Object.keys(AGENT_PRINCIPAL_SPECIALISTS) as AgentEnablement['feature'][])
  .map(feature => ({ feature, setting: AGENT_PRINCIPAL_SPECIALISTS[feature].setting }));
export type AgentFeature = AgentEnablement['feature'];
/** Literal keys, not `spec.setting`: test/module-catalog-drift.test.ts can only see literal gate keys. */
const SWITCHED_ON: Record<AgentFeature, (ctx: SessionContext) => boolean> = {
  readiness_reminders: ctx => settingEnabled(ctx, 'notifications.readiness_nudge_enabled'),
  claims_triage: ctx => settingEnabled(ctx, 'claims.input_triage_enabled'),
  approval_chasers: ctx => settingEnabled(ctx, 'notifications.approval_chasers_enabled'),
  review_chasers: ctx => settingEnabled(ctx, 'notifications.review_chasers_enabled'),
  clock_reminders: ctx => settingEnabled(ctx, 'notifications.missing_clock_reminders_enabled'),
  document_reminders: ctx => settingEnabled(ctx, 'notifications.passport_expiry_reminders_enabled'),
  lifecycle_chasers: ctx => settingEnabled(ctx, 'notifications.lifecycle_step_chasers_enabled'),
};

export const isAgentContext = (ctx: SessionContext): ctx is SessionContext & { agent: NonNullable<SessionContext['agent']> } =>
  ctx.agent != null;

/** The principal row for a tenant, created on first use. Owner connection only (the app role cannot write it). */
export async function ensureAgentPrincipal(owner: Db, tenantId: string): Promise<string> {
  await owner.insert(schema.aiAgentPrincipal).values({ tenantId }).onConflictDoNothing({ target: schema.aiAgentPrincipal.tenantId });
  const [row] = await owner.select({ id: schema.aiAgentPrincipal.id }).from(schema.aiAgentPrincipal)
    .where(eq(schema.aiAgentPrincipal.tenantId, tenantId));
  if (!row) throw new Error('Agent principal unavailable.');
  return row.id;
}

/** An agent context with no grant. Enablements are resolved inside the agent's own transaction. */
export function agentContext(tenantId: string, principalId: string, entitlements: EntitlementSnapshot,
  enablements: readonly AgentEnablement[] = []): SessionContext {
  return { tenantId, roles: [], grants: [], entitlements, agent: { principalId, enablements: enablements.map(e => ({ ...e })) } };
}

export type AgentSwitchState =
  | { feature: AgentFeature; state: 'off' }
  | { feature: AgentFeature; state: 'attributed'; userId: string; eventId: string; at: Date }
  | { feature: AgentFeature; state: 'unattributed' };

/**
 * Each specialist's switch as of this transaction. The setting value comes from the caller's entitlement
 * snapshot (resolved in or before this transaction); attribution comes from the latest change event,
 * which an administrator or the agent itself may read (0672 `domain_event_agent_read`).
 */
export async function agentSwitchStatesTx(tx: Tx, ctx: SessionContext): Promise<AgentSwitchState[]> {
  const out: AgentSwitchState[] = [];
  for (const spec of AGENT_SPECIALISTS) {
    if (!SWITCHED_ON[spec.feature](ctx)) { out.push({ feature: spec.feature, state: 'off' }); continue; }
    const [last] = await tx.select({ id: schema.domainEvent.id, actorType: schema.domainEvent.actorType,
      actorId: schema.domainEvent.actorId, value: sql<unknown>`${schema.domainEvent.payload} -> 'value'`, at: schema.domainEvent.occurredAt })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, ctx.tenantId), eq(schema.domainEvent.eventType, 'tenant-setting.changed'),
        eq(schema.domainEvent.aggregateType, 'tenant-setting'), eq(schema.domainEvent.aggregateId, ctx.tenantId),
        sql`${schema.domainEvent.payload} ->> 'key' = ${spec.setting}`))
      .orderBy(desc(schema.domainEvent.occurredAt), desc(schema.domainEvent.sequence)).limit(1);
    out.push(last && last.actorType === 'user' && last.actorId && last.value === true
      ? { feature: spec.feature, state: 'attributed', userId: last.actorId, eventId: last.id, at: last.at }
      : { feature: spec.feature, state: 'unattributed' });
  }
  return out;
}

export const attributedEnablements = (states: readonly AgentSwitchState[]): AgentEnablement[] =>
  states.flatMap(s => s.state === 'attributed' ? [{ feature: s.feature, userId: s.userId, eventId: s.eventId }] : []);

/** True when this specialist runs under the principal: switched on, attributed, and attributed to the same
 *  switch-on event the run started with (switching off and on again mid-run ends the old authority). */
export async function agentSpecialistCurrentTx(tx: Tx, ctx: SessionContext, feature: AgentFeature): Promise<boolean> {
  if (!isAgentContext(ctx)) return false;
  const held = ctx.agent.enablements.find(e => e.feature === feature);
  if (!held) return false;
  const now = (await agentSwitchStatesTx(tx, ctx)).find(s => s.feature === feature);
  return now?.state === 'attributed' && now.eventId === held.eventId && now.userId === held.userId;
}

export const agentHolds = (ctx: SessionContext, feature: AgentFeature) =>
  isAgentContext(ctx) && ctx.agent.enablements.some(e => e.feature === feature);

/** The event actor: the principal for an agent context; otherwise the caller's previous choice. */
export const agentActor = (ctx: SessionContext): Actor => ({ type: 'agent', id: ctx.agent?.principalId });

/** Payload stamp required on every agent event (0672 `domain_event_agent_stamp`): the principal and the
 *  administrators' switch-on events this effect relies on. Absent for a non-agent context. */
export function agentStamp(ctx: SessionContext, features?: readonly AgentFeature[]) {
  if (!isAgentContext(ctx)) return {};
  const enabledBy = ctx.agent.enablements.filter(e => !features || features.includes(e.feature))
    .map(e => ({ feature: e.feature, userId: e.userId, eventId: e.eventId }));
  if (enabledBy.length === 0) throw new Error('Agent effect has no attributed switch.');
  return { agent: { principalId: ctx.agent.principalId, enabledBy } };
}
