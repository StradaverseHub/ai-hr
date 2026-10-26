import { cache } from 'react';
import { client } from '../db/client';
import { internalSelected } from './internal-auth/config';
import { DEFAULT_LOGIN_PRESENTATION, validateLoginPresentation } from './login-presentation';

/** Installation config chooses the public tenant; request headers and query strings never do. */
export async function loginPresentationTenantId(): Promise<string | null> {
  const configured = process.env.LOGIN_PRESENTATION_TENANT_ID?.trim();
  if (configured) return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(configured) ? configured : null;
  const organization = process.env.AUTH_DEFAULT_ORGANIZATION?.trim().toLowerCase();
  if (internalSelected() && organization) {
    const { readRecord } = await import('./internal-auth/record-store');
    const entry = await readRecord<{ tenantId: string }>(client, `org:${organization}`);
    return entry?.tenantId ?? null;
  }
  return null;
}

/** Artwork failures must never make authentication unavailable. No private record reaches the client. */
export const publicLoginPresentation = cache(async () => {
  try {
    const tenantId = await loginPresentationTenantId();
    if (!tenantId) return DEFAULT_LOGIN_PRESENTATION;
    const rows = await client.unsafe('select app.public_login_presentation($1::uuid) as presentation', [tenantId]);
    return rows[0]?.presentation ? validateLoginPresentation(rows[0].presentation) : DEFAULT_LOGIN_PRESENTATION;
  } catch {
    console.error('Public login artwork unavailable; using default presentation.');
    return DEFAULT_LOGIN_PRESENTATION;
  }
});
