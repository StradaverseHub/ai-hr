/**
 * The operator console's view of, and intents for, a customer's mobile workplace setup (ADR-0161).
 *
 * The web tier never signs and never loads the key. It reads status through app.operator_mobile_setup and
 * records an intent through app.operator_request_mobile_setup; both re-check the operator in the
 * database. The owner-role provisioning runner executes the intent. An uploaded setup is verified here
 * first only so the operator gets an immediate answer — the runner verifies it again before storing it.
 */
import { sql } from 'drizzle-orm';
import { client, withTenant, type SessionContext } from '../db/client';
import { isOperator } from '../lib/authz-model';
import { isDemoDeployment } from '../lib/demo-mode';
import { internalConfig, internalSelected } from '../lib/internal-auth/config';
import { readRecord } from '../lib/internal-auth/record-store';
import type { Organization } from '../lib/internal-auth/service';
import { INSTALLED_APP_TRUST } from '../lib/mobile-trust-anchors';
import { mobileSetupSigningConfigured, parseStoredSetup, type StoredWorkplaceSetup } from '../lib/mobile-workplace-setup-record';
import {
  WorkplaceSetupRefusal, assertInstallationBinding, verifySignedSetup, type SetupRefusal, type VerifiedSetup,
} from '../lib/mobile-workplace-setup-verify';

const MAX_SETUP_FILE_BYTES = 16_384;

export type OperatorMobileSetupRequest = {
  id: string; action: 'issue' | 'import'; status: 'pending' | 'running' | 'done' | 'failed';
  error: string | null; createdAt: string; decidedAt: string | null;
};
export type OperatorMobileSetupStatus = {
  /** Whether this installation is configured to sign (presence of the key path variable only). */
  signs: boolean;
  /** `none` = nothing stored; `invalid` = stored but would not be shown to the customer (see `reason`). */
  state: 'issued' | 'imported' | 'none' | 'invalid';
  reason: SetupRefusal | 'origin_unavailable' | 'organization_unavailable' | null;
  keyId: string | null;
  expiresAt: number | null;
  expiresSoon: boolean;
  origin: string | null;
  organization: string | null;
  recordedAt: string | null;
  failure: StoredWorkplaceSetup['failure'];
  /** Only for a setup that re-verified for this server and customer — the link the customer sees. */
  link: string | null;
  requests: OperatorMobileSetupRequest[];
  pending: boolean;
};

/** Operator-facing refusal wording. The codes come from the database or this file, never from input. */
const REFUSALS: Record<string, string> = {
  OPERATOR_CUSTOMER_MISSING: 'This customer could not be found.',
  OPERATOR_SETUP_PENDING: 'A mobile setup request is already in progress for this customer. Wait for its result.',
  OPERATOR_SETUP_ACTION_INVALID: 'Choose whether to issue or import a mobile setup.',
  OPERATOR_SETUP_FILE_INVALID: 'Choose a signed workplace setup file (company.aihr.json) of at most 16 KB.',
  NOT_SIGNING: 'This server does not hold the mobile setup signing key. Import a setup signed by Stradaverse instead.',
  NOT_INTERNAL: 'Mobile workplace setups need embedded sign-in on this server.',
  NO_ORGANIZATION: 'This customer has no sign-in organization code on this server.',
  malformed: 'The file is not a signed workplace setup.',
  untrusted_key: 'The setup is not signed by a key the installed app trusts.',
  bad_signature: 'The setup signature is invalid; the file was changed after signing.',
  invalid_profile: 'The setup contents are invalid or unsupported.',
  not_workplace: 'The setup has no organization code for embedded sign-in.',
  expired: 'The setup has expired. Ask for a newly signed setup.',
  not_yet_valid: 'The setup is not valid yet. Check this server clock.',
  origin_mismatch: "The setup is for another server address. It must name this server's sign-in address.",
  organization_mismatch: "The setup is for another organization. It must name this customer's organization code.",
};

function assertOperator(ctx: SessionContext) {
  if (!isOperator(ctx) || isDemoDeployment() || !ctx.userId) throw new Error('Only an operator can manage customers.');
}
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Select a valid customer.');
  return value.toLowerCase();
};
async function readable<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    let cause: unknown = error;
    while (cause instanceof Error) {
      if (REFUSALS[cause.message] && cause.message.startsWith('OPERATOR_')) throw new Error(REFUSALS[cause.message]);
      cause = (cause as Error & { cause?: unknown }).cause;
    }
    throw error;
  }
}
const refusal = (code: string) => new Error(REFUSALS[code] ?? REFUSALS.malformed);

