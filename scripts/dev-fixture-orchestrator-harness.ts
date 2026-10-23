/**
 * Fictional Control Tower walkthrough foundation; preparation is not acceptance evidence.
 * Run only after BOTH board handovers, under both test slots and the shared DB lock. Requires an
 * already migrated/seeded ai_hr_orchestrator_browser on localhost:5433 and namespace orchbrowser23.
 * Completed reruns only read the fixture: browser edits and later receipts are preserved.
 */
import { demoSeedRefusal, DEMO_TENANT_ID, SYSTEM_TENANT_ID } from '../db/seed-guard';
import { demoSwitcherEnabled } from '../lib/demo-mode';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { SessionContext } from '../db/client';

const refusal = demoSeedRefusal(process.env);
if (refusal) throw new Error(refusal);
if (process.env.NODE_ENV === 'production' || !demoSwitcherEnabled() || process.env.TEST_DB_NAMESPACE !== 'orchbrowser23') {
  throw new Error('Orchestrator fixture requires its local demo namespace.');
}
const urls = [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL].map(raw => {
  const url = new URL(raw ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.port !== '5433' || url.pathname !== '/ai_hr_orchestrator_browser' || url.search || url.hash) {
    throw new Error('Only the named disposable orchestrator database is allowed.');
  }
  return url;
});
if (decodeURIComponent(urls[0].username) !== 'ai_hr_app' || urls[0].username === urls[1].username) {
  throw new Error('The fixture requires separate app and migration roles.');
}

type Actor = { key: string; userId: string; personId: string | null; companyId: string | null };
type Fixture = { version: 1; tenantId: string; companies: Record<string, string>; actors: Actor[] };
const eventType = 'dev.orchestrator-harness.fixture-prepared';

