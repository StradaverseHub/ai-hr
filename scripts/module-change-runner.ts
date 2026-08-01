/**
 * ADR-0077 slice 5 — the module change runner: the ONLY thing that writes `tenant_module`.
 *
 * ENV CONTRACT: MIGRATION_DATABASE_URL ONLY, exactly like scripts/provision-runner.ts and for the same
 * reason. `tenant_module` is SELECT-only to ai_hr_app by migration 0313 — "a customer may see what they
 * have, never grant it" — so the write needs the owner role, and the owner credential is deliberately
 * kept out of the web application. DATABASE_URL is not read.
 *
 *   node --import tsx scripts/module-change-runner.ts
 *
 * PER TICK: stale reclaim → claim one pending request → apply it in ONE transaction.
 *
 * NO HAND SQL AGAINST tenant_module, EVER. That is the rule this runner exists to make keepable: every
 * grant and every revocation leaves an intent row saying who asked and a chained event saying what
 * happened, including what was seeded and what was deliberately skipped.
 *
 * WHAT IT REFUSES, and why refusing beats warning:
 *   • a module whose `depends_on` are not all active for the tenant — activating Payroll for a tenant
 *     without its prerequisites produces a module that resolves ON and cannot work.
 *   • an activation with no `subscription_line` (D-15) — the entitlement is the technical half of a
 *     commercial fact, and granting one that nobody sold is how a customer ends up using something
 *     nobody is billing for.
 *   • a CORE module — 0313's trigger already rejects rows for core codes, and failing here names the
 *     reason instead of surfacing a trigger error.
 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { createDb, type Tx } from '../db/client';
import { appendEvent } from '../db/events';
import { activatorsFor, mergeOutcomes, type ActivationOutcome } from '../core/module-activation';
import { company, module_, moduleChangeRequest, subscriptionLine, tenantModule } from '../db/schema';

/** A runner killed mid-flight leaves an eternal 'running' row unless something reclaims it. */
const STALE_CLAIM_MINUTES = 10;

function loadEnv() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // env supplied directly
    }
  }
}

export class ModuleChangeRefused extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModuleChangeRefused';
  }
}

type Request = typeof moduleChangeRequest.$inferSelect;

/**
 * Everything that must hold before `tenant_module` is touched, checked in one place so a refusal
 * names its step. Throws ModuleChangeRefused; the caller records the step on the row.
 */
export async function assertActivatable(tx: Tx, req: Request): Promise<void> {
  const [mod] = await tx.select().from(module_).where(eq(module_.code, req.moduleCode)).limit(1);
  if (!mod) throw new ModuleChangeRefused('catalog', `no module '${req.moduleCode}' in the catalog`);

  // Core modules never carry rows — isModuleEnabled answers true for them from the pack catalog without
  // touching the database, and 0313's trigger enforces it. Say so here rather than let a trigger say it.
  if (mod.isCore) {
    throw new ModuleChangeRefused('core', `'${req.moduleCode}' is core: it is never granted per tenant`);
  }

  if (req.action === 'activate') {
    const deps = mod.dependsOn ?? [];
    if (deps.length > 0) {
      const active = await tx
        .select({ code: tenantModule.moduleCode })
        .from(tenantModule)
        .where(
          and(
            eq(tenantModule.tenantId, req.tenantId),
            inArray(tenantModule.moduleCode, deps),
            inArray(tenantModule.status, ['active', 'trial']),
          ),
        );
      const have = new Set(active.map((a) => a.code));
      const missing = deps.filter((d) => !have.has(d));
      if (missing.length > 0) {
        throw new ModuleChangeRefused('depends_on', `missing prerequisite module(s): ${missing.join(', ')}`);
      }
    }

    // D-15 — the grant must correspond to something sold. A billable module with no subscription line
    // is an entitlement nobody agreed to; a non-billable one legitimately has none.
    if (mod.billable) {
      const [line] = await tx
        .select({ id: subscriptionLine.id })
        .from(subscriptionLine)
        .where(and(eq(subscriptionLine.tenantId, req.tenantId), eq(subscriptionLine.moduleCode, req.moduleCode)))
        .limit(1);
      if (!line) {
        throw new ModuleChangeRefused(
          'subscription',
          `'${req.moduleCode}' is billable and this tenant has no subscription line for it`,
        );
      }
    }
  }
}

/**
 * Apply one request. ONE transaction: the entitlement, its seeding and its audit event commit or roll
 * back together, so a half-installed module is not a state the system can be left in.
 */
