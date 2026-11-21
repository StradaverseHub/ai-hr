import { cache } from 'react';
import { client, withPoolWork } from '../db/client';
import { internalSelected } from './internal-auth/config';
import { DEFAULT_LOGIN_PRESENTATION, validateLoginPresentation, type LoginPresentation } from './login-presentation';

/** Installation config chooses the public tenant; request headers and query strings never do. */
export async function loginPresentationTenantId(): Promise<string | null> {
  const configured = process.env.LOGIN_PRESENTATION_TENANT_ID?.trim();
  if (configured) return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(configured) ? configured : null;
  const organization = process.env.AUTH_DEFAULT_ORGANIZATION?.trim().toLowerCase();
  if (internalSelected() && organization) {
    const { readRecord } = await import('./internal-auth/record-store');
    const entry = await readRecord<{ tenantId: string }>((await import('./internal-auth/store')).admittedAuthSql, `org:${organization}`);
    return entry?.tenantId ?? null;
  }
  return null;
}

async function readPublicLoginPresentation(): Promise<LoginPresentation> {
  try {
    const tenantId = await loginPresentationTenantId();
    if (!tenantId) return DEFAULT_LOGIN_PRESENTATION;
    const rows = await withPoolWork('authentication', () => client.unsafe('select app.public_login_presentation($1::uuid) as presentation', [tenantId]), undefined, {idempotent:true});
    return rows[0]?.presentation ? validateLoginPresentation(rows[0].presentation) : DEFAULT_LOGIN_PRESENTATION;
  } catch {
    console.error('Public login artwork unavailable; using default presentation.');
    return DEFAULT_LOGIN_PRESENTATION;
  }
}

let inFlightPresentation: Promise<LoginPresentation> | undefined;

/** A successful save separates subsequent reads from a query already underway. */
export function forgetPublicLoginPresentation() {
  inFlightPresentation = undefined;
}

/** Concurrent renders share the installation's public artwork query until it settles. */
export const publicLoginPresentation = cache(() => {
  if (inFlightPresentation) return inFlightPresentation;
  const pending = readPublicLoginPresentation().finally(() => {
    if (inFlightPresentation === pending) forgetPublicLoginPresentation();
  });
  inFlightPresentation = pending;
  return pending;
});
