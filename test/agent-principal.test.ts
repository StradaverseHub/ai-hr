/**
 * ADR-0151 §4.5 (amendment 2026-10-29, migration 0672) — the named agent principal that replaced the
 * nightly orchestrator's anonymous group-wide hr_admin context.
 *
 *  1. It is never an administrator or a person: no grant, no login, and the database refuses the mix.
 *  2. Another tenant's principal (or an invented one) is nothing in this tenant.
 *  3. It runs a specialist only behind an administrator's switch-on, and only the CURRENT one.
 *  4. Every effect it writes names the principal and that administrator; anything else is refused.
 *  5. Duplicate delivery of a pass produces one reminder, not two.
 *  6. It sees that a correction is pending without reading what the correction says.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import { captureAiReviewScreenshots } from './helpers/ai-review-screenshots';
const copies = { en, ms, zh, vi: viCopy, th, ta };
const visual = vi.hoisted(() => ({ locale: 'en' as 'en'|'ms'|'zh'|'vi'|'th'|'ta' }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: visual.locale, messages: copies[visual.locale], namespace }),
  getFormatter: async () => createFormatter({ locale: visual.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('../app/(app)/control-tower/orchestrator-actions', () => ({ refreshOrchestrationAction: vi.fn() }));
import { OrchestrationWorkQueue } from '../app/(app)/control-tower/work-queue';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { resolveEntitlementsTx } from '../core/entitlements';
import { sweepReadinessNudges, NUDGE_SETTING_KEY } from '../core/readiness-nudge';
import { triagePendingClaims, TRIAGE_SETTING_KEY } from '../core/input-triage';
import { orchestrationQueue, runHrOrchestrator } from '../core/hr-orchestrator';
import { agentContext, agentSwitchStatesTx, attributedEnablements, ensureAgentPrincipal } from '../core/agent-principal';
import { agentStatuses } from '../core/control-domains';
import { adminCtx, entitledCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

/** The Postgres text through Drizzle's wrapper, so a refusal is proven to be RLS and not a fixture error. */
function pgText(e: unknown): string {
  const parts: string[] = [];
  for (let cur = e as Record<string, unknown> | undefined, n = 0; cur && typeof cur === 'object' && n < 5; cur = cur.cause as never, n++) {
    for (const k of ['message', 'detail']) if (typeof cur[k] === 'string') parts.push(cur[k] as string);
  }
  return parts.join(' | ');
}
async function rlsRefused(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal').not.toBeNull();
  expect(pgText(err)).toMatch(/row-level security/i);
}

