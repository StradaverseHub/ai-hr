/**
 * Mobile workplace setup — the stored value and the customer administrator's view (ADR-0161).
 *
 * OWNER: one `tenant_setting` row per customer, key `mobile.workplace_setup`, scope `platform`. The only
 * writer is the owner-role provisioning runner (scripts/mobile-setup-issuance.ts); 0313's
 * tenant_setting_write policy refuses `ai_hr_app` for platform keys, so no web path can plant a setup.
 * The row is a CACHE of a signed artifact derived from facts owned elsewhere — the server address
 * (AUTH_PUBLIC_ORIGIN) and the organization code (the internal-auth namespace index, ADR-0140) — so every
 * reader re-verifies it against those owners and the app's trust anchors before showing anything.
 *
 * Nothing in this file signs, loads a key or writes. It is safe on a web request path.
 */
import { and, eq } from 'drizzle-orm';
import { client, withTenant, type SessionContext } from '../db/client';
import { tenantSetting } from '../db/schema';
import { isAdmin } from '../lib/authz-model';
import { internalConfig, internalSelected } from '../lib/internal-auth/config';
import { readRecord } from '../lib/internal-auth/record-store';
import type { Organization } from '../lib/internal-auth/service';
import { INSTALLED_APP_TRUST } from '../lib/mobile-trust-anchors';
import { WorkplaceSetupRefusal, verifyWorkplaceSetup } from '../lib/mobile-workplace-setup-verify';
import { MOBILE_SETUP_SETTING_KEY, parseStoredSetup } from '../lib/mobile-workplace-setup-record';

export { MOBILE_SETUP_SETTING_KEY, parseStoredSetup };

export type AdminMobileSetupView =
  | { state: 'ready'; link: string; organization: string; name: string; hosting: 'cloud' | 'on-premise'; expiresAt: number; expiresSoon: boolean }
  | { state: 'unavailable' };

const UNAVAILABLE: AdminMobileSetupView = Object.freeze({ state: 'unavailable' });

/**
 * The customer administrator's Mobile app page. Shows a link ONLY when the stored setup re-verifies now:
 * signed by an anchor the installed app trusts, for this installation's sign-in origin, for this
 * tenant's own organization code, and not expired. Everything else is the plain "ask your provider"
 * state — the reason is the operator's to diagnose, not the customer's.
 *
 * The tenant is the session's, never an argument, so one customer's administrators cannot ask for
 * another's setup; RLS (`tenant_setting_read`) refuses it independently.
 */
export async function readMobileSetupForAdmin(ctx: SessionContext, now = Math.floor(Date.now() / 1000)): Promise<AdminMobileSetupView> {
  if (!isAdmin(ctx)) throw new Error('Only an administrator can view the mobile app setup.');
  // The server's own /login/mobile-connection answers unavailable in these states; a link would only
  // lead employees to a sign-in the server refuses.
  if (!internalSelected() || process.env.ALLOW_DEMO_SESSION === 'true') return UNAVAILABLE;
  let origin: string;
  try { origin = internalConfig().origin; } catch { return UNAVAILABLE; }
  const rows = await withTenant(ctx, tx => tx
    .select({ value: tenantSetting.value, source: tenantSetting.source })
    .from(tenantSetting)
    .where(and(eq(tenantSetting.tenantId, ctx.tenantId), eq(tenantSetting.key, MOBILE_SETUP_SETTING_KEY))));
  // Provenance is part of the check: only the platform writes this key.
  const row = rows[0];
  if (!row || row.source !== 'platform') return UNAVAILABLE;
  const stored = parseStoredSetup(row.value);
  if (!stored.setup) return UNAVAILABLE;
  const organization = await readRecord<Organization>(client, `tenant:${ctx.tenantId}`);
  if (!organization?.code || organization.tenantId !== ctx.tenantId) return UNAVAILABLE;
  try {
    const verified = verifyWorkplaceSetup(stored.setup, { trust: INSTALLED_APP_TRUST, origin, organization: organization.code, now });
    return {
      state: 'ready', link: verified.links.web, organization: organization.code, name: verified.profile.name,
      hosting: verified.profile.hosting, expiresAt: verified.expiresAt, expiresSoon: verified.expiresSoon,
    };
  } catch (error) {
    if (error instanceof WorkplaceSetupRefusal) return UNAVAILABLE;
    throw error;
  }
}