export async function applyModuleChange(tx: Tx, req: Request): Promise<ActivationOutcome> {
  await assertActivatable(tx, req);

  if (req.action === 'deactivate') {
    await tx
      .update(tenantModule)
      .set({ status: 'disabled' })
      .where(
        and(
          eq(tenantModule.tenantId, req.tenantId),
          eq(tenantModule.moduleCode, req.moduleCode),
          req.companyId ? eq(tenantModule.companyId, req.companyId) : isNull(tenantModule.companyId),
        ),
      );
    // Disabled means writes refused, reads and exports preserved (D-6). Nothing is deleted here: the
    // history a disabled module produced stays readable, which is the whole point of disabling rather
    // than removing.
    return { seeded: 0, skipped: 0, detail: ['entitlement set to disabled; no data removed'] };
  }

  // REACTIVATION IS NOT FIRST INSTALL (D4). An existing row is flipped back to active and the
  // activators still run — but every one of them writes ON CONFLICT DO NOTHING, so they report what
  // they skipped rather than reverting a customer's edits.
  const [existing] = await tx
    .select({ id: tenantModule.id })
    .from(tenantModule)
    .where(
      and(
        eq(tenantModule.tenantId, req.tenantId),
        eq(tenantModule.moduleCode, req.moduleCode),
        req.companyId ? eq(tenantModule.companyId, req.companyId) : isNull(tenantModule.companyId),
      ),
    )
    .limit(1);

  if (existing) {
    await tx.update(tenantModule).set({ status: 'active' }).where(eq(tenantModule.id, existing.id));
  } else {
    await tx.insert(tenantModule).values({
      tenantId: req.tenantId,
      moduleCode: req.moduleCode,
      companyId: req.companyId,
      status: 'active',
    });
  }

  // A tenant-wide grant installs into EVERY company; a scoped one into exactly the named company. The
  // activators never loop over companies themselves — that decision belongs here, once.
  const targets = req.companyId
    ? [{ id: req.companyId }]
    : await tx.select({ id: company.id }).from(company).where(eq(company.tenantId, req.tenantId));

  const outcomes: ActivationOutcome[] = [];
  for (const activator of activatorsFor(req.moduleCode)) {
    for (const target of targets) {
      outcomes.push(await activator({ tx, tenantId: req.tenantId, companyId: target.id }));
    }
  }
  const merged = mergeOutcomes(outcomes);
  return {
    ...merged,
    detail: [existing ? 'reactivation: existing configuration preserved' : 'first install', ...merged.detail],
  };
}

async function tick(): Promise<'idle' | 'done' | 'failed'> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('module-change-runner requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const owner = createDb(url);

  // Stale reclaim first: a row left 'running' by a killed runner would otherwise never be retried.
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000);
  await owner.db
    .update(moduleChangeRequest)
    .set({ status: 'pending', claimedAt: null })
    .where(and(eq(moduleChangeRequest.status, 'running'), or(isNull(moduleChangeRequest.claimedAt), lt(moduleChangeRequest.claimedAt, staleBefore))));

  const [claimed] = await owner.db
    .update(moduleChangeRequest)
    .set({ status: 'running', claimedAt: new Date() })
    .where(
      eq(
        moduleChangeRequest.id,
        sql`(select id from module_change_request where status = 'pending' order by created_at asc limit 1 for update skip locked)`,
      ),
    )
    .returning();

  if (!claimed) return 'idle';
  console.log(`claimed ${claimed.action} ${claimed.moduleCode} for tenant ${claimed.tenantId}`);

  try {
    const outcome = await owner.db.transaction(async (tx) => {
      const result = await applyModuleChange(tx as unknown as Tx, claimed);
      await appendEvent(tx as unknown as Tx, {
        tenantId: claimed.tenantId,
        aggregateType: 'tenant-module',
        aggregateId: claimed.id,
        eventType: `module.${claimed.action}d`,
        actor: { type: 'system' },
        payload: {
          moduleCode: claimed.moduleCode,
          companyId: claimed.companyId,
          requestedBy: claimed.requestedBy,
          seeded: result.seeded,
          skipped: result.skipped,
          detail: result.detail,
        },
      });
      await tx
        .update(moduleChangeRequest)
        .set({ status: 'done', currentStep: null, error: null, decidedAt: new Date() })
        .where(eq(moduleChangeRequest.id, claimed.id));
      return result;
    });
    console.log(`  ok — seeded ${outcome.seeded}, skipped ${outcome.skipped}`);
    for (const d of outcome.detail) console.log(`     ${d}`);
    return 'done';
  } catch (e) {
    const step = e instanceof ModuleChangeRefused ? e.step : 'apply';
    await owner.db
      .update(moduleChangeRequest)
      .set({ status: 'failed', currentStep: step, error: (e as Error).message, decidedAt: new Date() })
      .where(eq(moduleChangeRequest.id, claimed.id));
    console.error(`  refused at ${step}: ${(e as Error).message}`);
    return 'failed';
  }
}

if (process.argv[1]?.endsWith('module-change-runner.ts')) {
  loadEnv();
  tick()
    .then((r) => {
      if (r === 'idle') console.log('nothing pending');
      process.exit(r === 'failed' ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

export { tick };
