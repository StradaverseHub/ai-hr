/** Public installation metadata. It never identifies or grants access to an HR tenant. */
export type MobileConnection = {
  connectionVersion: 1; apiVersion: 'v1'; authProvider: 'keycloak' | 'internal';
  apiOrigin: string; issuer: string; clientId: string; audience: string;
};
export type CompanyProfile = MobileConnection & {
  id: string; name: string; hosting: 'cloud' | 'on-premise'; notBefore: number; expiresAt: number;
};
export function connectionEndpoints(profile: Pick<MobileConnection, 'issuer'>) {
  const base = profile.issuer + '/protocol/openid-connect/';
  return { authorizationEndpoint: base + 'auth', tokenEndpoint: base + 'token', logoutEndpoint: base + 'logout' };
}
export function validCompanyProfile(input: unknown, now = Date.now() / 1000): CompanyProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid company setup file.');
  const p = input as Record<string, unknown>;
  const fields = ['connectionVersion','apiVersion','authProvider','apiOrigin','issuer','clientId','audience','id','name','hosting','notBefore','expiresAt'];
  if (Object.keys(p).length !== fields.length || Object.keys(p).some(k=>!fields.includes(k)) || fields.some(k => !Object.hasOwn(p,k)) ||
      p.connectionVersion !== 1 || p.apiVersion !== 'v1' || !['keycloak', 'internal'].includes(String(p.authProvider)) ||
      !['cloud','on-premise'].includes(String(p.hosting)) ||
      !['id','name','apiOrigin','issuer','clientId','audience'].every(k => typeof p[k] === 'string' && (p[k] as string).length > 0 && (p[k] as string).length <= 300) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(p.id as string) || /[\u0000-\u001f\u007f]/.test(p.name as string) ||
      !Number.isSafeInteger(p.notBefore) || !Number.isSafeInteger(p.expiresAt) ||
      (p.notBefore as number) > now || (p.expiresAt as number) <= now ||
      (p.expiresAt as number) - (p.notBefore as number) > 366 * 86400) throw new Error('Invalid, expired or unsupported company setup file.');
  const origin = new URL(p.apiOrigin as string), issuer = new URL(p.issuer as string);
  for (const u of [origin, issuer]) if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash) throw new Error('Company connections require trusted HTTPS.');
  if (origin.origin !== p.apiOrigin || origin.pathname !== '/' || issuer.href !== p.issuer ||
      (p.authProvider === 'keycloak' ? !/\/realms\/[a-zA-Z0-9_-]+$/.test(issuer.pathname) : p.issuer !== p.apiOrigin + '/auth' || p.clientId !== 'aihr-mobile' || p.audience !== 'aihr-api') || !/^[a-zA-Z0-9._:-]{1,150}$/.test(p.clientId as string) ||
      !/^[a-zA-Z0-9._:/-]{1,200}$/.test(p.audience as string)) throw new Error('Invalid company connection addresses.');
  return input as CompanyProfile;
}
export function sameConnection(a: MobileConnection, b: unknown): boolean {
  if (!b || typeof b !== 'object') return false;
  return (['connectionVersion','apiVersion','authProvider','apiOrigin','issuer','clientId','audience'] as const).every(k => a[k] === (b as MobileConnection)[k]);
}
