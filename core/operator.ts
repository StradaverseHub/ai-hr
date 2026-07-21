/**
 * Operator console service (0295) — the web tier's ENTIRE surface on tenant provisioning.
 *
 * What this file can do: insert an INTENT row, read the queue, ask for a reissue, and reveal an
 * activation link exactly once through a SECURITY DEFINER function. What it cannot do — and what no
 * amount of editing here could make it do — is create a tenant. Migration 0001's tenant_isolation
 * policy forbids ai_hr_app from inserting or even selecting a tenant, and this feature deliberately
 * did not add an exception. The actual provisioning happens out-of-band in
 * scripts/provision-runner.ts under the owner role. See 0295's header for the full shape.
 *
 * Every function here is gated three ways, in this order:
 *   1. isOperator(ctx)      — fail fast with a clear message (the UX gate).
 *   2. !isDemoDeployment()  — the gated consultant demo runs with the identity switcher live, so a
 *                             tester could otherwise switch into an operator identity and create real
 *                             customers. Refused at the service, not just hidden in the page.
 *   3. RLS / column grants  — the authoritative gate. Policies on tenant_provision_request all call
 *                             app.is_operator(), and activation_url is withheld from the app role's
 *                             SELECT grant entirely. If 1 and 2 were deleted tomorrow, a non-operator
 *                             would still read nothing and write nothing.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { tenantProvisionRequest } from '../db/schema';
import { isOperator } from '../lib/authz';
import { isDemoDeployment } from '../lib/demo-mode';
import { PROVISION_STEPS, type ProvisionStep } from '../db/provision';

export { PROVISION_STEPS, type ProvisionStep };

/** The request lifecycle. Plain strings, mirroring the text column (0295) — never a pgEnum. */
export const PROVISION_STATUSES = ['pending', 'running', 'failed', 'done'] as const;
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number];

export type ProvisionRequestRow = {
  id: string;
  customerName: string;
  adminEmail: string;
  status: string;
  currentStep: string | null;
  error: string | null;
  tenantId: string | null;
  claimedAt: Date | null;
  reissueRequestedAt: Date | null;
  requestedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Thrown when a caller is not an operator, or is one on the demo deployment. */
export class NotOperatorError extends Error {
  constructor(message = 'Only an operator can manage customer provisioning.') {
    super(message);
    this.name = 'NotOperatorError';
  }
}

function assertOperator(ctx: SessionContext): void {
  if (isDemoDeployment()) {
    throw new NotOperatorError('The operator console is not available on the demo deployment.');
  }
  if (!isOperator(ctx)) throw new NotOperatorError();
}

/**
 * The queue, newest first.
 *
 * THE COLUMN LIST IS NOT OPTIONAL. 0295 grants ai_hr_app a column-limited SELECT that omits
 * activation_url, so an unqualified `.select()` — which drizzle expands to every column — fails at
 * runtime with a permission error. Naming the columns is what keeps the withheld one out of the query.
 * Do not "simplify" this into a bare select().
 */
export async function listProvisionRequests(ctx: SessionContext): Promise<ProvisionRequestRow[]> {
  assertOperator(ctx);
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: tenantProvisionRequest.id,
        customerName: tenantProvisionRequest.customerName,
        adminEmail: tenantProvisionRequest.adminEmail,
        status: tenantProvisionRequest.status,
        currentStep: tenantProvisionRequest.currentStep,
        error: tenantProvisionRequest.error,
        tenantId: tenantProvisionRequest.tenantId,
        claimedAt: tenantProvisionRequest.claimedAt,
        reissueRequestedAt: tenantProvisionRequest.reissueRequestedAt,
        requestedBy: tenantProvisionRequest.requestedBy,
        createdAt: tenantProvisionRequest.createdAt,
        updatedAt: tenantProvisionRequest.updatedAt,
      })
      .from(tenantProvisionRequest)
      .orderBy(desc(tenantProvisionRequest.createdAt)),
  );
}

export type CreateProvisionRequestInput = { customerName: string; adminEmail: string };

/**
 * Queue a new customer. Validation only — no uniqueness check of any kind:
 *
 *   • Duplicate CUSTOMER NAMES are allowed by design. Real company names collide, the operator is one
 *     trusted human, and there is no unique index to violate (0295 explains why not).
 *   • Duplicate ADMIN EMAILS are caught by the RUNNER, not here, and that is deliberate. The check is
 *     "does this address already have an app_user or a live invitation in ANY tenant", which the web
 *     tier physically cannot ask — tenant RLS confines it to its own tenant. Only the owner connection
 *     can see across tenants, so the pre-check lives where the visibility is.
 */
export async function createProvisionRequest(
  ctx: SessionContext,
  input: CreateProvisionRequestInput,
): Promise<{ id: string }> {
  assertOperator(ctx);
  const customerName = input.customerName.trim();
  const adminEmail = input.adminEmail.trim().toLowerCase();
  if (!customerName) throw new Error('A customer name is required.');
  if (!adminEmail || !adminEmail.includes('@')) throw new Error('A valid admin email is required.');

  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(tenantProvisionRequest)
      .values({ customerName, adminEmail, requestedBy: ctx.userId ?? null })
      .returning({ id: tenantProvisionRequest.id });
    return { id: row.id };
  });
}

/**
 * Reveal the one-time activation link — the ONLY way to read it, for anyone.
 *
 * Runs through withTenant rather than the raw client because app.claim_activation_url gates itself on
 * app.is_operator(), which reads the app.grants GUC that withTenant sets. On the raw client there are
 * no grants and the function refuses.
 *
 * Returns null when the link was ALREADY revealed (or the id is unknown) — that is a normal outcome the
 * UI renders as "already revealed, use Reissue", not an error. The nulling happens inside the same
 * UPDATE that returns the value, so reveal-once is a property of the statement rather than of this
 * caller; two concurrent calls cannot both win.
 *
 * NEVER call this on render. The console polls itself every few seconds, so a render-time claim would
 * burn the link before a human ever saw it. It is wired to an explicit button click only.
 */
export async function claimActivationUrl(ctx: SessionContext, requestId: string): Promise<string | null> {
  assertOperator(ctx);
  return withTenant(ctx, async (tx) => {
    const rows = (await tx.execute(
      sql`select app.claim_activation_url(${requestId}::uuid) as url`,
    )) as unknown as { url: string | null }[];
    return rows[0]?.url ?? null;
  });
}

/**
 * Ask for a fresh activation link (the answer to a lost link, or one whose 7-day TTL expired — see
 * INVITE_TTL_DAYS; app_invitation.expires_at is NOT NULL, so every link does eventually die).
 *
 * This only raises a FLAG. The runner's reissue pass revokes the old invitations, mints a new token and
 * stores the new URL — because minting requires writing app_invitation across a tenant boundary and
 * writing activation_url, neither of which the web tier can do. The app's UPDATE grant on this table
 * covers exactly one column, reissue_requested_at, so this is the only update it could make.
 */
export async function requestReissue(ctx: SessionContext, requestId: string): Promise<void> {
  assertOperator(ctx);
  await withTenant(ctx, (tx) =>
    tx
      .update(tenantProvisionRequest)
      .set({ reissueRequestedAt: new Date() })
      .where(eq(tenantProvisionRequest.id, requestId)),
  );
}
