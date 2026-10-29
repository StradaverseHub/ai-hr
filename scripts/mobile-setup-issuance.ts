/**
 * Automatic mobile workplace setup issuance (ADR-0161) — the owner-role half, run ONLY by the
 * provisioning runner (scripts/provision-runner.ts). Two entry points:
 *
 *   • issueMobileSetup — right after a customer's provisioning commits 'done' (tenant and organization
 *     code exist), and for each customer the pass below finds due.
 *   • mobileSetupPass  — once per tick: issues for an active embedded-sign-in customer with no usable
 *     setup, renews one inside its 30-day window, reissues after this installation's address changed,
 *     and retries a failed attempt after an hour. Bounded per tick.
 *
 * Both do nothing unless this installation is configured to sign (AIHR_MOBILE_SETUP_SIGNING_KEY). An
 * installation without the key — a customer-run on-premise server — never issues; it holds a setup that
 * Stradaverse signed and that was imported. Issuance failure NEVER fails provisioning: the reason code is
 * recorded beside the previous setup and the attempt is retried later.
 *
 * Never logged or recorded: key material, the key path, the signed payload.
 */
import type { KeyObject } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { createDb, Tx } from '../db/client';
import { appendEvent } from '../db/events';
import { tenant, tenantSetting } from '../db/schema';
import { internalConfig, internalSelected } from '../lib/internal-auth/config';
import { readRecord } from '../lib/internal-auth/record-store';
import type { Organization } from '../lib/internal-auth/service';
import { INSTALLED_APP_TRUST } from '../lib/mobile-trust-anchors';
import {
  WorkplaceSetupSignerError, approvedAnchor, loadSigningKey, setupHosting, signCompanyProfile, workplaceProfile,
} from '../lib/mobile-workplace-setup-signer';
import { WorkplaceSetupRefusal, verifySignedSetup, verifyWorkplaceSetup } from '../lib/mobile-workplace-setup-verify';
import { MOBILE_SETUP_SETTING_KEY, parseStoredSetup, type StoredWorkplaceSetup } from '../lib/mobile-workplace-setup-record';

type Owner = ReturnType<typeof createDb>;
type Env = Readonly<Record<string, string | undefined>>;

/** A failed customer is not retried more often than this, so a broken key cannot flood the log or the ledger. */
export const MOBILE_SETUP_RETRY_SECONDS = 3600;
/** Issuance attempts per tick. Signing is cheap; the bound keeps one tick short whatever the customer count. */
export const MOBILE_SETUP_PASS_LIMIT = 20;
const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

export type MobileSetupTrigger = 'provisioned' | 'missing' | 'renewal' | 'origin_changed' | 'invalid' | 'retry';
export type MobileSetupOutcome =
  | { outcome: 'issued' | 'reissued'; keyId: string; expiresAt: number }
  | { outcome: 'skipped'; reason: 'not_issuing' | 'current' }
  | { outcome: 'failed'; reason: string };

class IssuanceError extends Error {
  constructor(readonly code: 'organization_unavailable' | 'customer_unavailable') { super(`mobile-setup:${code}`); }
}

/**
 * The origin this installation signs for, or null when it does not issue at all: no signing key
 * configured, not embedded sign-in, or a state in which /login/mobile-connection answers unavailable.
 */
export function issuingOrigin(env: Env = process.env): string | null {
  if (!(env.AIHR_MOBILE_SETUP_SIGNING_KEY ?? '').trim()) return null;
  if (!internalSelected(env) || env.ALLOW_DEMO_SESSION === 'true') return null;
  try { return internalConfig(env).origin; } catch { return null; }
}

/** Why the stored setup is due for a new one, or null while it is usable and outside its renewal window. */
export function mobileSetupDue(stored: StoredWorkplaceSetup, origin: string, now: number): Exclude<MobileSetupTrigger, 'provisioned' | 'retry'> | null {
  if (!stored.setup) return 'missing';
  try {
    const verified = verifySignedSetup(stored.setup, INSTALLED_APP_TRUST, now);
    if (verified.profile.apiOrigin !== origin) return 'origin_changed';
    return verified.expiresSoon ? 'renewal' : null;
  } catch (error) {
    if (error instanceof WorkplaceSetupRefusal) return error.code === 'expired' ? 'renewal' : 'invalid';
    throw error;
  }
}