async function main() {
  // Runtime/database imports follow the local-only guard, so a refused invocation opens no pool.
  const { and, asc, eq, isNull } = await import('drizzle-orm');
  const { createDb, client } = await import('../db/client');
  const s = await import('../db/schema');
  const { appendEvent, actorOf } = await import('../db/events');
  const { resolveEntitlementsTx, settingEnabled } = await import('../core/entitlements');
  const { createCompany, createDepartment, assignRole } = await import('../core/admin');
  const { hireEmployee } = await import('../core/org');
  const { runHrOrchestrator, orchestrationQueue } = await import('../core/hr-orchestrator');
  const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
  const tenantId = DEMO_TENANT_ID;
  const lock = await owner.client.reserve();
  try {
    await lock`select pg_advisory_lock(hashtextextended('orchestrator-browser-fixture', 0))`;
    const tenants = await owner.db.select({ id: s.tenant.id }).from(s.tenant);
    if (!tenants.some(row => row.id === tenantId) || tenants.some(row => row.id !== tenantId && row.id !== SYSTEM_TENANT_ID)) {
      throw new Error('Only seeded demo and reserved system tenants are allowed.');
    }
    async function context(user: { id: string; personId: string | null }): Promise<SessionContext> {
      const grants = await owner.db.select({ role: s.roleAssignment.role, companyId: s.roleAssignment.companyId })
        .from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId, tenantId), eq(s.roleAssignment.appUserId, user.id)));
      return { tenantId, userId: user.id, personId: user.personId, grants, roles: [...new Set(grants.map(row => row.role))],
        entitlements: await owner.db.transaction(tx => resolveEntitlementsTx(tx, tenantId)) };
    }
    const [bootstrapUser] = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId),
      eq(s.appUser.workosUserId, 'user_dev_admin'), isNull(s.appUser.archivedAt)));
    if (!bootstrapUser) throw new Error('Seeded demo administrator missing.');
    const root = await context(bootstrapUser);
    if (!root.grants?.some(grant => grant.companyId === null && ['hr_admin', 'super_admin'].includes(grant.role))) {
      throw new Error('Seeded administrator lacks its actual group authority.');
    }
    function requireSpecialistsOff(ctx: SessionContext) {
      if (settingEnabled(ctx, 'notifications.readiness_nudge_enabled') || settingEnabled(ctx, 'claims.input_triage_enabled')) {
        throw new Error('Model-using specialists must already be off. The fixture does not change switches.');
      }
    }
    requireSpecialistsOff(root);
    async function manifest(fixture: Fixture, reused: boolean) {
      const views = [];
      for (const actor of fixture.actors.filter(row => row.key.endsWith('-hr') || row.key === 'group-admin')) {
        const view = await orchestrationQueue(await context({ id: actor.userId, personId: actor.personId }));
        views.push({ actor: actor.key, open: view.total, verified: view.verified, observedAt: view.observedAt, lastRun: view.lastRun });
      }
      console.log(JSON.stringify({ preparationOnly: true, reused, ...fixture, views,
        routes: ['/control-tower', '/control-tower/agents'], locales: ['en', 'ms', 'zh', 'vi', 'th', 'ta'] }, null, 2));
    }
    const [receipt] = await owner.db.select({ payload: s.domainEvent.payload }).from(s.domainEvent)
      .where(and(eq(s.domainEvent.tenantId, tenantId), eq(s.domainEvent.aggregateId, tenantId), eq(s.domainEvent.eventType, eventType)))
      .orderBy(asc(s.domainEvent.sequence)).limit(1);
    if (receipt) {
      const fixture = receipt.payload as unknown as Fixture;
      if (fixture.version !== 1 || fixture.tenantId !== tenantId || !fixture.companies || !Array.isArray(fixture.actors)
        || fixture.actors.length !== 6) throw new Error('Stored fixture is incompatible; preserving it.');
      await manifest(fixture, true);
      return;
    }
    const fixture: Fixture = { version: 1, tenantId, companies: {},
      actors: [{ key: 'group-admin', userId: bootstrapUser.id, personId: bootstrapUser.personId, companyId: null }] };
    for (const key of ['A', 'B', 'Empty']) {
      const code = `ORCH23-${key}`, name = `Fictional Lantern ${key} Sdn Bhd`;
      const companies = await owner.db.select().from(s.company).where(and(eq(s.company.tenantId, tenantId), eq(s.company.companyLabel, code)));
      if (companies.length > 1) throw new Error('Ambiguous fixture company code; preserving existing records.');
      let company = companies[0];
      if (!company) {
        const created = await createCompany(root, { legalName: name, companyLabel: code, country: 'MY', currency: 'MYR' });
        [company] = await owner.db.select().from(s.company).where(eq(s.company.id, created.id));
      }
      if (!company || company.archivedAt || company.legalName !== name) throw new Error('Fixture company changed; preserving it.');
      fixture.companies[key] = company.id;
      const actorInputs: { key: string; personId: string | null; role: 'hr_admin' | 'employee' }[] = [
        { key: `${key}-hr`, personId: null, role: 'hr_admin' },
      ];
      if (key !== 'Empty') {
        const departmentName = `Fictional orchestration team ${key}`;
        let [department] = await owner.db.select().from(s.department).where(and(eq(s.department.tenantId, tenantId),
          eq(s.department.companyId, company.id), eq(s.department.name, departmentName)));
        if (!department) {
          const created = await createDepartment(root, { companyId: company.id, name: departmentName });
          [department] = await owner.db.select().from(s.department).where(eq(s.department.id, created.id));
        }
        if (!department || department.archivedAt) throw new Error('Fixture department changed; preserving it.');
        const email = `orchestrator23-${key.toLowerCase()}@example.invalid`;
        let [person] = await owner.db.select().from(s.person).where(and(eq(s.person.tenantId, tenantId), eq(s.person.primaryEmail, email)));
        if (!person) {
          const created = await hireEmployee(root, { person: { fullName: `Orchestration fictional employee ${key}`, primaryEmail: email },
            companyId: company.id, departmentId: department.id, employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
          [person] = await owner.db.select().from(s.person).where(eq(s.person.id, created.personId));
        }
        const employments = await owner.db.select().from(s.employment).where(and(eq(s.employment.personId, person.id), eq(s.employment.companyId, company.id)));
        if (employments.length !== 1 || employments[0].terminatedOn || employments[0].blacklistedAt) {
          throw new Error('Fixture employment changed or creation is incomplete; preserving it.');
        }
        actorInputs.push({ key: `${key}-employee`, personId: person.id, role: 'employee' });
      }
      for (const input of actorInputs) {
        const login = `orchestrator23-fixture:${input.key}`;
        let [user] = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, login)));
        if (!user) [user] = await owner.db.insert(s.appUser).values({ tenantId, personId: input.personId, workosUserId: login, onboardedAt: new Date() }).returning();
        if (!user || user.archivedAt || user.personId !== input.personId) throw new Error('Fixture login changed; preserving it.');
        const companyId = input.role === 'hr_admin' ? company.id : null;
        const grants = await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId, user.id));
        if (!grants.length) await assignRole(root, { appUserId: user.id, role: input.role, ...(companyId ? { companyId } : {}) });
        else if (grants.length !== 1 || grants[0].role !== input.role || grants[0].companyId !== companyId) throw new Error('Fixture grants changed; preserving them.');
        fixture.actors.push({ key: input.key, userId: user.id, personId: input.personId, companyId: company.id });
      }
    }
    for (const actor of fixture.actors.filter(row => row.key.endsWith('-hr') || row.key === 'group-admin')) {
      const ctx = await context({ id: actor.userId, personId: actor.personId });
      requireSpecialistsOff(ctx);
      const run = await runHrOrchestrator(ctx);
      if (run.failed || run.nudge.status !== 'succeeded' || !run.nudge.value.disabled || run.triage.status !== 'succeeded' || !run.triage.value.disabled) {
        throw new Error('Fixture pass did not complete with specialists off. No completion marker saved.');
      }
    }
    await owner.withTenant(root, tx => appendEvent(tx, { tenantId, aggregateType: 'dev_fixture', aggregateId: tenantId,
      eventType, actor: actorOf(root), payload: fixture }));
    await manifest(fixture, false);
  } finally {
    await lock`select pg_advisory_unlock(hashtextextended('orchestrator-browser-fixture', 0))`;
    lock.release();
    await owner.client.end();
    await client.end();
  }
}

// Explicit exit also closes any service-owned pool; the permitted walkthrough must prove two clean exits.
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
