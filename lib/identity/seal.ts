import { EncryptJWT, jwtDecrypt } from 'jose';
import { keycloakConfig } from './config';

/** Authenticated encryption, with issuer and purpose preventing cross-context token substitution. */
export async function seal(value: Record<string, unknown>, purpose: string, expiresAt: number): Promise<string> {
  const config = keycloakConfig();
  return new EncryptJWT(value).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(config.issuer).setAudience(purpose).setIssuedAt().setExpirationTime(expiresAt)
    .encrypt(Buffer.from(config.sessionKey, 'hex'));
}
export async function unseal(value: string, purpose: string) {
  if (value.length > 20000) throw new Error('Invalid session size.');
  const config = keycloakConfig();
  return (await jwtDecrypt(value, Buffer.from(config.sessionKey, 'hex'), {
    issuer: config.issuer, audience: purpose, keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'],
    requiredClaims: ['exp', 'iat'],
  })).payload;
}
