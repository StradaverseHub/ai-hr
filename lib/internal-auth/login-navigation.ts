/** Public login hints never select a principal or establish authentication. */
export function loginOrganization(value: unknown, fallback = ''): string {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(code) ? code : fallback;
}

/** Always a local destination; no invitation, password, challenge or recovery code in the URL. */
export function activationLoginHref(organization: unknown): string {
  const code = loginOrganization(organization);
  return code ? `/login?organization=${encodeURIComponent(code)}` : '/login';
}
