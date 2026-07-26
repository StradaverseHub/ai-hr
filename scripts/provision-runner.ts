/**
 * Tenant provisioning runner — the out-of-band half of the operator console.
 *
 * ENV CONTRACT: MIGRATION_DATABASE_URL ONLY.
 * ------------------------------------------
 * This process holds the OWNER role, which bypasses RLS, and that is the entire reason it exists as a
 * separate process: the web application must never be able to create a tenant (migration 0001), so the
 * credentials that can are kept out of it. DATABASE_URL is deliberately NOT read — after the seeder
 * transaction-injection refactor, no app-role service is called from here. The four existing sweeps
 * documented in DEPLOY.md 5b are the precedent for this shape.
 *
 * INSTALLED AS A ONE-MINUTE CRON TICK (DEPLOY.md 5b). Nothing in the app starts it; a customer is
 * therefore ready up to a minute after the click, which is the accepted UX. No websockets, no SSE — the
 * console polls. One request per tick, which is ample for a screen one human uses.
 *
 *   node --import tsx scripts/provision-runner.ts
 *
 * PER TICK, IN ORDER: stale reclaim → claim one → email pre-check → provision → reissue pass.
 */
import { createDb } from '../db/client';
import { ProvisionStepError, provisionTenant, INVITE_TTL_DAYS } from '../db/provision';
import { appendEvent } from '../db/events';
import { appInvitation, appUser, person, tenantProvisionRequest, tenantProvisionRequestModule } from '../db/schema';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';

/** A runner killed mid-flight leaves an eternal 'running' spinner unless something reclaims it. */
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

/**
 * Reclaim requests abandoned by a runner that died between claiming and committing (deploy restart,
 * OOM kill, host reboot). Without this a 'running' row spins forever with no exit and no way for the
 * operator to retry — the request is claimed, so no later tick will touch it.
 *
 * Safe because the claim COMMITS before provisioning starts and provisioning itself is one atomic
 * transaction: a row still 'running' after ten minutes either finished (and would have written its own
 * terminal state) or rolled back completely. There is no third state to corrupt.
 *
 * NOTE for the editable-scheduled-actions build: its "Run Now" pattern has this identical hole and
 * should adopt this same claimed_at rule rather than inventing a second mechanism (see the ADR).
 */
async function reclaimStale(db: ReturnType<typeof createDb>['db']): Promise<number> {
  const rows = await db
    .update(tenantProvisionRequest)
    .set({
      status: 'failed',
      error: 'provisioning interrupted, submit again',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tenantProvisionRequest.status, 'running'),
        sql`${tenantProvisionRequest.claimedAt} < now() - (${STALE_CLAIM_MINUTES} || ' minutes')::interval`,
      ),
    )
    .returning({ id: tenantProvisionRequest.id });
  return rows.length;
}

/**
 * Claim the oldest pending request, and COMMIT THAT CLAIM before any provisioning begins.
 *
 * FOR UPDATE SKIP LOCKED plus the outer `AND status = 'pending'` recheck makes an overlapping tick
 * harmless: a second runner started while this one is still working skips the locked row outright, and
 * even in the race where the lock has been released it re-tests the status and matches nothing.
 *
 * Committing first is what makes the stale reclaim above meaningful — a crash after this point leaves a
 * visible 'running' row with a claim stamp, rather than a pending row two runners could both grab.
 */
async function claimNext(
  db: ReturnType<typeof createDb>['db'],
): Promise<{ id: string; customerName: string; adminEmail: string; country: string; modules: string[] } | null> {
  const rows = await db
    .update(tenantProvisionRequest)
    .set({ status: 'running', claimedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tenantProvisionRequest.status, 'pending'),
        sql`${tenantProvisionRequest.id} = (
          select r.id from tenant_provision_request r
           where r.status = 'pending'
           order by r.created_at
           limit 1
           for update skip locked
        )`,
      ),
    )
    .returning({
      id: tenantProvisionRequest.id,
      customerName: tenantProvisionRequest.customerName,
      adminEmail: tenantProvisionRequest.adminEmail,
      // ADR-0077 slice 1: intake records the country and the picked modules, so the runner has to
      // SELECT them. Every hop in this chain previously dropped everything but name + email, so a
      // widened form alone would have changed nothing observable.
      country: tenantProvisionRequest.country,
    });
  const claimed = rows[0];
  if (!claimed) return null;
  const picked = await db
    .select({ moduleCode: tenantProvisionRequestModule.moduleCode })
    .from(tenantProvisionRequestModule)
    .where(eq(tenantProvisionRequestModule.requestId, claimed.id));
  return { ...claimed, modules: picked.map((p) => p.moduleCode) };
}