describe('ADR-0151 §4.5 — named agent principal', () => {
  let base: Base;
  let seq = 0;
  beforeAll(migrateTestDb);
  beforeEach(async () => { await resetDb(); base = await seedBase(); seq = 0; });
  afterAll(closeAll);

  /** An administrator switches a specialist on: the setting plus the change event setTenantSetting writes. */
  async function switchEvent(key: string, value: boolean, userId: string | null = base.adminUserId) {
    const [row] = await owner.db.insert(schema.domainEvent).values({ tenantId: base.tenantId, aggregateType: 'tenant-setting',
      aggregateId: base.tenantId, eventType: 'tenant-setting.changed', actorType: userId ? 'user' : 'system', actorId: userId,
      payload: { key, value } }).returning({ id: schema.domainEvent.id });
    await setSetting(base.tenantId, key, value);
    return row.id;
  }
  async function agent(): Promise<SessionContext> {
    const principalId = await ensureAgentPrincipal(owner.db, base.tenantId);
    const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, base.tenantId));
    const bare = agentContext(base.tenantId, principalId, entitlements);
    const enablements = attributedEnablements(await withTenant(bare, tx => agentSwitchStatesTx(tx, bare)));
    return agentContext(base.tenantId, principalId, entitlements, enablements);
  }
  async function personMissingBank() {
    const a = adminCtx(base);
    seq++;
    const e = await hireEmployee(a, {
      person: { fullName: `Agent fixture ${seq}`, primaryEmail: `agent.${seq}@aa.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
      paymentMethod: 'bank_transfer',
    } as never);
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `90010101${String(6000 + seq)}`,
      epfNumber: `EPF${6000 + seq}`, socsoNumber: `SOC${6000 + seq}`, taxNumber: `SG${6000 + seq}` } as never);
    return e;
  }
  const nudges = () => owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'readiness.nudge-raised'));

  it('holds no administrator or person authority, and the database refuses a mixed context', async () => {
    const e = await personMissingBank();
    const ctx = await agent();
    const seen = await withTenant(ctx, async tx => {
      const [flags] = await tx.execute<{ admin: boolean; principal: string | null }>(sql`select app.is_admin() as admin, app.current_agent_principal() as principal`);
      return {
        ...flags,
        statutory: (await tx.select().from(schema.employeeStatutoryMy)).length,
        compensation: (await tx.select().from(schema.compensation)).length,
        person: (await tx.select().from(schema.person)).length,
        employment: (await tx.select({ id: schema.employment.id }).from(schema.employment)).length,
      };
    });
    expect(seen).toMatchObject({ admin: false, principal: ctx.agent!.principalId, statutory: 0, compensation: 0, person: 0 });
    // Non-vacuous: the same rows exist, and the employment directory it does need is visible.
    expect(seen.employment).toBeGreaterThan(0);
    expect((await owner.db.select().from(schema.compensation)).length).toBeGreaterThan(0);
    // An administrator write affects nothing and an insert is refused.
    const updated = await withTenant(ctx, tx => tx.update(schema.employment).set({ employeeCode: 'AGENT' })
      .where(eq(schema.employment.id, e.employmentId)).returning({ id: schema.employment.id }));
    expect(updated).toHaveLength(0);
    const [pay] = await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId, e.employmentId));
    await rlsRefused(withTenant(ctx, tx => tx.insert(schema.compensation).values({ ...pay, id: crypto.randomUUID(), effectiveFrom: '2025-01-01' } as never)));
    // A login or any grant on an agent context is refused before a transaction opens.
    await expect(withTenant({ ...ctx, userId: base.adminUserId }, async () => 1)).rejects.toThrow(/agent context/);
    await expect(withTenant({ ...ctx, roles: ['hr_admin'], grants: undefined }, async () => 1)).rejects.toThrow(/agent context/);
  });

  it("another tenant's principal, or an invented one, is nothing in this tenant", async () => {
    await personMissingBank();
    const [other] = await owner.db.insert(schema.tenant).values({ workosOrgId: `org_agent_other_${Date.now()}`, name: 'Other tenant' } as never)
      .returning({ id: schema.tenant.id });
    const foreign = await ensureAgentPrincipal(owner.db, other.id);
    const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, base.tenantId));
    for (const principalId of [foreign, crypto.randomUUID()]) {
      const ctx = agentContext(base.tenantId, principalId, entitlements);
      const [row] = await withTenant(ctx, tx => tx.execute<{ principal: string | null }>(sql`select app.current_agent_principal() as principal`));
      expect(row.principal).toBeNull();
      expect(await withTenant(ctx, tx => tx.select({ id: schema.employment.id }).from(schema.employment))).toHaveLength(0);
      await expect(withTenant(ctx, tx => tx.execute(sql`select * from app.agent_readiness_presence(null)`))).rejects.toThrow();
    }
  });

  it('runs a specialist only behind an attributed switch-on, and only the current one', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    await personMissingBank();
    // Switched on by the platform (no administrator event): unattributed, so nothing runs.
    await setSetting(base.tenantId, NUDGE_SETTING_KEY, true);
    let ctx = await agent();
    expect(ctx.agent!.enablements).toHaveLength(0);
    expect(await sweepReadinessNudges(ctx)).toMatchObject({ disabled: true, sent: 0 });
    // An older switch-on is not proof once it was switched off: the latest event decides.
    await switchEvent(NUDGE_SETTING_KEY, true);
    await switchEvent(NUDGE_SETTING_KEY, false);
    await setSetting(base.tenantId, NUDGE_SETTING_KEY, true);
    ctx = await agent();
    expect(ctx.agent!.enablements).toHaveLength(0);
    // A real switch-on attributes it.
    const eventId = await switchEvent(NUDGE_SETTING_KEY, true);
    ctx = await agent();
    expect(ctx.agent!.enablements).toEqual([{ feature: 'readiness_reminders', userId: base.adminUserId, eventId }]);
    // Switched off and on again after the run started: the run's authority ended (stale source).
    await switchEvent(NUDGE_SETTING_KEY, false);
    await switchEvent(NUDGE_SETTING_KEY, true);
    const stale = await sweepReadinessNudges(ctx);
    expect(stale).toMatchObject({ sent: 0 });
    expect(stale.changed).toBeGreaterThan(0);
    expect(await nudges()).toHaveLength(0);
    // Non-vacuous: the current switch-on sends it.
    expect((await sweepReadinessNudges(await agent())).sent).toBe(1);
  });

  it('stamps every effect with the principal and the administrator, and refuses anything else', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    const e = await personMissingBank();
    const eventId = await switchEvent(NUDGE_SETTING_KEY, true);
    const ctx = await agent();
    const run = await runHrOrchestrator(ctx);
    expect(run.failed).toBe(false);
    const written = await owner.db.select().from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, base.tenantId), sql`${schema.domainEvent.eventType} <> 'tenant-setting.changed'`,
        sql`${schema.domainEvent.occurredAt} >= now() - interval '1 hour'`, sql`${schema.domainEvent.actorType} = 'agent'`));
    const types = new Set(written.map(w => w.eventType));
    expect(types.has('readiness.nudge-raised')).toBe(true);
    expect(types.has('orchestrator.pass-finished')).toBe(true);
    for (const w of written) {
      expect(w.actorId).toBe(ctx.agent!.principalId);
      expect((w.payload as { agent: unknown }).agent).toEqual({ principalId: ctx.agent!.principalId,
        enabledBy: [{ feature: 'readiness_reminders', userId: base.adminUserId, eventId }] });
    }
    // The database refuses an agent-context event that is unstamped, out of list, or claims a user.
    const stamp = { agent: { principalId: ctx.agent!.principalId, enabledBy: [{ feature: 'readiness_reminders', userId: base.adminUserId, eventId }] } };
    const attempt = (actor: { actorType: 'agent' | 'user'; actorId: string | null }, eventType: string, payload: unknown) =>
      withTenant(ctx, tx => tx.insert(schema.domainEvent).values({ tenantId: base.tenantId, aggregateType: 'employment',
        aggregateId: e.employmentId, eventType, ...actor, subjectEmploymentId: e.employmentId, payload }));
    await rlsRefused(attempt({ actorType: 'agent', actorId: ctx.agent!.principalId }, 'readiness.nudge-raised', { gap: 'no_bank_account' }));
    await rlsRefused(attempt({ actorType: 'agent', actorId: ctx.agent!.principalId }, 'employment.updated', stamp));
    await rlsRefused(attempt({ actorType: 'user', actorId: base.adminUserId }, 'readiness.nudge-raised', stamp));
    await rlsRefused(attempt({ actorType: 'agent', actorId: crypto.randomUUID() }, 'readiness.nudge-raised', stamp));
    // Non-vacuous: the stamped, listed form is accepted.
    await attempt({ actorType: 'agent', actorId: ctx.agent!.principalId }, 'readiness.nudge-raised', stamp);
    // Its proposals are reminder proposals only, with no human decider.
    await rlsRefused(withTenant(ctx, tx => tx.insert(schema.agentProposal).values({ id: crypto.randomUUID(), tenantId: base.tenantId,
      proposalType: 'input_triage', inputDigest: 'x', proposal: {}, adjudication: 'accepted' } as never)));
  });

  it('a duplicate pass delivers one reminder', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    await personMissingBank();
    await switchEvent(NUDGE_SETTING_KEY, true);
    const ctx = await agent();
    const [a, b] = await Promise.all([sweepReadinessNudges(ctx), sweepReadinessNudges(ctx)]);
    expect(a.sent + b.sent).toBe(1);
    expect(await nudges()).toHaveLength(1);
  });

  it('sees a pending correction without reading it, and stops chasing that person', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    const e = await personMissingBank();
    await switchEvent(NUDGE_SETTING_KEY, true);
    await owner.db.insert(schema.profileChangeRequest).values({ tenantId: base.tenantId, employmentId: e.employmentId,
      personId: e.personId, proposed: { bankName: 'Maybank', bankAccountNo: '1234567890' } } as never);
    const ctx = await agent();
    // The values are not readable to it even though the request is.
    expect(await withTenant(ctx, tx => tx.select().from(schema.profileChangeRequest))).toHaveLength(0);
    const [row] = await withTenant(ctx, tx => tx.execute<{ legacy_keys: string[] }>(
      sql`select legacy_keys from app.agent_pending_profile_corrections(array[${e.employmentId}::uuid])`));
    expect([...row.legacy_keys].sort()).toEqual(['bankAccountNo', 'bankName']);
    const res = await sweepReadinessNudges(ctx);
    expect(res).toMatchObject({ sent: 0, awaitingReview: 1 });
    expect(await nudges()).toHaveLength(0);
  });

  it('shows scheduled execution metadata to company HR while keeping cases and counts in their scope', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    await personMissingBank();
    const [foreignCompany] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional other company' }).returning({ id: schema.company.id });
    const [foreignPerson] = await owner.db.insert(schema.person).values({ tenantId: base.tenantId, fullName: 'Foreign Company Fixture', primaryEmail: 'other.company.fixture@example.test' }).returning({ id: schema.person.id });
    await owner.db.insert(schema.employment).values({ tenantId: base.tenantId, personId: foreignPerson.id, companyId: foreignCompany.id, hiredOn: '2024-01-01' });
    await switchEvent(NUDGE_SETTING_KEY, true);
    const ctx = await agent();
    await runHrOrchestrator(ctx);
    const group = await orchestrationQueue(adminCtx(base));
    const scoped = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    const company = await orchestrationQueue(scoped);
    expect(group.lastRun?.failed).toBe(false);
    expect(company.lastRun).toEqual(group.lastRun);
    expect(company.observedAt).toEqual(group.observedAt);
    expect(company.scheduledRun).toBe(true);
    expect(company.total).toBeGreaterThan(0);
    expect(group.total).toBeGreaterThan(company.total);
    expect(company.rows.some(r => r.name === 'Foreign Company Fixture')).toBe(false);
    expect(company.rows.every(r => r.company === 'Acme Sdn Bhd')).toBe(true);
    const unassigned = { ...scoped, grants: [{ role: 'hr_admin', companyId: crypto.randomUUID() }] };
    const empty = await orchestrationQueue(unassigned);
    expect(empty.rows).toEqual([]);
    expect(empty.total).toBe(0);
    // Only execution status is tenant-wide, never the other companies' work counts or people.
    expect(empty.lastRun).toEqual(company.lastRun);
    const other = await seedBase();
    expect((await orchestrationQueue(adminCtx(other))).lastRun).toBeNull();
    expect(JSON.stringify(company.lastRun)).not.toContain(ctx.agent!.principalId);
    // Render the real view returned after this fixture's scheduled pass, for both administrative scopes.
    for (const locale of Object.keys(copies) as (keyof typeof copies)[]) {
      visual.locale = locale;
      for (const [role, view] of [['group', group], ['company', company]] as const) {
        const element = await OrchestrationWorkQueue({ view, canViewRuns: role === 'group' });
        const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale, messages: copies[locale], children: element }));
        expect(html).not.toContain(copies[locale].controlTower.orchestrator.unobserved);
        if (role === 'company') expect(html).not.toContain('Foreign Company Fixture');
        await captureAiReviewScreenshots(html.replace('<details class=', '<details open class='), locale,
          role === 'group' ? 'scheduled-group' : 'scheduled-company', 'real component and scoped service read model after named scheduled fixture pass; no authenticated server journey');
      }
    }
  }, 120000);

  it('reports fixed-template reminders and never reports scheduled models as active', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    await setModule(base.tenantId, 'claims', 'active');
    await setModule(base.tenantId, 'payroll', 'active');
    await switchEvent(NUDGE_SETTING_KEY, true);
    await switchEvent(TRIAGE_SETTING_KEY, true);
    await setSetting(base.tenantId, 'payroll.anomaly_hypotheses_enabled', true);
    const roster = await agentStatuses(await entitledCtx(base));
    expect(roster.find(r => r.id === 'nudge')).toMatchObject({ kind: 'deterministic', active: true, reasonKey: 'nudgeTemplates' });
    for (const id of ['hypotheses', 'triage']) expect(roster.find(r => r.id === id))
      .toMatchObject({ active: false, reasonKey: 'scheduledModelNotAdmitted' });
  });

  it('triage under the principal reads no claim and is not admitted to a model', async () => {
    await setModule(base.tenantId, 'claims', 'active');
    expect(await triagePendingClaims(await agent())).toMatchObject({ disabled: true });
    await switchEvent(TRIAGE_SETTING_KEY, true);
    expect(await triagePendingClaims(await agent())).toMatchObject({ disabled: false, notConfigured: true, modelBlockReason: 'principal_not_admitted', candidates: 0, asked: 0 });
  });
});
