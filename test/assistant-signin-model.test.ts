import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {assistantSignInFingerprint,assistantDemoNonce} from '../lib/assistant-signin-model';
const identity={provider:'internal',issuer:'https://fictional.invalid/auth/internal',subject:'fictional-subject',session:'123e4567-e89b-42d3-a456-426614174000'};
describe('canonical conversation sign-in partition',()=>{
 it('binds verified provider, issuer, subject and distinct sign-in rather than user ID only',()=>{
  const original=assistantSignInFingerprint(identity);expect(original).toMatch(/^[a-f0-9]{64}$/);expect(assistantSignInFingerprint({...identity})).toBe(original);
  for(const patch of [{issuer:'https://other.invalid/auth/internal'},{subject:'other'},{session:'123e4567-e89b-42d3-a456-426614174001'}])expect(assistantSignInFingerprint({...identity,...patch})).not.toBe(original);
  expect(assistantSignInFingerprint({provider:'workos',subject:identity.subject,session:identity.session})).not.toBe(original);
 });
 it('rejects user-only, missing/unverified session authority and arbitrary additional identity fields',()=>{
  for(const input of [{userId:identity.session},{...identity,session:''},{...identity,verified:true},{...identity,provider:'unknown'}])expect(()=>assistantSignInFingerprint(input)).toThrow();
  expect(assistantDemoNonce.safeParse('user-id-only').success).toBe(false);
 });
 it('separates demo login nonces and never uses the nonce as authentication',()=>{
  const value={provider:'demo',subject:identity.session,session:'a'.repeat(43)};expect(assistantSignInFingerprint(value)).not.toBe(assistantSignInFingerprint({...value,session:'b'.repeat(43)}));
  const actions=readFileSync(new URL('../app/identity-actions.ts',import.meta.url),'utf8'),session=readFileSync(new URL('../lib/session.ts',import.meta.url),'utf8');expect(actions).toContain('randomBytes(32)');expect(actions.slice(actions.indexOf('export async function signOutDemo'))).toContain('cookieStore.delete(ASSISTANT_DEMO_NONCE_COOKIE)');expect(session).not.toContain('ASSISTANT_DEMO_NONCE_COOKIE');
 });
});