/**
 * ONE LOGIN, ONE CUSTOMER (for now) — enforced here because here is the only place that can see it.
 *
 * The web tier cannot run this check: tenant RLS confines it to its own tenant, and the collision is
 * inherently cross-tenant. Only the owner connection sees every tenant.
 *
 * This prevents a failure the console could never report. app.consume_invitation rebinds a real WorkOS
 * subject onto an app_user, and app_user.workos_user_id carries a GLOBAL unique index (0151). Let the
 * same address be the first admin of two customers and the second activation blows up on that index —
 * AFTER provisioning had already succeeded and reported done, at a moment no screen is watching. Far
 * better to refuse the request up front with a sentence the operator can act on.
 */
async function emailAlreadyUsed(
  db: ReturnType<typeof createDb>['db'],
  email: string,
): Promise<boolean> {
  const [existingUser] = await db
    .select({ id: appUser.id })
    .from(appUser)
    .innerJoin(person, eq(person.id, appUser.personId))
    .where(sql`lower(${person.primaryEmail}) = ${email}`)
    .limit(1);
  if (existingUser) return true;

  const [liveInvite] = await db
    .select({ id: appInvitation.id })
    .from(appInvitation)
    .where(
      and(
        sql`lower(${appInvitation.email}) = ${email}`,
        eq(appInvitation.status, 'pending'),
        sql`${appInvitation.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return Boolean(liveInvite);
}

/** Terminal failure write. Separate, tiny transaction — the provisioning one has already rolled back. */
async function markFailed(
  db: ReturnType<typeof createDb>['db'],
  id: string,
  currentStep: string | null,
  error: string,
): Promise<void> {
  await db
    .update(tenantProvisionRequest)
    .set({ status: 'failed', currentStep, error, updatedAt: new Date() })
    .where(eq(tenantProvisionRequest.id, id));
}

/**
 * Provision one claimed request.
 *
 * THE TENANT ROWS AND THE TERMINAL 'done' STATE COMMIT IN THE SAME TRANSACTION. That is not tidiness,
 * it closes a real hole: tenant.name has no unique constraint, so if provisioning committed and the
 * status write happened afterwards, a crash in between would leave a real tenant whose activation URL
 * was lost and whose request still read 'pending' — and the next tick would cheerfully provision a
 * SECOND tenant for the same customer. The request table is tenant-free, so the owner can write both
 * halves in one go and that window does not exist.
 */
async function provisionOne(
  owner: ReturnType<typeof createDb>,
  req: { id: string; customerName: string; adminEmail: string; country: string; modules: string[] },
): Promise<void> {
  if (await emailAlreadyUsed(owner.db, req.adminEmail)) {
    await markFailed(
      owner.db,
      req.id,
      null,
      `${req.adminEmail} already has a login or a pending invitation. One email address can be the first admin of only one customer.`,
    );
    return;
  }

  try {
    await owner.db.transaction(async (tx) => {
      const result = await provisionTenant(tx, {
        name: req.customerName,
        adminEmail: req.adminEmail,
        country: req.country,
        modules: req.modules,
      });
      await tx
        .update(tenantProvisionRequest)
        .set({
          status: 'done',
          tenantId: result.tenantId,
          activationUrl: result.activationUrl,
          currentStep: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(tenantProvisionRequest.id, req.id));
    });
    // The URL is NEVER logged — it is a bearer credential, and this runner's output goes to a cron log.
    console.log(`✓ provisioned "${req.customerName}" (request ${req.id})`);
  } catch (e) {
    const stepErr = e instanceof ProvisionStepError ? e : null;
    const stepKey = stepErr?.step ?? null;
    await markFailed(owner.db, req.id, stepKey, e instanceof Error ? e.message : String(e));
    console.error(`✗ request ${req.id} failed at step ${stepKey ?? 'unknown'}: ${String(e)}`);
  }
}

/**
 * Reissue pass — a fresh activation link for a customer whose link was lost or expired.
 *
 * Without this, a link revealed and then mislaid strands the customer behind the hand-run CLI that this
 * whole feature exists to eliminate. Matches 'done' rows that asked for a reissue AND have no live URL,
 * so a pending unrevealed link is never silently swapped underneath the operator.
 *
 * Revoking the previous pending invitations is what makes the OLD token stop working — app_invitation
 * is single-use via consume_invitation's `status = 'pending'` guard, so flipping status to 'revoked'
 * is sufficient and needs no token knowledge.
 */
async function reissuePass(owner: ReturnType<typeof createDb>): Promise<number> {
  const due = await owner.db
    .select({
      id: tenantProvisionRequest.id,
      tenantId: tenantProvisionRequest.tenantId,
      adminEmail: tenantProvisionRequest.adminEmail,
    })
    .from(tenantProvisionRequest)
    .where(
      and(
        eq(tenantProvisionRequest.status, 'done'),
        isNotNull(tenantProvisionRequest.reissueRequestedAt),
        isNull(tenantProvisionRequest.activationUrl),
        isNotNull(tenantProvisionRequest.tenantId),
      ),
    );

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  let n = 0;
  for (const row of due) {
    const tenantId = row.tenantId!;
    await owner.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ personId: appUser.personId })
        .from(appUser)
        .innerJoin(person, eq(person.id, appUser.personId))
        .where(and(eq(appUser.tenantId, tenantId), sql`lower(${person.primaryEmail}) = ${row.adminEmail}`))
        .limit(1);

      await tx
        .update(appInvitation)
        .set({ status: 'revoked' })
        .where(
          and(
            eq(appInvitation.tenantId, tenantId),
            sql`lower(${appInvitation.email}) = ${row.adminEmail}`,
            eq(appInvitation.status, 'pending'),
          ),
        );

      const raw = randomBytes(32).toString('base64url');
      const [inv] = await tx
        .insert(appInvitation)
        .values({
          tenantId,
          companyId: null,
          email: row.adminEmail,
          role: 'hr_admin',
          personId: target?.personId ?? null,
          tokenHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
          status: 'pending',
          expiresAt: sql`now() + (${INVITE_TTL_DAYS} || ' days')::interval`,
          createdBy: null,
        })
        .returning({ id: appInvitation.id });

      await appendEvent(tx, {
        tenantId,
        aggregateType: 'app-invitation',
        aggregateId: inv.id,
        eventType: 'app-user.invited',
        actor: { type: 'system' },
        payload: { email: row.adminEmail, role: 'hr_admin', companyId: null, via: 'provision-reissue' },
      });

      await tx
        .update(tenantProvisionRequest)
        .set({
          activationUrl: baseUrl ? `${baseUrl}/invite/${raw}` : `/invite/${raw}`,
          reissueRequestedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tenantProvisionRequest.id, row.id));
    });
    n += 1;
    console.log(`✓ reissued activation link for request ${row.id}`);
  }
  return n;
}

/** One tick. Exported so tests drive the exact production path rather than a reimplementation. */
export async function runProvisionTick(owner: ReturnType<typeof createDb>): Promise<{
  reclaimed: number;
  provisioned: boolean;
  reissued: number;
}> {
  const reclaimed = await reclaimStale(owner.db);
  const claimed = await claimNext(owner.db);
  if (claimed) await provisionOne(owner, claimed);
  const reissued = await reissuePass(owner);
  return { reclaimed, provisioned: Boolean(claimed), reissued };
}

async function main() {
  loadEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('\n✗ MIGRATION_DATABASE_URL is not set (run this from /opt/ai-hr on the server).\n');
    process.exit(1);
  }
  const owner = createDb(url, { max: 2 });
  try {
    const r = await runProvisionTick(owner);
    if (r.reclaimed) console.log(`· reclaimed ${r.reclaimed} stale request(s)`);
    if (!r.provisioned && !r.reclaimed && !r.reissued) console.log('· nothing to do');
  } finally {
    await owner.client.end({ timeout: 5 });
  }
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('provision-runner.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
