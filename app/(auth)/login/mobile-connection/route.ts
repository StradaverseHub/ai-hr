import { internalSelected, internalConfig } from '@/lib/internal-auth/config';
import { keycloakConfig, keycloakSelected } from '@/lib/identity/config';
import type { MobileConnection } from '@/lib/mobile-connection';
import { MOBILE_API_VERSION } from '@/lib/mobile-api/contract';

/** Public login metadata only: no user/tenant lookup, secrets, cookies or bearer credentials. */
export async function GET() {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  try {
    if (internalSelected()) {
      if (process.env.ALLOW_DEMO_SESSION === 'true') throw new Error('Inactive login');
      const c = internalConfig();
      const body: MobileConnection = { connectionVersion: 1, apiVersion: MOBILE_API_VERSION, authProvider: 'internal', apiOrigin: c.origin,
        issuer: c.origin + '/auth', clientId: 'aihr-mobile', audience: 'aihr-api' };
      return Response.json(body, { headers });
    }
    if (!keycloakSelected() || process.env.ALLOW_DEMO_SESSION === 'true') throw new Error('Inactive login');
    const c = keycloakConfig();
    const body: MobileConnection = { connectionVersion: 1, apiVersion: MOBILE_API_VERSION, authProvider: 'keycloak', apiOrigin: c.origin, issuer: c.issuer, clientId: c.mobileClientId, audience: c.audience };
    return Response.json(body, { headers });
  } catch { return Response.json({ error: 'login_unavailable' }, { status: 503, headers }); }
}