const failureCode = (error: unknown): string =>
  error instanceof WorkplaceSetupSignerError || error instanceof WorkplaceSetupRefusal || error instanceof IssuanceError ? error.code : 'unexpected';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function lockedStored(tx: Tx, tenantId: string): Promise<StoredWorkplaceSetup> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'mobile-setup:' + tenantId},0))`);
  const [row] = await tx.select({ value: tenantSetting.value, source: tenantSetting.source }).from(tenantSetting)
    .where(sql`${tenantSetting.tenantId} = ${tenantId}::uuid and ${tenantSetting.key} = ${MOBILE_SETUP_SETTING_KEY}`);
  return parseStoredSetup(row?.source === 'platform' ? row.value : null);
}

async function writeStored(tx: Tx, tenantId: string, value: StoredWorkplaceSetup) {
  await tx.insert(tenantSetting)
    .values({ tenantId, key: MOBILE_SETUP_SETTING_KEY, value, source: 'platform', updatedBy: null })
    .onConflictDoUpdate({ target: [tenantSetting.tenantId, tenantSetting.key], set: { value, source: 'platform', updatedBy: null } });
}

/** The previous setup stays in place; only the failure note changes. One event per distinct reason. */
async function recordFailure(owner: Owner, tenantId: string, reason: string, trigger: MobileSetupTrigger, now: number) {
  await owner.db.transaction(async tx => {
    const previous = await lockedStored(tx, tenantId);
    await writeStored(tx, tenantId, { ...previous, failure: { reason, at: iso(now) } });
    if (previous.failure?.reason !== reason) {
      await appendEvent(tx, {
        tenantId, aggregateType: 'tenant', aggregateId: tenantId, eventType: 'mobile.workplace-setup.issue-failed',
        actor: { type: 'system' }, payload: { reason, trigger },
      });
    }
  });
}

/**
 * Sign and store this customer's setup. Never throws: a failure is recorded (best effort) and returned.
 * The signed result is verified again exactly as a reader will verify it before it is stored.
 */
export async function issueMobileSetup(
  owner: Owner, tenantId: string, trigger: MobileSetupTrigger,
  options: { now?: number; env?: Env; key?: KeyObject } = {},
): Promise<MobileSetupOutcome> {
  const env = options.env ?? process.env;
  const origin = issuingOrigin(env);
  if (!origin) return { outcome: 'skipped', reason: 'not_issuing' };
  const now = Math.floor(options.now ?? Date.now() / 1000);
  try {
    const key = options.key ?? loadSigningKey(env.AIHR_MOBILE_SETUP_SIGNING_KEY, process.cwd());
    const anchor = approvedAnchor(key, INSTALLED_APP_TRUST);
    const hosting = setupHosting(env.AIHR_MOBILE_SETUP_HOSTING);
    const organization = await readRecord<Organization>(owner.client, `tenant:${tenantId}`);
    if (!organization?.code || organization.tenantId !== tenantId) throw new IssuanceError('organization_unavailable');
    const [customer] = await owner.db.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
    if (!customer) throw new IssuanceError('customer_unavailable');
    const profile = workplaceProfile({ origin, organization: organization.code, name: customer.name, hosting }, { now, anchor });
    const envelope = signCompanyProfile(profile, key, INSTALLED_APP_TRUST, now);
    const verified = verifyWorkplaceSetup(envelope, { trust: INSTALLED_APP_TRUST, origin, organization: organization.code, now });
    return await owner.db.transaction(async (tx): Promise<MobileSetupOutcome> => {
      const previous = await lockedStored(tx, tenantId);
      // An overlapping tick may have stored a usable setup since this attempt began.
      if (mobileSetupDue(previous, origin, now) === null) return { outcome: 'skipped', reason: 'current' };
      await writeStored(tx, tenantId, { version: 1, setup: envelope, method: 'issued', recordedAt: iso(now), failure: null });
      const reissued = previous.setup !== null;
      await appendEvent(tx, {
        tenantId, aggregateType: 'tenant', aggregateId: tenantId,
        eventType: reissued ? 'mobile.workplace-setup.reissued' : 'mobile.workplace-setup.issued',
        actor: { type: 'system' },
        payload: { keyId: verified.keyId, expiresAt: iso(verified.expiresAt), method: 'issued', trigger },
      });
      return { outcome: reissued ? 'reissued' : 'issued', keyId: verified.keyId, expiresAt: verified.expiresAt };
    });
  } catch (error) {
    const reason = failureCode(error);
    try { await recordFailure(owner, tenantId, reason, trigger, now); } catch { /* the reason is still returned and logged */ }
    return { outcome: 'failed', reason };
  }
}

/**
 * One bounded pass over active embedded-sign-in customers. The namespace index (`tenant:<id>`) is the
 * login owner (ADR-0140): a tenant without one cannot sign in to the app and has nothing to issue.
 * Ordered by tenant id so every customer is reached across ticks.
 */
export async function mobileSetupPass(
  owner: Owner, options: { now?: number; env?: Env; limit?: number } = {},
): Promise<{ issued: number; failed: number }> {
  const env = options.env ?? process.env;
  const origin = issuingOrigin(env);
  if (!origin) return { issued: 0, failed: 0 };
  const now = Math.floor(options.now ?? Date.now() / 1000), limit = options.limit ?? MOBILE_SETUP_PASS_LIMIT;
  const candidates = await owner.db.execute<{ tenant_id: string; value: unknown; source: string | null }>(sql`
    select t.id::text as tenant_id, s.value, s.source
      from tenant t
      left join tenant_setting s on s.tenant_id = t.id and s.key = ${MOBILE_SETUP_SETTING_KEY}
     where t.id <> ${SYSTEM_TENANT}::uuid and t.status in ('active','trial')
       and exists (select 1 from app_internal_auth_record r
                    where r.record_key = 'tenant:' || t.id::text and (r.expires_at is null or r.expires_at > now()))
     order by t.id`);
  let issued = 0, failed = 0, attempts = 0;
  for (const row of candidates) {
    if (attempts >= limit) break;
    const stored = parseStoredSetup(row.source === 'platform' ? row.value : null);
    if (stored.failure && now - Date.parse(stored.failure.at) / 1000 < MOBILE_SETUP_RETRY_SECONDS) continue;
    const due = mobileSetupDue(stored, origin, now);
    if (!due) continue;
    attempts += 1;
    const result = await issueMobileSetup(owner, row.tenant_id, stored.failure ? 'retry' : due, { now, env });
    if (result.outcome === 'issued' || result.outcome === 'reissued') issued += 1;
    else if (result.outcome === 'failed') {
      failed += 1;
      console.error(`· mobile setup for tenant ${row.tenant_id} failed: ${result.reason}`);
    }
  }
  return { issued, failed };
}