function installationOrigin(): string | null {
  if (!internalSelected()) return null;
  try { return internalConfig().origin; } catch { return null; }
}
async function organizationOf(tenantId: string): Promise<string | null> {
  if (!internalSelected()) return null;
  const organization = await readRecord<Organization>(client, `tenant:${tenantId}`);
  return organization?.code && organization.tenantId === tenantId ? organization.code : null;
}

type StatusRow = { setting: unknown; source: string | null; updated_at: string | null; requests: OperatorMobileSetupRequest[] | null };

/** Status of one customer's setup, judged exactly as the customer's Mobile app page would judge it. */
export async function readOperatorMobileSetup(ctx: SessionContext, tenantId: string, now = Math.floor(Date.now() / 1000)): Promise<OperatorMobileSetupStatus | null> {
  assertOperator(ctx);
  const id = uuid(tenantId);
  const rows = await withTenant(ctx, tx => tx.execute<StatusRow>(sql`select * from app.operator_mobile_setup(${id}::uuid)`));
  const row = rows[0];
  if (!row) return null;
  const requests = (row.requests ?? []).slice();
  const stored = parseStoredSetup(row.source === 'platform' ? row.setting : null);
  const status: OperatorMobileSetupStatus = {
    signs: mobileSetupSigningConfigured() && internalSelected(), state: 'none', reason: null, keyId: null, expiresAt: null,
    expiresSoon: false, origin: null, organization: null, recordedAt: stored.recordedAt, failure: stored.failure, link: null,
    requests, pending: requests.some(r => r.status === 'pending' || r.status === 'running'),
  };
  if (!stored.setup) return status;
  let verified: VerifiedSetup;
  try { verified = verifySignedSetup(stored.setup, INSTALLED_APP_TRUST, now); } catch (error) {
    if (!(error instanceof WorkplaceSetupRefusal)) throw error;
    return { ...status, state: 'invalid', reason: error.code, keyId: stored.setup.keyId };
  }
  const described = {
    ...status, keyId: verified.keyId, expiresAt: verified.expiresAt, expiresSoon: verified.expiresSoon,
    origin: verified.profile.apiOrigin, organization: verified.profile.organization,
  };
  const origin = installationOrigin(), organization = await organizationOf(id);
  if (!origin) return { ...described, state: 'invalid', reason: 'origin_unavailable' };
  if (!organization) return { ...described, state: 'invalid', reason: 'organization_unavailable' };
  try { assertInstallationBinding(verified, { origin, organization }); } catch (error) {
    if (!(error instanceof WorkplaceSetupRefusal)) throw error;
    return { ...described, state: 'invalid', reason: error.code };
  }
  return { ...described, state: stored.method === 'imported' ? 'imported' : 'issued', link: verified.links.web };
}

/** Ask the runner to sign (or re-sign) this customer's setup with this installation's key. */
export async function requestOperatorMobileSetupIssue(ctx: SessionContext, tenantId: string): Promise<void> {
  assertOperator(ctx);
  const id = uuid(tenantId);
  if (!internalSelected()) throw refusal('NOT_INTERNAL');
  if (!mobileSetupSigningConfigured()) throw refusal('NOT_SIGNING');
  if (!await organizationOf(id)) throw refusal('NO_ORGANIZATION');
  await readable(() => withTenant(ctx, tx => tx.execute(sql`select app.operator_request_mobile_setup(${id}::uuid,'issue',NULL)`)));
}

/**
 * Queue the import of an uploaded signed setup. Verified here against the app's anchors, this server's
 * sign-in origin and this customer's organization code so a wrong file is refused on the spot; the
 * runner repeats the verification before it stores anything.
 */
export async function requestOperatorMobileSetupImport(ctx: SessionContext, tenantId: string, file: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  assertOperator(ctx);
  const id = uuid(tenantId);
  if (Buffer.byteLength(file, 'utf8') > MAX_SETUP_FILE_BYTES) throw refusal('OPERATOR_SETUP_FILE_INVALID');
  const origin = installationOrigin();
  if (!origin) throw refusal('NOT_INTERNAL');
  const organization = await organizationOf(id);
  if (!organization) throw refusal('NO_ORGANIZATION');
  let verified: VerifiedSetup;
  try {
    verified = verifySignedSetup(file, INSTALLED_APP_TRUST, now);
    assertInstallationBinding(verified, { origin, organization });
  } catch (error) {
    if (error instanceof WorkplaceSetupRefusal) throw refusal(error.code);
    throw error;
  }
  await readable(() => withTenant(ctx, tx => tx.execute(
    sql`select app.operator_request_mobile_setup(${id}::uuid,'import',${JSON.stringify(verified.envelope)}::jsonb)`)));
}
